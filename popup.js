// popup.js — toolbar popup: quick actions + a mirror of the panel state
// (acts as the fallback control surface where the in-page panel can't be injected).

import { mergeLanguages } from "./lib/languages.js";

const send = (action, extra = {}) =>
  chrome.runtime.sendMessage({ ns: "voiceone", from: "popup", action, ...extra }).catch(() => {});

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const textEl = $("text");

// Populate the target-language dropdown, defaulting to the saved preference.
(async () => {
  const { prefs } = await chrome.storage.sync.get("prefs");
  const defaultTarget = prefs?.defaultTarget || "en";
  for (const lang of mergeLanguages(prefs?.customLangs)) {
    const opt = document.createElement("option");
    opt.value = lang.code;
    opt.textContent = lang.label;
    if (lang.code === defaultTarget) opt.selected = true;
    $("target").appendChild(opt);
  }
})();

$("read").addEventListener("click", () => send("read-selection"));
$("translate").addEventListener("click", () => send("read-selection", { target: $("target").value }));
$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

document.querySelectorAll(".controls button[data-a]").forEach((btn) => {
  btn.addEventListener("click", () => send(btn.dataset.a));
});

function render(view) {
  if (!view) return;
  statusEl.textContent = view.status || "";
  statusEl.classList.toggle("warn", (view.status || "").startsWith("⚠"));
  if (view.text !== undefined) {
    const t = view.text || "";
    textEl.textContent = t;
    // Hide the reading box entirely when blank so it doesn't look like a stray border.
    textEl.style.display = t.trim() ? "" : "none";
    textEl.dir = view.dir === "rtl" ? "rtl" : "ltr";
  }
}

// Live updates while the popup is open.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.ns === "voiceone" && msg.cmd === "render") render(msg.view);
});

// Initial state from the last mirrored view.
chrome.storage.session.get("voiceoneView").then(({ voiceoneView }) => render(voiceoneView));

// ---------------------------------------------------------------------------
// YouTube dubbing section — appears when the active tab is a watch page.
// ---------------------------------------------------------------------------
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/youtube\.com\/watch/.test(tab.url || "")) return;

  const sendYt = (cmd, extra = {}) =>
    chrome.tabs.sendMessage(tab.id, { ns: "voiceone-yt", cmd, ...extra }).catch(() => null);

  const sec = $("yt");
  const st = await sendYt("state");
  sec.classList.remove("hidden");

  if (!st) {
    // Content script from before the last extension update — it can't dub.
    $("ytStatus").textContent = "reload the video tab to enable";
    for (const el of ["ytLang", "ytToggle", "ytDuck"]) $(el).disabled = true;
    return;
  }

  const toggleBtn = $("ytToggle");
  const setToggle = (active, preparing) => {
    toggleBtn.textContent = preparing ? "Starting…" : active ? "Stop dubbing" : "Start dubbing";
    $("ytStatus").textContent = active ? "dubbing" : "";
  };
  setToggle(st.active, st.preparing);

  const langSel = $("ytLang");
  for (const lang of mergeLanguages(st.customLangs)) {
    const opt = document.createElement("option");
    opt.value = lang.code;
    opt.textContent = "Dub into " + lang.label;
    if (lang.code === st.target) opt.selected = true;
    langSel.appendChild(opt);
  }
  langSel.addEventListener("change", () => sendYt("lang", { code: langSel.value }));

  toggleBtn.addEventListener("click", async () => {
    await sendYt("toggle");
    if (!st.active) window.close(); // starting — get out of the way, panel appears on page
    else setToggle(false, false);
    st.active = !st.active;
  });

  const duck = $("ytDuck");
  const duckOut = $("ytDuckOut");
  const syncDuck = () => (duckOut.textContent = Math.round(duck.value * 100) + "%");
  duck.value = st.duck;
  syncDuck();
  duck.addEventListener("input", () => {
    syncDuck();
    sendYt("duck", { value: Number(duck.value) });
  });
  duck.addEventListener("change", () => sendYt("duck", { value: Number(duck.value), persist: true }));
})();
