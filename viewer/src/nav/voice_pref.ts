/**
 * Namma Space voice guide: the on/off choice (saved on this device, shared by the viewer and the
 * AR page) and the one-time speech unlock. Tiny on purpose: the main viewer imports it up front,
 * while the guide itself loads only when a route starts.
 */

const VOICE_KEY = 'namma.guide.voice';

/** Voice is on unless it was muted on this device (user's choice: on when a route starts) */
export function loadVoiceOn(): boolean {
  try {
    return localStorage.getItem(VOICE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function saveVoiceOn(on: boolean): void {
  try {
    localStorage.setItem(VOICE_KEY, on ? 'on' : 'off');
  } catch {
    // Blocked storage: the choice lasts until the page closes
  }
}

let primed = false;

/**
 * Browsers (Safari above all) only allow speech that starts inside a tap or key press. Speaking an
 * empty line on the first one unlocks it for the later lines, which come from the frame loop.
 */
export function primeSpeechOnFirstGesture(): void {
  if (primed || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  const prime = () => {
    if (primed) return;
    primed = true;
    window.removeEventListener('pointerdown', prime, true);
    window.removeEventListener('keydown', prime, true);
    try {
      const u = new SpeechSynthesisUtterance('');
      u.volume = 0;
      window.speechSynthesis.speak(u);
    } catch {
      // No speech here: the guide still shows its text
    }
  };
  window.addEventListener('pointerdown', prime, true);
  window.addEventListener('keydown', prime, true);
}
