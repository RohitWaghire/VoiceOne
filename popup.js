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
