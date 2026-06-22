// options.js — read/write preferences in chrome.storage.sync under the "prefs" key.

import { LANGUAGES, mergeLanguages } from "./lib/languages.js";

const DEFAULTS = {
  rate: 1.0,
  pitch: 1.0,
  volume: 1.0,
  voice: "",
  defaultTarget: "en",
  menuLangs: LANGUAGES.map((l) => l.code),
  customLangs: [],
};

const $ = (id) => document.getElementById(id);
const ranges = ["rate", "pitch", "volume"];

let customLangs = [];

function bindRange(id) {
  const input = $(id);
  const out = $(id + "Out");
  const sync = () => (out.textContent = Number(input.value).toFixed(1));
  input.addEventListener("input", sync);
  return sync;
}
const rangeSyncers = ranges.map(bindRange);

const allLangs = () => mergeLanguages(customLangs);
const checkedCodes = () =>
  [...document.querySelectorAll('#langs input[type="checkbox"]:checked')].map((c) => c.value);

function renderTargets() {
  const sel = $("defaultTarget");
  const prev = sel.value;
  sel.innerHTML = "";
  for (const lang of allLangs()) {
    const opt = document.createElement("option");
    opt.value = lang.code;
    opt.textContent = lang.label;
    sel.appendChild(opt);
  }
  if (prev) sel.value = prev;
}

// `enabled` may be an array of codes; if omitted, keep the current checkbox state.
function renderLangs(enabled) {
  const grid = $("langs");
  const state = new Set(enabled || checkedCodes());
  grid.innerHTML = "";
  for (const lang of allLangs()) {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = lang.code;
    cb.checked = state.has(lang.code);
    label.appendChild(cb);
    label.appendChild(document.createTextNode(" " + lang.label));
    if (lang.custom) {
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "rm";
      rm.textContent = "×";
      rm.title = "Remove " + lang.label;
      rm.addEventListener("click", () => {
        const keep = new Set(checkedCodes());
        customLangs = customLangs.filter((l) => l.code !== lang.code);
        keep.delete(lang.code);
        renderLangs([...keep]);
        renderTargets();
      });
      label.appendChild(rm);
    }
    grid.appendChild(label);
  }
}

function addCustomLang() {
  const label = $("newLabel").value.trim();
  const code = $("newCode").value.trim().toLowerCase().split("-")[0];
  const bcp47 = $("newBcp47").value.trim();
  if (!label) {
    $("newLabel").focus();
    return;
  }
  if (!/^[a-z]{2,3}$/.test(code)) {
    alert("Enter a 2–3 letter language code, e.g. sv");
    $("newCode").focus();
    return;
  }
  if (allLangs().some((l) => l.code === code)) {
    alert(`"${code}" is already in the list.`);
    return;
  }
  customLangs.push({ code, label, bcp47: bcp47 || code });
  $("newLabel").value = "";
  $("newCode").value = "";
  $("newBcp47").value = "";
  renderLangs([...checkedCodes(), code]); // keep existing + enable the new one
  renderTargets();
}

$("addLang").addEventListener("click", addCustomLang);
$("newBcp47").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addCustomLang();
});

// Populate the voice list from chrome.tts, then load saved prefs.
chrome.tts.getVoices((voices) => {
  (voices || [])
    .slice()
    .sort((a, b) => (a.lang || "").localeCompare(b.lang || ""))
    .forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v.voiceName;
      opt.textContent = `${v.voiceName} (${v.lang})`;
      $("voice").appendChild(opt);
    });
  load();
});

async function load() {
  const { prefs } = await chrome.storage.sync.get("prefs");
  const p = { ...DEFAULTS, ...(prefs || {}) };
  customLangs = Array.isArray(p.customLangs) ? p.customLangs.slice() : [];

  $("rate").value = p.rate;
  $("pitch").value = p.pitch;
  $("volume").value = p.volume;
  $("voice").value = p.voice;

  renderTargets();
  $("defaultTarget").value = p.defaultTarget;

  const enabled = p.menuLangs && p.menuLangs.length ? p.menuLangs : allLangs().map((l) => l.code);
  renderLangs(enabled);
  rangeSyncers.forEach((fn) => fn());
}

$("save").addEventListener("click", async () => {
  const menuLangs = checkedCodes();
  const prefs = {
    rate: Number($("rate").value),
    pitch: Number($("pitch").value),
    volume: Number($("volume").value),
    voice: $("voice").value,
    defaultTarget: $("defaultTarget").value,
    menuLangs: menuLangs.length ? menuLangs : allLangs().map((l) => l.code),
    customLangs,
  };
  await chrome.storage.sync.set({ prefs });
  const saved = $("saved");
  saved.classList.add("show");
  setTimeout(() => saved.classList.remove("show"), 1500);
});
