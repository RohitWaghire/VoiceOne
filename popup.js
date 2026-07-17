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
// Resolved ahead of the click: sidePanel.open() needs a user gesture, so the
// handler can't await anything before calling it.
let panelWindowId = null;
chrome.windows.getCurrent().then((w) => (panelWindowId = w.id)).catch(() => {});

$("settings").addEventListener("click", () => {
  if (panelWindowId === null) return chrome.runtime.openOptionsPage();
  // Popup dismisses itself once the panel takes focus.
  chrome.sidePanel.open({ windowId: panelWindowId }).catch(() => chrome.runtime.openOptionsPage());
});

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
// Video dubbing section. YouTube has a declared content script; any other
// https site can be enabled at runtime — chrome.permissions.request needs the
// click's user gesture, so the whole grant→register flow lives here.
// ---------------------------------------------------------------------------
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  let url;
  try {
    url = new URL(tab.url || "");
  } catch {
    return;
  }
  if (url.protocol !== "https:") return; // no dubbing on chrome://, file:// etc.
  const isYouTube = url.hostname === "www.youtube.com";
  if (isYouTube && !url.pathname.startsWith("/watch")) return; // home/feed pages
  const originPattern = url.origin + "/*";

  const sec = $("yt");
  const sendYt = (cmd, extra = {}) =>
    chrome.tabs.sendMessage(tab.id, { ns: "voiceone-yt", cmd, ...extra }).catch(() => null);

  async function initControls() {
    sec.classList.remove("hidden");
    $("ytEnableRow").classList.add("hidden");
    $("ytControls").classList.remove("hidden");
    let st = await sendYt("state");

    if (!st) {
      // No script in the tab — it predates the extension load, or an extension
      // reload orphaned it. The open popup holds activeTab, so inject now.
      await chrome.scripting
        .executeScript({
          target: { tabId: tab.id },
          files: [isYouTube ? "youtube.js" : "sites/generic.js"],
        })
        .catch(() => {});
      st = await sendYt("state");
    }

    if (!st) {
      // Injection still couldn't reach it — hand the user a one-click fix.
      $("ytStatus").textContent = "tab needs a reload";
      $("ytLang").disabled = true;
      $("ytDuck").disabled = true;
      const btn = $("ytToggle");
      btn.textContent = "Reload video tab";
      btn.addEventListener("click", () => {
        chrome.tabs.reload(tab.id);
        window.close();
      });
      return;
    }

    const toggleBtn = $("ytToggle");
    const setToggle = (active, preparing) => {
      toggleBtn.textContent = preparing ? "Starting…" : active ? "Stop dubbing" : "Start dubbing";
      toggleBtn.disabled = !!preparing; // a click mid-prep would no-op yet flip the label
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
      // Re-query: the dub may have been started/stopped from the page while
      // this popup sat open, making the snapshot stale.
      const live = (await sendYt("state")) || st;
      await sendYt("toggle");
      if (!live.active) window.close(); // starting — get out of the way, panel appears on page
      else setToggle(false, false);
      st.active = !live.active;
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
  }

  const enabled =
    isYouTube ||
    (await chrome.permissions.contains({ origins: [originPattern] }).catch(() => false));

  if (enabled) {
    if (!isYouTube) {
      // The page may predate the site's enablement (or registration runs at
      // document_idle on future loads) — inject now; the script's own guard
      // makes this a no-op when it's already there.
      await chrome.scripting
        .executeScript({ target: { tabId: tab.id }, files: ["sites/generic.js"] })
        .catch(() => {});
    }
    return initControls();
  }

  // Not enabled yet: offer the one-click grant.
  sec.classList.remove("hidden");
  $("ytControls").classList.add("hidden");
  $("ytEnableRow").classList.remove("hidden");
  $("ytEnable").addEventListener("click", async () => {
    const ok = await chrome.permissions
      .request({ origins: [originPattern] })
      .catch(() => false);
    if (!ok) return; // user declined Chrome's prompt
    try {
      await chrome.scripting.registerContentScripts([
        {
          id: "voiceone-dub:" + originPattern,
          matches: [originPattern],
          js: ["sites/generic.js"],
          runAt: "document_idle",
          persistAcrossSessions: true,
        },
      ]);
    } catch (err) {
      // A leftover registration from an earlier grant is fine; anything else
      // is a real failure the user should see.
      if (!String(err?.message).includes("Duplicate")) {
        console.warn("[VoiceOne] site registration failed:", err);
        $("ytStatus").textContent = "couldn't enable — try again";
        return;
      }
    }
    await chrome.scripting
      .executeScript({ target: { tabId: tab.id }, files: ["sites/generic.js"] })
      .catch(() => {});
    initControls();
  });
})();
