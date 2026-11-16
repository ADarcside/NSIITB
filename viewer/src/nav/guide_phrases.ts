/**
 * Namma Space voice guide: every line the guide shows and speaks, in English and Hindi.
 * One table per language with the same keys, so the TypeScript compiler catches a missing line
 * (the same pattern as ar/phrases.ts). The browser viewer uses English; the AR page follows its
 * English / Hindi switch.
 */

import type { Turn } from './route_follower.js';

export type GuideLang = 'en' | 'hi';

const en = {
  // Turns, as an instruction on their own ("Turn left.") and inside a sentence ("In 5 metres, turn left.")
  turn_left: 'Turn left',
  turn_right: 'Turn right',
  'turn_slight-left': 'Keep left',
  'turn_slight-right': 'Keep right',
  turn_around: 'Turn around',
  turn_straight: 'Go straight',
  in_left: 'turn left',
  in_right: 'turn right',
  'in_slight-left': 'keep left',
  'in_slight-right': 'keep right',
  in_around: 'turn around',
  in_straight: 'go straight',

  // Spoken lines (also shown as text)
  start: 'Going to {place}. {d} metres, {time}.',
  startNear: 'Going to {place}. It is just here.',
  turnComing: 'In {d} metres, {turn}.',
  turnNow: '{turn}.',
  turnAround: 'Turn around.',
  newRoute: 'Finding a new way.',
  distanceLeft: '{d} metres to go.',
  arrived: 'You have arrived at {place}.',
  trackingLost: 'Hold on, finding the room again.',
  noVoice: 'This phone has no English voice, so the guide shows text only.',
  timeSecSpoken: 'about {n} seconds',
  timeMinSpoken: 'about {n} minutes',
  timeOneMinSpoken: 'about 1 minute',

  // Short text for the live line
  lineTurnNow: '{turn} now',
  lineTurnIn: 'In {d} m, {turn}',
  lineStraight: 'Straight on',
  lineTurnAround: 'Turn around',
  lineNoRoute: 'No walkable route from here. Step back onto open floor.',
  lineLeft: '{d} m to go · {time}',
  timeSec: 'about {n} s',
  timeMin: 'about {n} min',

  // Speaker button
  voiceOn: 'Voice guide on. Tap to mute.',
  voiceOff: 'Voice guide muted. Tap to turn it on.',
  voiceBtnOn: '🔊 Voice on',
  voiceBtnOff: '🔇 Voice off',
};

export type GuideKey = keyof typeof en;

const hi: Record<GuideKey, string> = {
  turn_left: 'बाएँ मुड़ें',
  turn_right: 'दाएँ मुड़ें',
  'turn_slight-left': 'बाईं ओर रहें',
  'turn_slight-right': 'दाईं ओर रहें',
  turn_around: 'पीछे मुड़ें',
  turn_straight: 'सीधे चलें',
  in_left: 'बाएँ मुड़ें',
  in_right: 'दाएँ मुड़ें',
  'in_slight-left': 'बाईं ओर रहें',
  'in_slight-right': 'दाईं ओर रहें',
  in_around: 'पीछे मुड़ें',
  in_straight: 'सीधे चलें',

  start: '{place} की ओर चलें। {d} मीटर, {time}।',
  startNear: '{place} की ओर चलें। यह बस यहीं है।',
  turnComing: '{d} मीटर बाद {turn}।',
  turnNow: '{turn}।',
  turnAround: 'पीछे मुड़ें।',
  newRoute: 'नया रास्ता ढूँढ रहे हैं।',
  distanceLeft: '{d} मीटर बाकी।',
  arrived: 'आप {place} पहुँच गए।',
  trackingLost: 'रुकिए, कमरे को फिर से पहचान रहे हैं।',
  noVoice: 'इस फ़ोन में हिंदी आवाज़ नहीं है, इसलिए गाइड सिर्फ़ लिखकर बताएगा।',
  timeSecSpoken: 'लगभग {n} सेकंड',
  timeMinSpoken: 'लगभग {n} मिनट',
  timeOneMinSpoken: 'लगभग 1 मिनट',

  lineTurnNow: 'अभी {turn}',
  lineTurnIn: '{d} मी बाद {turn}',
  lineStraight: 'सीधे चलें',
  lineTurnAround: 'पीछे मुड़ें',
  lineNoRoute: 'यहाँ से चलने का रास्ता नहीं मिला। खुली ज़मीन पर वापस आएँ।',
  lineLeft: '{d} मी बाकी · {time}',
  timeSec: 'लगभग {n} सेकंड',
  timeMin: 'लगभग {n} मिनट',

  voiceOn: 'आवाज़ वाला गाइड चालू है। बंद करने के लिए टैप करें।',
  voiceOff: 'आवाज़ वाला गाइड बंद है। चालू करने के लिए टैप करें।',
  voiceBtnOn: '🔊 आवाज़ चालू',
  voiceBtnOff: '🔇 आवाज़ बंद',
};

export const GUIDE_PHRASES: Readonly<Record<GuideLang, Readonly<Record<GuideKey, string>>>> = { en, hi };

/** The line `key` in `lang`, with {name} placeholders filled from `vars`. */
export function guidePhrase(lang: GuideLang, key: GuideKey, vars: Record<string, string | number> = {}): string {
  return GUIDE_PHRASES[lang][key].replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

/** "Turn left" (alone, capitalised) or "turn left" (inside a sentence) */
export function turnWords(lang: GuideLang, turn: Turn, inSentence = false): string {
  return guidePhrase(lang, `${inSentence ? 'in' : 'turn'}_${turn}` as GuideKey);
}

/** Walking speed used for time estimates (m/s); the same as the route card and the AR page */
export const GUIDE_WALK_SPEED_MPS = 1.2;

/** "about 20 seconds" (spoken) or "about 20 s" (text) for a walking distance */
export function walkTimePhrase(lang: GuideLang, metres: number, spoken: boolean): string {
  const sec = metres / GUIDE_WALK_SPEED_MPS;
  if (sec < 55) return guidePhrase(lang, spoken ? 'timeSecSpoken' : 'timeSec', { n: Math.max(5, Math.round(sec / 5) * 5) });
  const min = Math.max(1, Math.round(sec / 60));
  if (spoken && min === 1) return guidePhrase(lang, 'timeOneMinSpoken');
  return guidePhrase(lang, spoken ? 'timeMinSpoken' : 'timeMin', { n: min });
}

/**
 * A distance as it is spoken: nearest metre under 10 m, nearest 5 m from there (the plan's drift
 * rule, so 1 m of AR drift does not make the guide sound precise when it is not).
 */
export function spokenMetres(m: number): number {
  return m < 10 ? Math.max(1, Math.round(m)) : Math.round(m / 5) * 5;
}
