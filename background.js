// background.js — VoiceOne service worker / orchestrator.
// Selected text -> built-in Translator -> chrome.tts read-aloud, driven by a
// right-click context menu, with a floating in-page control panel.

import {
  LANGUAGES,
  labelFor,
  bcp47For,
  isRTL,
  baseCode,
  mergeLanguages,
} from "./lib/languages.js";

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------
const DEFAULT_PREFS = {
  rate: 1.0,
  pitch: 1.0,
  volume: 1.0,
  voice: "", // preferred chrome.tts voiceName ("" = auto)
  defaultTarget: "en",
  menuLangs: null, // null = all languages enabled in the menu
  customLangs: [], // user-added languages: [{ code, label, bcp47, rtl }]
  ytDuck: 0.12, // original-audio level while dubbing YouTube (0 = mute)
};

async function getPrefs() {
  const { prefs } = await chrome.storage.sync.get("prefs");
  return { ...DEFAULT_PREFS, ...(prefs || {}) };
}

// Let the injected panel (a content-script context) read the mirrored view from
// session storage on (re)injection.
chrome.storage.session
  .setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })
  .catch(() => {});

// ---------------------------------------------------------------------------
// Languages: built-in + user-added (prefs.customLangs)
// ---------------------------------------------------------------------------
let allLangs = LANGUAGES.slice();
async function refreshLangs() {
  const { customLangs } = await getPrefs();
  allLangs = mergeLanguages(customLangs);
  return allLangs;
}
const langInfo = (code) => allLangs.find((l) => l.code === baseCode(code)) || null;
const langLabel = (code) => langInfo(code)?.label || labelFor(code);
const langBcp47 = (code) => langInfo(code)?.bcp47 || bcp47For(code);
const langIsRtl = (code) => {
  const i = langInfo(code);
  return i ? !!i.rtl : isRTL(code);
};
refreshLangs();

// ---------------------------------------------------------------------------
// Current session state (best-effort; the SW may be recycled between events)
// ---------------------------------------------------------------------------
let current = {};

// ---------------------------------------------------------------------------
// Context menus
// ---------------------------------------------------------------------------
const MENU_ROOT = "voiceone-root";
const MENU_AUTO = "voiceone-auto";
const MENU_TRANSLATE = "voiceone-translate";
const MENU_LANG_PREFIX = "voiceone-lang-";

async function buildMenus() {
  const prefs = await getPrefs();
  await refreshLangs();
  const enabled =
    prefs.menuLangs && prefs.menuLangs.length
      ? allLangs.filter((l) => prefs.menuLangs.includes(l.code))
      : allLangs;

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ROOT, title: "VoiceOne", contexts: ["selection"] });
    chrome.contextMenus.create({
      id: MENU_AUTO,
      parentId: MENU_ROOT,
      title: "Auto Read Original Language",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: MENU_TRANSLATE,
      parentId: MENU_ROOT,
      title: "Translate & Read",
      contexts: ["selection"],
    });
    for (const lang of enabled) {
      chrome.contextMenus.create({
        id: MENU_LANG_PREFIX + lang.code,
        parentId: MENU_TRANSLATE,
        title: `Translate to ${lang.label}`,
        contexts: ["selection"],
      });
    }
  });
}

chrome.runtime.onInstalled.addListener(() => buildMenus());

// Rebuild the menu when the enabled-language preference changes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.prefs) buildMenus();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const text = (info.selectionText || "").trim();
  if (!text || !tab?.id) return;
  if (info.menuItemId === MENU_AUTO) {
    await handleAutoRead(tab.id, text);
  } else if (String(info.menuItemId).startsWith(MENU_LANG_PREFIX)) {
    const target = String(info.menuItemId).slice(MENU_LANG_PREFIX.length);
    await handleTranslateRead(tab.id, text, target);
  }
});

