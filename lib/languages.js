// lib/languages.js
// Languages offered in the context menu + their TTS / speech-recognition hints.
//   - `code`  : base code used by the built-in Translator / LanguageDetector ("en", "fr", "zh"…)
//   - `label` : human label shown in the menu ("English", "French"…)
//   - `bcp47` : locale hint for chrome.tts and SpeechRecognition ("en-US", "fr-FR"…)
//   - `rtl`   : right-to-left script (affects panel text direction)

export const LANGUAGES = [
  { code: "en", label: "English", bcp47: "en-US" },
  { code: "fr", label: "French", bcp47: "fr-FR" },
  { code: "de", label: "German", bcp47: "de-DE" },
  { code: "es", label: "Spanish", bcp47: "es-ES" },
  { code: "it", label: "Italian", bcp47: "it-IT" },
  { code: "pt", label: "Portuguese", bcp47: "pt-BR" },
  { code: "zh", label: "Chinese", bcp47: "zh-CN" },
  { code: "hi", label: "Hindi", bcp47: "hi-IN" },
  { code: "ar", label: "Arabic", bcp47: "ar-SA", rtl: true },
  { code: "ja", label: "Japanese", bcp47: "ja-JP" },
  { code: "ru", label: "Russian", bcp47: "ru-RU" },
  { code: "ko", label: "Korean", bcp47: "ko-KR" },
  { code: "id", label: "Indonesian", bcp47: "id-ID" },
  { code: "pl", label: "Polish", bcp47: "pl-PL" },
  { code: "nl", label: "Dutch", bcp47: "nl-NL" },
];

const RTL = new Set(["ar", "he", "fa", "ur", "ps", "sd", "yi"]);

export function baseCode(code) {
  return (code || "").split("-")[0].toLowerCase();
}

export function isRTL(code) {
  return RTL.has(baseCode(code));
}

export function findLanguage(code) {
  const base = baseCode(code);
  return LANGUAGES.find((l) => l.code === base) || null;
}

export function labelFor(code) {
  const found = findLanguage(code);
  return found ? found.label : code || "unknown";
}

export function bcp47For(code) {
  const found = findLanguage(code);
  return found ? found.bcp47 : code;
}

// Merge the built-in list with user-added languages (from prefs.customLangs).
// Custom entries are normalized and override built-ins with the same code.
export function mergeLanguages(custom) {
  const map = new Map(LANGUAGES.map((l) => [l.code, { ...l }]));
  for (const l of custom || []) {
    if (!l || !l.code) continue;
    const code = baseCode(l.code);
    map.set(code, {
      code,
      label: l.label || code,
      bcp47: l.bcp47 || code,
      rtl: !!l.rtl,
      custom: true,
    });
  }
  return [...map.values()];
}
