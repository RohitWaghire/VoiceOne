// panel.js — injected into the active tab via chrome.scripting.executeScript.
// Renders the floating VoiceOne playback panel inside a Shadow DOM (isolated from
// page styles). Talks to the service worker via chrome.runtime messaging.

(() => {
  if (window.__voiceOnePanel) {
    window.__voiceOnePanel.show();
    return;
  }

  const send = (action, extra = {}) =>
    chrome.runtime.sendMessage({ ns: "voiceone", from: "panel", action, ...extra }).catch(() => {});

  const host = document.createElement("div");
  host.id = "voiceone-host";
  host.style.cssText =
    "all: initial; position: fixed; left: 16px; bottom: 16px; z-index: 2147483647;";
  const shadow = host.attachShadow({ mode: "open" });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      .panel {
        width: 460px; max-width: calc(100vw - 32px);
        background: #f7f5ef; color: #2e2f2b;
        border: 1px solid #d9d3c4; border-radius: 14px;
        box-shadow: 0 12px 40px rgba(60,55,40,.22);
        overflow: hidden; user-select: none;
      }
      .header {
        display: flex; align-items: center; gap: 8px;
        padding: 10px 12px; background: #ece8dc; cursor: move;
        border-bottom: 1px solid #ded8c8;
      }
      .title { font-weight: 700; font-size: 13px; letter-spacing: .3px; margin-right: auto; }
      .controls { display: flex; gap: 6px; flex-wrap: wrap; }
      button {
        font-size: 12px; color: #3a3a34; background: #e7e2d4;
        border: 1px solid #d2ccba; border-radius: 8px;
        padding: 5px 9px; cursor: pointer; line-height: 1; transition: background .12s;
      }
      button:hover { background: #ddd7c6; }
      button:active { background: #d2ccba; }
      button.icon { padding: 5px 8px; }
      button.close { background: transparent; border-color: transparent; font-size: 14px; }
      button.close:hover { background: #ecd7cf; }
      .body { padding: 12px 14px 14px; }
      .status { font-size: 11px; color: #8d897a; margin-bottom: 8px; min-height: 14px; }
      .status.warn { color: #b3402f; }
      .text {
        font-size: 19px; line-height: 1.45; max-height: 220px; overflow-y: auto;
        white-space: pre-wrap; word-break: break-word; user-select: text;
      }
      .text:empty { display: none; }
    </style>
    <div class="panel">
      <div class="header">
        <span class="title">VoiceOne</span>
        <div class="controls">
          <button data-a="pause" class="icon" title="Pause">⏸</button>
          <button data-a="resume" class="icon" title="Resume">▶</button>
          <button data-a="repeat" class="icon" title="Repeat">↻</button>
          <button data-a="stop" class="icon" title="Stop">⏹</button>
          <button data-a="clear" title="Clear">Clear</button>
          <button data-a="close" class="close" title="Close">✕</button>
        </div>
      </div>
      <div class="body">
        <div class="status"></div>
        <div class="text" dir="ltr"></div>
      </div>
    </div>
  `;

  (document.documentElement || document.body).appendChild(host);

  const elStatus = shadow.querySelector(".status");
  const elText = shadow.querySelector(".text");

  // Control buttons
  shadow.querySelectorAll("button[data-a]").forEach((btn) => {
    btn.addEventListener("click", () => send(btn.dataset.a));
  });

  // Lightweight drag by the header
  (() => {
    const header = shadow.querySelector(".header");
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    header.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      dragging = true;
      const r = host.getBoundingClientRect();
      ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
      host.style.right = "auto"; host.style.bottom = "auto";
      header.setPointerCapture(e.pointerId);
    });
    header.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      host.style.left = Math.max(0, ox + e.clientX - sx) + "px";
      host.style.top = Math.max(0, oy + e.clientY - sy) + "px";
    });
    header.addEventListener("pointerup", () => (dragging = false));
  })();

  function render(view) {
    if (!view) return;
    elStatus.textContent = view.status || "";
    elStatus.classList.toggle("warn", (view.status || "").startsWith("⚠"));
    if (view.text !== undefined) elText.textContent = view.text || "";
    if (view.dir) elText.dir = view.dir === "rtl" ? "rtl" : "ltr";
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.ns !== "voiceone") return;
    if (msg.cmd === "render") render(msg.view);
    else if (msg.cmd === "destroy") {
      host.remove();
      window.__voiceOnePanel = null;
    }
  });

  window.__voiceOnePanel = {
    show: () => (host.style.display = ""),
    render,
  };

  // Pull any state the SW already stored (covers re-injection / popup-driven runs).
  try {
    chrome.storage.session
      .get("voiceoneView")
      .then(({ voiceoneView }) => voiceoneView && render(voiceoneView))
      .catch(() => {});
  } catch {
    /* session storage not exposed to this context */
  }
})();