// ---------------------------------------------------------------------------
// Built-in AI: language detection + translation
// ---------------------------------------------------------------------------
async function detectLanguage(text) {
  try {
    if (!globalThis.LanguageDetector) return null;
    if ((await LanguageDetector.availability()) === "unavailable") return null;
    const detector = await LanguageDetector.create();
    const results = await detector.detect(text);
    detector.destroy?.();
    if (!results?.length) return null;
    return { lang: results[0].detectedLanguage, confidence: results[0].confidence };
  } catch (err) {
    console.warn("[VoiceOne] language detection failed:", err);
    return null;
  }
}

const translatorCache = new Map(); // `${src}>${tgt}` -> Translator

async function getTranslator(src, tgt, onProgress) {
  const key = `${src}>${tgt}`;
  if (translatorCache.has(key)) return translatorCache.get(key);
  if (!globalThis.Translator) throw new Error("Built-in Translator API not available");
  const availability = await Translator.availability({ sourceLanguage: src, targetLanguage: tgt });
  if (availability === "unavailable") {
    throw new Error(`No on-device model for ${langLabel(src)} → ${langLabel(tgt)}`);
  }
  const translator = await Translator.create({
    sourceLanguage: src,
    targetLanguage: tgt,
    monitor(m) {
      m.addEventListener("downloadprogress", (e) => {
        onProgress?.(Math.round((e.loaded || 0) * 100));
      });
    },
  });
  translatorCache.set(key, translator);
  return translator;
}

// ---------------------------------------------------------------------------
// Speech (chrome.tts)
// ---------------------------------------------------------------------------
function getVoices() {
  return new Promise((resolve) => chrome.tts.getVoices((v) => resolve(v || [])));
}

async function pickVoice(bcp47, preferred) {
  const voices = await getVoices();
  if (preferred) {
    const exact = voices.find((v) => v.voiceName === preferred);
    if (exact) return exact.voiceName;
  }
  const base = baseCode(bcp47);
  const match =
    voices.find((v) => v.lang === bcp47) || voices.find((v) => baseCode(v.lang) === base);
  return match ? match.voiceName : null;
}

async function readAloud(tabId, text, bcp47, voiceName) {
  const prefs = await getPrefs();
  if (voiceName === undefined) voiceName = await pickVoice(bcp47, prefs.voice);

  current.lastUtterance = { text, bcp47, voiceName };

  chrome.tts.stop();
  const opts = {
    lang: bcp47,
    rate: prefs.rate,
    pitch: prefs.pitch,
    volume: prefs.volume,
    onEvent: (e) => {
      if (e.type === "start") {
        setView(tabId, { speaking: true });
      } else if (["end", "interrupted", "cancelled", "error"].includes(e.type)) {
        setView(tabId, { speaking: false, status: e.type === "error" ? "⚠ Speech error" : "Done" });
      }
    },
  };
  if (voiceName) opts.voiceName = voiceName;
  chrome.tts.speak(text, opts);
}

// ---------------------------------------------------------------------------
// Menu handlers
// ---------------------------------------------------------------------------
async function handleAutoRead(tabId, text) {
  await ensurePanel(tabId);
  await refreshLangs();
  current = { tabId, mode: "original", view: {} };
  setView(tabId, { status: "Detecting language…", text, dir: "ltr", busy: true });

  const det = await detectLanguage(text);
  const lang = det?.lang || "en";
  const bcp47 = langBcp47(lang);
  const dir = langIsRtl(lang) ? "rtl" : "ltr";

  setView(tabId, { status: `Reading original · ${langLabel(lang)}`, text, dir, busy: false });
  await readAloud(tabId, text, bcp47);
}

async function handleTranslateRead(tabId, text, target) {
  await ensurePanel(tabId);
  await refreshLangs();
  current = { tabId, mode: "translate", view: {} };
  setView(tabId, {
    status: "Translating…",
    text: "",
    dir: langIsRtl(target) ? "rtl" : "ltr",
    busy: true,
  });

  try {
    const det = await detectLanguage(text);
    const src = det?.lang || "en";
    const lowConf = det ? det.confidence < 0.5 : true;
    const srcLabel = lowConf ? "mixed" : langLabel(src);

    let translated = text;
    if (baseCode(src) !== baseCode(target)) {
      const translator = await getTranslator(baseCode(src), baseCode(target), (p) =>
        setView(tabId, { status: `Downloading model… ${p}%` })
      );
      translated = await translator.translate(text);
    }

    const bcp47 = langBcp47(target);
    const dir = langIsRtl(target) ? "rtl" : "ltr";
    const prefs = await getPrefs();
    const voiceName = await pickVoice(bcp47, prefs.voice);

    setView(tabId, {
      status: `Translated ${srcLabel} → ${target} · ${voiceName || langLabel(target)}`,
      text: translated,
      dir,
      busy: false,
    });
    await readAloud(tabId, translated, bcp47, voiceName);
  } catch (err) {
    setView(tabId, { status: `⚠ ${err.message || "Translation failed"}`, busy: false });
  }
}

