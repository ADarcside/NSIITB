/**
 * Namma Space AR: every line of text the AR page shows (and later speaks), in English and Hindi.
 * One table per language with the same keys, so the TypeScript compiler catches a missing line.
 * English is the default; the choice is remembered on this phone.
 */

export type Lang = 'en' | 'hi';

const en = {
  checking: 'Checking this phone…',
  unsupportedTitle: 'AR needs Chrome on an Android phone',
  unsupportedInsecure: 'This page is not on a secure address (https or localhost), so the browser blocks AR.',
  unsupportedNoWebxr: 'This browser has no web AR (WebXR). Open the link in Chrome on an Android phone.',
  unsupportedNoAr:
    'This phone or browser cannot start AR. Check that "Google Play Services for AR" is installed and up to date, then reload.',
  backToRoom: 'Back to the 3D room',
  readyTitleTo: 'AR guide to {place}',
  readyTitleNone: 'AR guide',
  readyNoPlace: 'No place picked, so there is no route. You can still align and see the places.',
  placeNotFound: 'The place in the link was not found in this room.',
  sceneLoaded: '{scene} · {n} places',
  sceneMissing: 'Room data could not be loaded, so places are not shown. The floor test still works.',
  startAr: 'Start AR',
  starting: 'Starting the camera…',
  safety: 'Watch where you walk. The camera image stays on this phone and nothing is recorded.',
  startFailed: 'AR could not start: {reason}',
  cameraDenied: 'Camera permission was refused. Allow the camera for this site in Chrome, then try again.',
  arClosed: 'AR closed. Tap Start AR to try again.',
  findFloor: 'Move the phone slowly and point it at the floor',
  alignA: 'Aim the ring at cross {mark} and tap',
  alignB: 'Now aim at cross {mark} and tap',
  alignHint: 'Hold the ring still on the centre of the tape cross before tapping.',
  liveDistance: '{d} m from {mark} · the marks are {e} m apart',
  holdStill: 'Hold the ring still on the cross for a moment, then tap.',
  noFloorUnderRing: 'The ring is not on the floor. Point it at the floor and tap again.',
  badDistance: 'The taps are {got} m apart but the marks are {want} m apart. Start again at {mark}.',
  badHeight: 'The two taps are {cm} cm apart in height, so one missed the floor. Start again at {mark}.',
  confirmQ: 'Do the pins sit in the right spots?',
  confirmHint: 'The gold crosses should lie on the tape crosses. If everything is turned around, tap Flip.',
  yes: 'Yes',
  flip: 'Flip',
  redo: 'Redo',
  useAnyway: 'Use anyway',
  roomLost: 'The phone lost track of the room',
  roomLostHint: 'The pins are hidden so they do not show in the wrong place. Point the phone at the floor and furniture and move slowly. If they do not come back, tap Re-align and tap the two crosses again.',
  aligned: 'Aligned. Walk around: the pins should stay on their real objects.',
  phase2Note: 'No place picked. Open AR from a place in the 3D room to get a route.',
  navGoing: 'Going to {place}',
  navHint: 'Follow the gold arrows. The big gold ball marks the place.',
  navLeft: '{d} m to go · {time}',
  navTurnAround: 'Turn around',
  navNoRoute: 'No walkable route from here. Step back onto open floor.',
  timeSec: 'about {n} s',
  timeMin: 'about {n} min',
  pinLabel: '{place} · {d} m',
  arrivedTitle: 'You have arrived at {place}',
  arrivedHint: 'Tap Exit to go back to the 3D room.',
  realign: 'Re-align',
  changePlace: 'Change place',
  pickPlace: 'Pick a place',
  pickerTitle: 'Where to?',
  pickerPlaceholder: 'Search places',
  pickerEmpty: 'No place matches that.',
  cancel: 'Cancel',
  qrTitle: 'AR codes for {room}',
  qrIntro: 'Print this page and stick each code near the room door. Scanning a code with an Android phone opens the AR guide going to that place.',
  qrStart: 'Start AR',
  qrStartHint: 'Pick the place inside AR',
  qrScan: 'Scan to walk here with AR',
  qrPrint: 'Print',
  qrNone: 'No places are tagged in this room yet.',
  qrFailed: 'The room data could not be loaded. Check the link and the connection.',
  anchorsOn: 'Locked to the floor with anchors.',
  anchorsOff: 'Not locked with anchors, so the pins may slowly slide. Tap Re-align if they do.',
  noMarks: 'This room has no floor marks yet. In tag mode, add tags named "Mark 1A" and "Mark 1B" on the two tape crosses.',
  marksProblem: 'Floor marks need fixing: {problem}',
  noRoomData: 'Room data did not load, so alignment cannot start.',
  usingTestMarks: 'Using test marks from the link.',
  heightAbove: 'Phone is {m} m above the ring',
  exit: 'Exit',
  langSwitch: 'हिंदी',
};

