/**
 * Namma Space voice guide: a thin wrapper around the browser's built-in speech (Web Speech API).
 * Free, no server or key, and on most phones it works offline. Handles mute, cutting off a less
 * urgent line, and picking a voice for the language; with no voice for a language it stays silent
 * and says so once (the text line still shows everything).
 */

import { loadVoiceOn, saveVoiceOn } from './voice_pref.js';

/** BCP 47 tags to try, best first */
const LANG_TAGS: Record<string, string[]> = { en: ['en-IN', 'en-GB', 'en-US', 'en'], hi: ['hi-IN', 'hi'] };

export class Speaker {
  private _on = loadVoiceOn();
  private current: { priority: number; until: number } | null = null;
  private readonly speakingListeners = new Set<(speaking: boolean) => void>();
  private speakingTimer: number | null = null;
  private readonly synth: SpeechSynthesis | null =
    typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;

  /** False when this browser has no speech at all */
  get available(): boolean {
    return this.synth !== null;
  }

  get on(): boolean {
    return this._on;
  }

  setOn(on: boolean): void {
    this._on = on;
    saveVoiceOn(on);
    if (!on) this.cancel();
  }

  /**
   * Whether a voice for `lang` is installed. 'unknown' while the browser has not listed its voices
   * yet (Chrome fills the list a moment after load).
   */
  hasVoice(lang: string): boolean | 'unknown' {
    if (!this.synth) return false;
    const voices = this.synth.getVoices();
    if (voices.length === 0) return 'unknown';
    return this.pickVoice(lang) !== null;
  }

  /** Calls `cb` when speech starts and stops (the viewer lowers the footsteps meanwhile) */
  onSpeaking(cb: (speaking: boolean) => void): () => void {
    this.speakingListeners.add(cb);
    return () => this.speakingListeners.delete(cb);
  }

  /**
   * Speaks `text` unless muted. A line at least as urgent (lower or equal priority number) cuts
   * off the one playing; a less urgent one is dropped. Returns false when nothing was spoken.
   */
  say(text: string, lang: string, priority: number): boolean {
    const synth = this.synth;
    if (!synth || !this._on || !text) return false;
    const now = Date.now();
    if (this.current && now < this.current.until && priority > this.current.priority && synth.speaking) return false;
    if (this.hasVoice(lang) === false) return false;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const voice = this.pickVoice(lang);
    if (voice) u.voice = voice;
    u.lang = voice?.lang ?? LANG_TAGS[lang]?.[0] ?? lang;
    u.rate = 1;
    // Some browsers never fire onend (Chrome on Android with long lines), so speaking also times out
    const estimateMs = 1500 + text.length * 90;
    const token = { priority, until: now + estimateMs };
    this.current = token;
    const done = () => {
      if (this.current === token) {
        this.current = null;
        this.setSpeaking(false);
      }
    };
    u.onend = done;
    u.onerror = done;
    synth.speak(u);
    this.setSpeaking(true);
    if (this.speakingTimer !== null) window.clearTimeout(this.speakingTimer);
    this.speakingTimer = window.setTimeout(done, estimateMs);
    return true;
  }

  cancel(): void {
    this.current = null;
    this.synth?.cancel();
    this.setSpeaking(false);
  }

  private speaking = false;

  private setSpeaking(on: boolean): void {
    if (on === this.speaking) return;
    this.speaking = on;
    for (const cb of this.speakingListeners) cb(on);
  }

  private pickVoice(lang: string): SpeechSynthesisVoice | null {
    if (!this.synth) return null;
    const voices = this.synth.getVoices();
    const tags = LANG_TAGS[lang] ?? [lang];
    const norm = (s: string) => s.replace('_', '-').toLowerCase();
    for (const tag of tags) {
      const t = norm(tag);
      const exact = voices.filter(v => norm(v.lang) === t);
      const hit = exact.find(v => v.localService) ?? exact[0];
      if (hit) return hit;
    }
    const prefix = norm(tags[tags.length - 1]).split('-')[0];
    return voices.find(v => norm(v.lang).startsWith(prefix + '-') || norm(v.lang) === prefix) ?? null;
  }
}
