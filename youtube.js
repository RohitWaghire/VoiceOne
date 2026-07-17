// youtube.js — the YouTube site adapter for VoiceOne's dub engine.
// Site-specific pieces only: where the <video> lives, how captions are
// fetched (InnerTube + pot-gating workaround), how ads are marked, the
// player-bar button, and SPA-navigation glue. The engine itself — cue
// scheduling, ducking, the dub panel, translation — is lib/dub-engine.js.
//
// Classic (non-module) content script: shared code is pulled in with a
// dynamic import of lib/*.js (declared web-accessible in the manifest).

(() => {
  "use strict";
  if (window.__voiceOneTube) return;
  window.__voiceOneTube = true;

  const BTN_ID = "voiceone-dub-btn";

  // A predecessor script orphaned by an extension reload leaves its dead
  // button in the DOM; remove it so ensureButton rebuilds a live one.
  document.getElementById(BTN_ID)?.remove();

  let cap = null; // lib/captions.js exports

  // After an extension update/reload, scripts already injected into open tabs
  // are orphaned: chrome.runtime disappears and every extension API throws.
  const contextAlive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };

  const currentVideoId = () =>
    new URLSearchParams(location.search).get("v") || null;

  // YouTube plays ads through the same <video>, marking the player element.
  const isAdShowing = () => {
    const p = document.getElementById("movie_player");
    return !!p && (p.classList.contains("ad-showing") || p.classList.contains("ad-interrupting"));
  };

  // The page embeds a visitorData token; sending it (plus the tab's own
  // youtube.com cookies) lets the InnerTube call pass YouTube's bot check.
  function getVisitorData() {
    for (const s of document.getElementsByTagName("script")) {
      const m = /"visitorData":"([^"]+)"/.exec(s.textContent || "");
      if (m) return m[1];
    }
    return null;
  }

  // The caption URLs in the page's own player data are gated behind a
  // proof-of-origin token since 2025 and return HTTP 200 with an EMPTY body
  // when fetched outside YouTube's player. The InnerTube API queried as the
  // ANDROID client returns caption URLs that still work, so ask it first and
  // keep the page's player response only as a fallback for track listing.
  async function getCaptionTracks(videoId) {
    try {
      const visitorData = getVisitorData();
      const r = await fetch("https://www.youtube.com/youtubei/v1/player", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          context: {
            client: {
              clientName: "ANDROID",
              clientVersion: "20.10.38",
              androidSdkVersion: 30,
              hl: "en",
              ...(visitorData ? { visitorData } : {}),
            },
          },
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
        }),
      });
      const tracks = cap.listCaptionTracks(await r.json());
      if (tracks.length) return tracks;
    } catch {
      /* fall through to page data */
    }
    for (const s of document.getElementsByTagName("script")) {
      const txt = s.textContent;
      if (txt && txt.indexOf("ytInitialPlayerResponse") !== -1) {
        const pr = cap.extractPlayerResponse(txt);
        if (pr?.videoDetails?.videoId === videoId)
          return cap.listCaptionTracks(pr);
      }
    }
    const html = await (await fetch(location.href, { credentials: "same-origin" })).text();
    return cap.listCaptionTracks(cap.extractPlayerResponse(html));
  }

  // Fetch a caption track's cues. Sniff the response body — depending on the
  // endpoint, YouTube answers with json3 JSON or srv3/classic timed-text XML
  // (and may ignore the fmt parameter entirely).
  async function fetchCaption(baseUrl) {
    const sep = baseUrl.includes("?") ? "&" : "?";
    for (const url of [baseUrl + sep + "fmt=json3", baseUrl]) {
      let body = "";
      try {
        body = (await (await fetch(url, { credentials: "omit" })).text()).trim();
      } catch {
        continue;
      }
      if (!body) continue; // pot-gated empty response — try next variant
      try {
        const cues = body[0] === "{"
          ? cap.parseJson3(JSON.parse(body))
          : cap.parseTimedTextXml(body);
        if (cues.length) return cues;
      } catch {
        /* malformed — try next variant */
      }
    }
    return [];
  }

  // ------------------------------------------------------------ site adapter
  const adapter = {
    getVideo: () => document.querySelector("video.html5-main-video"),
    videoKey: currentVideoId,
    isAdShowing,
    onStateChange: setButtonState,
    async getCues(target, isSuperseded) {
      const tracks = await getCaptionTracks(currentVideoId());
      if (isSuperseded()) return null;
      const track = cap.pickTrack(tracks, target);
      if (!track || !track.baseUrl)
        throw new Error("this video has no captions, so it can't be dubbed.");
      const cues = cap.mergeCues(await fetchCaption(track.baseUrl));
      if (isSuperseded()) return null;
      if (!cues.length)
        throw new Error("couldn't load captions for this video — try another video or reload the page.");
      return { cues, sourceLang: (track.languageCode || "en").toLowerCase().split("-")[0] };
    },
  };

  // Engine + libs load once at injection; context is guaranteed alive here.
  // The engine is a leaf module (see its header) — we import its dependencies
  // and hand the helpers in.
  const bootPromise = (async () => {
    cap = await import(chrome.runtime.getURL("lib/captions.js"));
    const langs = await import(chrome.runtime.getURL("lib/languages.js"));
    const { createDubEngine } = await import(chrome.runtime.getURL("lib/dub-engine.js"));
    return createDubEngine(adapter, {
      findCueIndex: cap.findCueIndex,
      bcp47For: langs.bcp47For,
      labelFor: langs.labelFor,
      mergeLanguages: langs.mergeLanguages,
    });
  })();
  bootPromise.catch((err) => console.warn("[VoiceOne] engine failed to load:", err));

  // ----------------------------------------------------------------- button
  function ensureButton() {
    if (location.pathname !== "/watch") return;
    if (document.getElementById(BTN_ID)) return;
    const controls = document.querySelector(".ytp-right-controls");
    if (!controls) return;

    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.className = "ytp-button";
    btn.title = "VoiceOne — dub this video";
    btn.setAttribute("aria-pressed", "false");
    const logo = document.createElement("img");
    logo.src = chrome.runtime.getURL("icons/icon48.png");
    logo.alt = "";
    logo.style.cssText = "width:24px;height:24px;pointer-events:none;display:block;border-radius:5px;";
    btn.appendChild(logo);
    btn.style.cssText =
      "width:48px;height:100%;padding:0;opacity:0.9;display:inline-flex;align-items:center;justify-content:center;vertical-align:top;";
    btn.addEventListener("click", () => {
      if (!contextAlive()) return; // engine's own toast can't run without a context either
      bootPromise.then((engine) => engine.toggle()).catch(() => {});
    });
    controls.prepend(btn);
  }

  function setButtonState(mode) {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    btn.setAttribute("aria-pressed", String(mode === "on"));
    // The logo is an <img>, so signal "on" with a glow instead of a color tint.
    const logo = btn.querySelector("img");
    if (logo) logo.style.filter = mode === "on" ? "drop-shadow(0 0 5px #3ea6ff)" : "";
    btn.style.opacity = mode === "loading" ? "0.5" : mode === "on" ? "1" : "0.9";
  }

  // ------------------------------------------------- popup remote control
  // Distinct namespace from "voiceone" so the service worker's router ignores
  // these; they travel popup → this tab's content script only. Registered
  // synchronously at injection (before the engine finishes loading) so an
  // early popup query never looks like a dead tab; handlers await the engine.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.ns !== "voiceone-yt") return;
    (async () => {
      const engine = await bootPromise;
      if (msg.cmd === "state") {
        sendResponse({
          watch: location.pathname === "/watch",
          ...(await engine.stateSnapshot()),
        });
      } else if (msg.cmd === "toggle") {
        engine.toggle();
        sendResponse({ ok: true });
      } else if (msg.cmd === "lang") {
        engine.setTarget(msg.code);
        sendResponse({ ok: true });
      } else if (msg.cmd === "duck") {
        engine.setDuck(Number(msg.value), !!msg.persist);
        sendResponse({ ok: true });
      }
    })().catch(() => {});
    return true; // all responses are async (they wait for the engine)
  });

  // ------------------------------------------------- SPA navigation glue
  document.addEventListener("yt-navigate-finish", () => {
    bootPromise
      .then((engine) => {
        if (engine.active || engine.preparing) engine.stop(null);
      })
      .catch(() => {});
    ensureButton();
  });
  // Cheap idempotent poll (getElementById early-return) — more robust than a
  // subtree MutationObserver on YouTube's constantly-mutating DOM.
  setInterval(ensureButton, 1500);
  ensureButton();
})();