// ---------------------------------------------------------------------------
// Panel view: inject + push state (mirrored to storage for the popup)
// ---------------------------------------------------------------------------
async function ensurePanel(tabId) {
  // panel.js renders inside a Shadow DOM with its own styles (isolated from the
  // page, including the PDF viewer) — no CSS injection needed.
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["panel.js"] });
    return true;
  } catch (err) {
    console.warn("[VoiceOne] panel injection blocked (use popup fallback):", err);
    return false;
  }
}

function setView(tabId, patch) {
  current.view = { ...(current.view || {}), ...patch };
  const view = current.view;
  chrome.storage.session.set({ voiceoneView: view }).catch(() => {});
  if (tabId) {
    chrome.tabs.sendMessage(tabId, { ns: "voiceone", cmd: "render", view }).catch(() => {});
  }
  chrome.runtime.sendMessage({ ns: "voiceone", cmd: "render", view }).catch(() => {});
  return view;
}

// ---------------------------------------------------------------------------
// Message routing (panel + popup controls)
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.ns !== "voiceone" || !msg.from) return;
  // "yt-translate" is the pre-1.3 name — content scripts orphaned by an
  // extension update may still send it.
  if (msg.action === "dub-translate" || msg.action === "yt-translate") {
    ytTranslate(msg)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // async response
  }
  handleControl(msg);
});

// Translate a batch of YouTube caption cues to the dub target on-device.
// The content script chunks its requests, so each call stays small.
async function ytTranslate({ texts, source, target }) {
  if (!Array.isArray(texts) || !texts.length) return { ok: true, texts: [] };
  const src = baseCode(source || "en");
  const tgt = baseCode(target || "en");
  if (src === tgt) return { ok: true, texts };
  const translator = await getTranslator(src, tgt);
  const out = [];
  for (const t of texts) out.push(await translator.translate(t));
  return { ok: true, texts: out };
}

async function handleControl(msg) {
  const tabId = current?.tabId;
  switch (msg.action) {
    case "pause":
      chrome.tts.pause();
      setView(tabId, { paused: true });
      break;
    case "resume":
      chrome.tts.resume();
      setView(tabId, { paused: false });
      break;
    case "stop":
      chrome.tts.stop();
      setView(tabId, { speaking: false, paused: false, status: "Stopped" });
      break;
    case "repeat":
      if (current?.lastUtterance) {
        const u = current.lastUtterance;
        await readAloud(tabId, u.text, u.bcp47, u.voiceName);
      }
      break;
    case "clear":
      chrome.tts.stop();
      setView(tabId, { text: "", status: "", speaking: false });
      break;
    case "close":
      chrome.tts.stop();
      if (tabId) chrome.tabs.sendMessage(tabId, { ns: "voiceone", cmd: "destroy" }).catch(() => {});
      chrome.storage.session.remove("voiceoneView").catch(() => {});
      current = {};
      break;
    case "read-selection":
      await readSelectionFromPopup(msg.target);
      break;
  }
}

async function readSelectionFromPopup(target) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  let text = "";
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => String(window.getSelection?.() || ""),
    });
    text = (res?.result || "").trim();
  } catch {
    /* injection blocked (e.g. PDF viewer) — ask the user to use the right-click menu */
  }
  if (!text) {
    setView(tab.id, { status: "Select text on the page, then try again (or use the right-click menu)." });
    return;
  }
  if (target) await handleTranslateRead(tab.id, text, target);
  else await handleAutoRead(tab.id, text);
}
