/**
 * Namma Space: Walk-mode footstep sound
 * A soft synthesized thump (short low-passed noise burst) per footfall, no audio files.
 * The AudioContext is created on the first user gesture (browser autoplay rule).
 * M toggles mute and the HUD slider sets the volume; both are remembered in localStorage when available.
 */

const MUTE_KEY = 'namma-footsteps-muted';
const VOLUME_KEY = 'namma-footsteps-volume';
export const DEFAULT_VOLUME = 0.6;

export class Footsteps {
  private _ctx: AudioContext | null = null;
  private _noise: AudioBuffer | null = null;
  private _muted: boolean;
  private _volume = DEFAULT_VOLUME;

  constructor() {
    let muted = false;
    try {
      muted = localStorage.getItem(MUTE_KEY) === '1';
      const v = Number.parseFloat(localStorage.getItem(VOLUME_KEY) ?? '');
      if (Number.isFinite(v)) this._volume = Math.max(0, Math.min(1, v));
    } catch {
      /* storage blocked: default to sound on */
    }
    this._muted = muted;

    const unlock = () => {
      this._ensureContext();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  get muted(): boolean {
    return this._muted;
  }

  /** 0 (silent) to 1 */
  get volume(): number {
    return this._volume;
  }

  setVolume(v: number): void {
    this._volume = Math.max(0, Math.min(1, v));
    try {
      localStorage.setItem(VOLUME_KEY, String(this._volume));
    } catch {
      /* not persisted */
    }
  }

  toggleMute(): boolean {
    this._muted = !this._muted;
    try {
      localStorage.setItem(MUTE_KEY, this._muted ? '1' : '0');
    } catch {
      /* not persisted */
    }
    return this._muted;
  }

  /** One footstep; landing = a heavier thump after a jump. */
  play(sprint = false, landing = false): void {
    if (this._muted || this._volume <= 0) return;
    const ctx = this._ensureContext();
    if (!ctx || !this._noise || ctx.state !== 'running') return;

    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this._noise;
    src.playbackRate.value = 0.85 + Math.random() * 0.3;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = (landing ? 300 : sprint ? 520 : 380) * (0.9 + Math.random() * 0.2);

    const gain = ctx.createGain();
    // Base levels at full volume (raised 50% on 30 Oct: too quiet on laptop speakers)
    const peak = Math.max(0.0002, (landing ? 0.6 : sprint ? 0.5 : 0.375) * this._volume);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + (landing ? 0.09 : 0.06));

    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start(t);
    src.stop(t + 0.1);
  }

  private _ensureContext(): AudioContext | null {
    if (!this._ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this._ctx = new Ctor();
      const len = Math.floor(this._ctx.sampleRate * 0.08);
      this._noise = this._ctx.createBuffer(1, len, this._ctx.sampleRate);
      const data = this._noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this._ctx.state === 'suspended') void this._ctx.resume();
    return this._ctx;
  }
}