export type PhraseKey = keyof typeof en;

const hi: Record<PhraseKey, string> = {
  checking: 'फ़ोन की जाँच हो रही है…',
  unsupportedTitle: 'AR के लिए Android फ़ोन पर Chrome चाहिए',
  unsupportedInsecure: 'यह पेज सुरक्षित पते (https या localhost) पर नहीं है, इसलिए ब्राउज़र AR रोक देता है।',
  unsupportedNoWebxr: 'इस ब्राउज़र में वेब AR (WebXR) नहीं है। लिंक को Android फ़ोन पर Chrome में खोलें।',
  unsupportedNoAr:
    'यह फ़ोन या ब्राउज़र AR शुरू नहीं कर पा रहा। देखें कि "Google Play Services for AR" इंस्टॉल और अपडेट है, फिर पेज रीलोड करें।',
  backToRoom: '3D कमरे पर वापस जाएँ',
  readyTitleTo: '{place} तक AR गाइड',
  readyTitleNone: 'AR गाइड',
  readyNoPlace: 'कोई जगह नहीं चुनी गई, इसलिए रास्ता नहीं दिखेगा। अलाइन करके जगहें फिर भी देख सकते हैं।',
  placeNotFound: 'लिंक वाली जगह इस कमरे में नहीं मिली।',
  sceneLoaded: '{scene} · {n} जगहें',
  sceneMissing: 'कमरे का डेटा लोड नहीं हुआ, इसलिए जगहें नहीं दिखेंगी। ज़मीन वाला टेस्ट फिर भी चलेगा।',
  startAr: 'AR शुरू करें',
  starting: 'कैमरा शुरू हो रहा है…',
  safety: 'चलते समय आसपास ध्यान रखें। कैमरे की तस्वीर इसी फ़ोन पर रहती है, कुछ भी रिकॉर्ड नहीं होता।',
  startFailed: 'AR शुरू नहीं हो पाया: {reason}',
  cameraDenied: 'कैमरे की अनुमति नहीं मिली। Chrome में इस साइट के लिए कैमरा चालू करें, फिर दोबारा कोशिश करें।',
  arClosed: 'AR बंद हो गया। दोबारा कोशिश के लिए "AR शुरू करें" दबाएँ।',
  findFloor: 'फ़ोन को धीरे-धीरे घुमाएँ और ज़मीन की ओर रखें',
  alignA: 'रिंग को क्रॉस {mark} पर रखें और टैप करें',
  alignB: 'अब रिंग को क्रॉस {mark} पर रखें और टैप करें',
  alignHint: 'टैप करने से पहले रिंग को टेप क्रॉस के बीच में स्थिर रखें।',
  liveDistance: '{mark} से {d} मी · निशान {e} मी दूर हैं',
  holdStill: 'रिंग को क्रॉस पर एक पल स्थिर रखें, फिर टैप करें।',
  noFloorUnderRing: 'रिंग ज़मीन पर नहीं है। उसे ज़मीन की ओर करें और फिर टैप करें।',
  badDistance: 'दोनों टैप {got} मी दूर हैं, पर निशान {want} मी दूर हैं। {mark} से दोबारा शुरू करें।',
  badHeight: 'दोनों टैप की ऊँचाई में {cm} सेमी का फ़र्क है, एक टैप ज़मीन पर नहीं लगा। {mark} से दोबारा शुरू करें।',
  confirmQ: 'क्या पिन सही जगह पर हैं?',
  confirmHint: 'सुनहरे क्रॉस टेप क्रॉस के ऊपर दिखने चाहिए। अगर सब उल्टा घूमा है, तो "पलटें" दबाएँ।',
  yes: 'हाँ',
  flip: 'पलटें',
  redo: 'फिर से',
  useAnyway: 'फिर भी इस्तेमाल करें',
  roomLost: 'फ़ोन कमरे की पहचान खो बैठा',
  roomLostHint: 'पिन छिपा दिए गए हैं ताकि गलत जगह न दिखें। फ़ोन को ज़मीन और फ़र्नीचर की ओर रखें और धीरे-धीरे घुमाएँ। अगर पिन वापस न आएँ, तो "फिर से अलाइन करें" दबाएँ और दोनों क्रॉस पर दोबारा टैप करें।',
  aligned: 'अलाइन हो गया। घूमकर देखें: पिन अपनी असली चीज़ों पर टिके रहने चाहिए।',
  phase2Note: 'कोई जगह नहीं चुनी गई। रास्ते के लिए 3D कमरे में किसी जगह से AR खोलें।',
  navGoing: '{place} की ओर',
  navHint: 'सुनहरे तीरों के पीछे चलें। बड़ी सुनहरी गेंद उस जगह पर है।',
  navLeft: '{d} मी बाकी · {time}',
  navTurnAround: 'पीछे मुड़ें',
  navNoRoute: 'यहाँ से चलने का रास्ता नहीं मिला। खुली ज़मीन पर वापस आएँ।',
  timeSec: 'लगभग {n} सेकंड',
  timeMin: 'लगभग {n} मिनट',
  pinLabel: '{place} · {d} मी',
  arrivedTitle: 'आप {place} पहुँच गए',
  arrivedHint: '3D कमरे पर लौटने के लिए "बाहर निकलें" दबाएँ।',
  realign: 'फिर से अलाइन करें',
  changePlace: 'जगह बदलें',
  pickPlace: 'जगह चुनें',
  pickerTitle: 'कहाँ जाना है?',
  pickerPlaceholder: 'जगह खोजें',
  pickerEmpty: 'इस नाम की कोई जगह नहीं मिली।',
  cancel: 'रद्द करें',
  qrTitle: '{room} के AR कोड',
  qrIntro: 'यह पेज प्रिंट करें और हर कोड कमरे के दरवाज़े के पास चिपकाएँ। Android फ़ोन से कोड स्कैन करने पर AR गाइड उस जगह का रास्ता दिखाता है।',
  qrStart: 'AR शुरू करें',
  qrStartHint: 'जगह AR में चुनें',
  qrScan: 'AR से यहाँ तक चलने के लिए स्कैन करें',
  qrPrint: 'प्रिंट करें',
  qrNone: 'इस कमरे में अभी कोई जगह टैग नहीं है।',
  qrFailed: 'कमरे का डेटा लोड नहीं हुआ। लिंक और इंटरनेट जाँचें।',
  anchorsOn: 'एंकर से ज़मीन पर लॉक है।',
  anchorsOff: 'एंकर से लॉक नहीं है, इसलिए पिन धीरे-धीरे खिसक सकते हैं। ऐसा हो तो "फिर से अलाइन करें" दबाएँ।',
  noMarks: 'इस कमरे में अभी ज़मीन के निशान नहीं हैं। टैग मोड में दोनों टेप क्रॉस पर "Mark 1A" और "Mark 1B" नाम के टैग लगाएँ।',
  marksProblem: 'ज़मीन के निशान ठीक करने हैं: {problem}',
  noRoomData: 'कमरे का डेटा लोड नहीं हुआ, इसलिए अलाइनमेंट शुरू नहीं हो सकता।',
  usingTestMarks: 'लिंक वाले टेस्ट निशान इस्तेमाल हो रहे हैं।',
  heightAbove: 'फ़ोन रिंग से {m} मी ऊपर है',
  exit: 'बाहर निकलें',
  langSwitch: 'English',
};

export const PHRASES: Readonly<Record<Lang, Readonly<Record<PhraseKey, string>>>> = { en, hi };

/** The line `key` in `lang`, with {name} placeholders filled from `vars`. */
export function phrase(lang: Lang, key: PhraseKey, vars: Record<string, string | number> = {}): string {
  return PHRASES[lang][key].replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

const LANG_KEY = 'namma.ar.lang';

/** The language saved on this phone, English when none (or storage is blocked). */
export function loadLang(): Lang {
  try {
    return localStorage.getItem(LANG_KEY) === 'hi' ? 'hi' : 'en';
  } catch {
    return 'en';
  }
}

export function saveLang(lang: Lang): void {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // Private mode or blocked storage: the choice lasts until the page closes
  }
}
