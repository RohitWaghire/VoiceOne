// youtube.js — VoiceOne's one-click YouTube dub (content script).
// Adds a button to the YouTube player. On click: fetch the video's caption
// track, translate it on-device to the chosen dub language (via the service
// worker), duck the original audio, and narrate the captions in sync with the
// video clock. A small panel offers the dub language, a live original-audio
// slider, and stop.
//
// Classic (non-module) content script: shared helpers are pulled in with a
// dynamic import of lib/*.js (declared web-accessible in the manifest).

(() => {
  "use strict";
  if (window.__voiceOneTube) return;
  window.__voiceOneTube = true;

  const BTN_ID = "voiceone-dub-btn";
  const TOAST_ID = "voiceone-yt-toast";
  const PANEL_ID = "voiceone-yt-panel";
  const MS_PER_CHAR = 62; // ≈16 chars/sec at TTS rate 1.0

  let cap = null; // lib/captions.js exports
  let langs = null; // lib/languages.js exports
  const state = {
    active: false, // dub currently on
    preparing: false, // click handled, captions loading
    gen: 0, // bumped on every start/stop — invalidates in-flight async work
    video: null,
    cues: [], // [{start, end, text, orig?}]
    idx: 0,
    timer: null,
    savedVolume: null,
    applyingDuck: false, // guards our own volume writes from onVolumeChange
    inAd: false,
    inflight: 0, // utterances submitted to speechSynthesis but not finished
    voice: null,
    target: null, // dub language (base code, e.g. "en"); null until prefs load
    bcp47: "en-US",
    prefs: { rate: 1.0, ytDuck: 0.12, customLangs: [] },
    videoId: null, // which video the cues belong to
  };

  // ------------------------------------------------------------------ utils
  async function loadLibs() {
    if (!cap) cap = await import(chrome.runtime.getURL("lib/captions.js"));
    if (!langs) langs = await import(chrome.runtime.getURL("lib/languages.js"));
  }

  async function loadPrefs() {
    try {
      const { prefs } = await chrome.storage.sync.get("prefs");
      if (prefs) {
        if (typeof prefs.rate === "number") state.prefs.rate = prefs.rate;
        if (typeof prefs.ytDuck === "number") state.prefs.ytDuck = prefs.ytDuck;
        if (Array.isArray(prefs.customLangs)) state.prefs.customLangs = prefs.customLangs;
        if (!state.target) state.target = prefs.ytTarget || prefs.defaultTarget || "en";
      }
    } catch {
      /* defaults stand */
    }
    if (!state.target) state.target = "en";
  }

  async function savePref(patch) {
    try {
      const { prefs } = await chrome.storage.sync.get("prefs");
      await chrome.storage.sync.set({ prefs: { ...(prefs || {}), ...patch } });
    } catch {
      /* non-fatal */
    }
  }

  const currentVideoId = () =>
    new URLSearchParams(location.search).get("v") || null;

  // YouTube plays ads through the same <video>, marking the player element.
  const isAdShowing = () => {
    const p = document.getElementById("movie_player");
    return !!p && (p.classList.contains("ad-showing") || p.classList.contains("ad-interrupting"));
  };

  function pickVoiceFor(bcp47) {
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return null;
    const want = bcp47.toLowerCase();
    const base = want.split("-")[0];
    const lang = (v) => (v.lang || "").toLowerCase();
    return (
      voices.find((v) => /^google/i.test(v.name) && lang(v) === want) ||
      voices.find((v) => lang(v) === want) ||
      voices.find((v) => /^google/i.test(v.name) && lang(v).startsWith(base)) ||
      voices.find((v) => lang(v).startsWith(base)) ||
      null
    );
  }
  window.speechSynthesis?.addEventListener?.("voiceschanged", () => {
    if (state.active) state.voice = pickVoiceFor(state.bcp47) || state.voice;
  });

  // ------------------------------------------------------------------ toast
  function toast(text, sticky = false) {
    let el = document.getElementById(TOAST_ID);
    if (!text) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement("div");
      el.id = TOAST_ID;
      el.style.cssText =
        "position:fixed;left:16px;bottom:16px;z-index:2147483647;" +
        "background:#f7f5ef;color:#2e2f2b;border:1px solid #d9d3c4;" +
        "border-radius:10px;padding:9px 14px;font:13px system-ui,sans-serif;" +
        "box-shadow:0 8px 26px rgba(60,55,40,.25);max-width:340px;";
      document.documentElement.appendChild(el);
    }
    el.textContent = text;
    clearTimeout(el._t);
    if (!sticky) el._t = setTimeout(() => el.remove(), 4000);
  }

  // ------------------------------------------------------------ dub panel
  function showPanel() {
    toast(null); // panel replaces the transient toast
    let el = document.getElementById(PANEL_ID);
    if (el) return el;
    el = document.createElement("div");
    el.id = PANEL_ID;
    el.style.cssText =
      "position:fixed;left:16px;bottom:16px;z-index:2147483647;width:300px;" +
      "background:#f7f5ef;color:#2e2f2b;border:1px solid #d9d3c4;" +
      "border-radius:12px;padding:10px 12px;font:13px system-ui,sans-serif;" +
      "box-shadow:0 10px 32px rgba(60,55,40,.3);";
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <b style="font-size:13px">VoiceOne dub</b>
        <span data-vo="status" style="flex:1;font-size:11px;color:#8d897a;text-align:right"></span>
        <button data-vo="close" title="Stop dubbing" style="border:0;background:transparent;cursor:pointer;font-size:14px;color:#2e2f2b;padding:0 2px">✕</button>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <label style="font-size:12px;color:#5a584e">Dub into</label>
        <select data-vo="lang" style="flex:1;font-size:12px;color:#3a3a34;background:#fffefa;border:1px solid #d2ccba;border-radius:7px;padding:4px 6px"></select>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <label style="font-size:12px;color:#5a584e;white-space:nowrap">Original audio</label>
        <input data-vo="duck" type="range" min="0" max="0.5" step="0.01" style="flex:1;accent-color:#44483d">
        <output data-vo="duckout" style="font-size:11px;color:#8d897a;width:32px;text-align:right"></output>
      </div>`;
    document.documentElement.appendChild(el);

    // YouTube's global shortcuts (space, arrows…) must not fire while using the panel.
    for (const evt of ["keydown", "keyup", "keypress"])
      el.addEventListener(evt, (e) => e.stopPropagation());

    el.querySelector('[data-vo="close"]').addEventListener("click", () =>
      stopDub("Dub off — original audio restored.")
    );

    const sel = el.querySelector('[data-vo="lang"]');
    for (const l of langs.mergeLanguages(state.prefs.customLangs)) {
      const opt = document.createElement("option");
      opt.value = l.code;
      opt.textContent = l.label;
      if (l.code === state.target) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => {
      state.target = sel.value;
      savePref({ ytTarget: sel.value });
      restartDub();
    });

    const duck = el.querySelector('[data-vo="duck"]');
    const duckOut = el.querySelector('[data-vo="duckout"]');
    const syncDuck = () => (duckOut.textContent = Math.round(duck.value * 100) + "%");
    duck.value = state.prefs.ytDuck;
    syncDuck();
    duck.addEventListener("input", () => {
      state.prefs.ytDuck = Number(duck.value);
      syncDuck();
      if (state.active) applyDuck();
    });
    duck.addEventListener("change", () => savePref({ ytDuck: Number(duck.value) }));
    return el;
  }

  function hidePanel() {
    document.getElementById(PANEL_ID)?.remove();
  }

  // Status line: panel when present, transient toast otherwise.
  function setStatus(text, sticky = false) {
    const s = document.querySelector(`#${PANEL_ID} [data-vo="status"]`);
    if (s) s.textContent = text || "";
    else if (text) toast(text, sticky);
  }

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
    btn.innerHTML =
      '<svg height="24" width="24" viewBox="0 0 24 24" style="pointer-events:none;display:block">' +
      '<g fill="currentColor">' +
      '<path d="M3 9v6h4l5 5V4L7 9H3z"/>' +
      '<path d="M14.5 12A4.5 4.5 0 0 0 12 8v8a4.5 4.5 0 0 0 2.5-4z"/>' +
      '<path d="M12 2.06v2.06c3.39.49 6 3.39 6 6.88s-2.61 6.39-6 6.88v2.06c4.5-.51 8-4.31 8-8.94s-3.5-8.43-8-8.94z"/>' +
      "</g></svg>";
    btn.style.cssText =
      "width:48px;height:100%;padding:0;opacity:0.9;display:inline-flex;align-items:center;justify-content:center;vertical-align:top;";
    btn.addEventListener("click", onToggle);
    controls.prepend(btn);
  }

  function setButtonState(mode) {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    btn.setAttribute("aria-pressed", String(mode === "on"));
    btn.style.color = mode === "on" ? "#3ea6ff" : "";
    btn.style.opacity = mode === "loading" ? "0.5" : "0.9";
  }

  // ------------------------------------------------------------ volume duck
  function applyDuck() {
    if (!state.video) return;
    state.applyingDuck = true;
    state.video.volume = Math.max(0, Math.min(1, state.prefs.ytDuck));
  }
  // YouTube re-writes video.volume on slider/keyboard/ad transitions, which
  // would undo our duck. Re-assert it, and treat the user's level as the new
  // baseline to restore on stop.
  function onVolumeChange() {
    if (state.applyingDuck) {
      state.applyingDuck = false;
      return;
    }
    if (!state.active || !state.video || state.inAd) return;
    state.savedVolume = state.video.volume;
    applyDuck();
  }

  // ------------------------------------------------------------ dub control
  // After an extension update/reload, scripts already injected into open tabs
  // are orphaned: chrome.runtime disappears and every extension API throws.
  const contextAlive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };

  async function onToggle() {
    if (!contextAlive()) {
      toast("VoiceOne was updated — reload this page to keep dubbing.");
      return;
    }
    if (state.preparing) return;
    if (state.active) {
      stopDub("Dub off — original audio restored.");
      return;
    }
    state.preparing = true;
    setButtonState("loading");
    const myGen = ++state.gen;
    try {
      await startDub(myGen);
    } catch (err) {
      console.warn("[VoiceOne] dub failed:", err);
      if (state.gen === myGen) {
        stopDub(null);
        toast(`VoiceOne: ${err.message || "couldn't start the dub."}`);
      }
    } finally {
      state.preparing = false;
    }
  }

  async function restartDub() {
    stopDub(null);
    await onToggle();
  }

  const superseded = (myGen, startVideoId) =>
    state.gen !== myGen || currentVideoId() !== startVideoId;

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

  async function startDub(myGen) {
    const video = document.querySelector("video.html5-main-video");
    if (!video) throw new Error("no video player found on this page.");
    if (video.duration === Infinity) throw new Error("live streams aren't supported.");

    const startVideoId = currentVideoId();
    await loadPrefs();
    await loadLibs();
    if (superseded(myGen, startVideoId)) return; // navigated/stopped during prep

    toast("Loading captions…", true);
    const tracks = await getCaptionTracks(startVideoId);
    if (superseded(myGen, startVideoId)) {
      if (state.gen === myGen) toast(null);
      return;
    }

    const track = cap.pickTrack(tracks, state.target);
    if (!track || !track.baseUrl)
      throw new Error("this video has no captions, so it can't be dubbed.");

    const cues = cap.mergeCues(await fetchCaption(track.baseUrl));
    if (superseded(myGen, startVideoId)) {
      if (state.gen === myGen) toast(null);
      return;
    }
    if (!cues.length)
      throw new Error("couldn't load captions for this video — try another video or reload the page.");

    state.video = video;
    state.cues = cues;
    state.videoId = startVideoId;
    state.bcp47 = langs.bcp47For(state.target);
    state.voice = pickVoiceFor(state.bcp47);
    state.idx = cap.findCueIndex(cues, video.currentTime * 1000);

    state.savedVolume = video.volume;
    applyDuck();

    state.active = true;
    state.inAd = isAdShowing();
    setButtonState("on");
    showPanel();

    const trackBase = (track.languageCode || "en").toLowerCase().split("-")[0];
    if (trackBase !== state.target) translateCues(myGen, trackBase);
    else setStatus(`Dubbing in ${langs.labelFor(state.target)}`);

    video.addEventListener("seeking", onSeek);
    video.addEventListener("pause", onPause);
    video.addEventListener("play", onPlay);
    video.addEventListener("volumechange", onVolumeChange);
    // timeupdate keeps cues flowing in background tabs, where setInterval is
    // throttled; the interval keeps them flowing when the video stalls.
    video.addEventListener("timeupdate", tick);
    state.timer = setInterval(tick, 200);
  }

  function stopDub(message) {
    state.gen++; // invalidate any in-flight prep/translation
    state.active = false;
    state.inAd = false;
    clearInterval(state.timer);
    state.timer = null;
    window.speechSynthesis.cancel();
    state.inflight = 0;
    if (state.video) {
      if (state.savedVolume !== null) {
        state.applyingDuck = true;
        state.video.volume = state.savedVolume;
      }
      state.video.removeEventListener("seeking", onSeek);
      state.video.removeEventListener("pause", onPause);
      state.video.removeEventListener("play", onPlay);
      state.video.removeEventListener("volumechange", onVolumeChange);
      state.video.removeEventListener("timeupdate", tick);
    }
    state.video = null;
    state.cues = [];
    state.savedVolume = null;
    setButtonState("off");
    hidePanel();
    toast(null);
    if (message) toast(message);
  }

  // ---------------------------------------------------------- dub engine
  function tick() {
    if (!state.active || !state.video) return;
    // SPA navigation to another video → stop cleanly.
    if (currentVideoId() !== state.videoId) {
      stopDub(null);
      return;
    }
    // Ads share the <video> with their own clock — never narrate over them.
    if (isAdShowing()) {
      if (!state.inAd) {
        state.inAd = true;
        window.speechSynthesis.cancel();
        state.inflight = 0;
      }
      return;
    }
    if (state.inAd) {
      state.inAd = false;
      state.idx = cap.findCueIndex(state.cues, state.video.currentTime * 1000);
    }

    const v = state.video;
    if (v.paused || v.seeking) return;
    const now = v.currentTime * 1000;

    // Skip cues whose window fully passed (e.g. while TTS lagged).
    while (state.idx < state.cues.length && state.cues[state.idx].end < now - 300)
      state.idx++;

    if (state.idx < state.cues.length && state.cues[state.idx].start <= now) {
      const cue = state.cues[state.idx];
      state.idx++;
      if (cue.text) speak(cue, now);
    }
  }

  function speak(cue, nowMs) {
    const synth = window.speechSynthesis;
    // Let one utterance queue behind the current one — cancelling on every new
    // cue chopped words mid-utterance (the stutter). Only when we fall 2+
    // utterances behind do we drop the backlog and jump to stay in sync.
    if (state.inflight >= 2) {
      synth.cancel();
      state.inflight = 0;
    }

    const pbr = state.video.playbackRate || 1;
    const availMs = Math.max((cue.end - nowMs) / pbr, 600);
    const estMs = cue.text.length * MS_PER_CHAR;
    const needed = estMs / availMs;
    // Cap at 2× — beyond that most voices garble, which reads as stutter too.
    const rate = Math.min(Math.max(state.prefs.rate, needed), 2);

    const u = new SpeechSynthesisUtterance(cue.text);
    if (state.voice) u.voice = state.voice;
    u.lang = state.bcp47;
    u.rate = rate;
    u.volume = 1;
    u.onend = u.onerror = () => {
      state.inflight = Math.max(0, state.inflight - 1);
    };
    state.inflight++;
    synth.speak(u);
  }

  function onSeek() {
    window.speechSynthesis.cancel();
    state.inflight = 0;
    if (!state.active || !state.video || !cap) return;
    state.idx = cap.findCueIndex(state.cues, state.video.currentTime * 1000);
  }
  function onPause() {
    window.speechSynthesis.cancel();
    state.inflight = 0;
  }
  function onPlay() {
    if (!state.active || !state.video || !cap || isAdShowing()) return;
    state.idx = cap.findCueIndex(state.cues, state.video.currentTime * 1000);
  }

  // ------------------------------------------------------- translation
  async function translateCues(myGen, sourceLang) {
    const cues = state.cues; // captured — a later dub gets its own fresh array
    const target = state.target;
    // Keep originals; clear text so untranslated cues aren't spoken yet.
    for (const c of cues) {
      c.orig = c.orig || c.text;
      c.text = null;
    }
    // Translate from the playhead forward first, then wrap to the start.
    const order = [];
    for (let i = state.idx; i < cues.length; i++) order.push(i);
    for (let i = 0; i < state.idx; i++) order.push(i);

    const CHUNK = 20;
    let done = 0;
    for (let at = 0; at < order.length; at += CHUNK) {
      if (state.gen !== myGen) return; // superseded before this chunk
      const slice = order.slice(at, at + CHUNK);
      const res = await sendTranslate(sourceLang, target, slice.map((i) => cues[i].orig));
      if (state.gen !== myGen) return; // superseded during the await
      if (!res?.ok) {
        stopDub(`VoiceOne: translation failed — ${res?.error || "unknown error"}`);
        return;
      }
      slice.forEach((cueIdx, k) => {
        cues[cueIdx].text = res.texts[k];
      });
      done += slice.length;
      const pct = Math.round((done / order.length) * 100);
      if (pct < 100) setStatus(`Translating… ${pct}%`, true);
    }
    if (state.active) setStatus(`Dubbing in ${langs.labelFor(target)}`);
  }

  // One retry covers a transient service-worker restart during the first
  // (model-download) chunk.
  async function sendTranslate(source, target, texts) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await chrome.runtime.sendMessage({
          ns: "voiceone",
          from: "yt",
          action: "yt-translate",
          source,
          target,
          texts,
        });
        if (res?.ok) return res;
        if (attempt === 1) return res || { ok: false, error: "no response" };
      } catch (err) {
        if (attempt === 1)
          return { ok: false, error: err.message || "extension unavailable — reload the page" };
      }
    }
  }

  // ------------------------------------------------- popup remote control
  // Distinct namespace from "voiceone" so the service worker's router ignores
  // these; they travel popup → this tab's content script only.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.ns !== "voiceone-yt") return;
    if (msg.cmd === "state") {
      loadPrefs().then(() =>
        sendResponse({
          watch: location.pathname === "/watch",
          active: state.active,
          preparing: state.preparing,
          target: state.target || "en",
          duck: state.prefs.ytDuck,
          customLangs: state.prefs.customLangs,
        })
      );
      return true; // async response
    }
    if (msg.cmd === "toggle") {
      onToggle();
      sendResponse({ ok: true });
    } else if (msg.cmd === "lang") {
      state.target = msg.code;
      savePref({ ytTarget: msg.code });
      if (state.active || state.preparing) restartDub();
      sendResponse({ ok: true });
    } else if (msg.cmd === "duck") {
      state.prefs.ytDuck = Number(msg.value);
      if (state.active) applyDuck();
      if (msg.persist) savePref({ ytDuck: state.prefs.ytDuck });
      const panelDuck = document.querySelector(`#${PANEL_ID} [data-vo="duck"]`);
      if (panelDuck) {
        panelDuck.value = state.prefs.ytDuck;
        panelDuck.dispatchEvent(new Event("input"));
      }
      sendResponse({ ok: true });
    }
  });

  // ------------------------------------------------- SPA navigation glue
  document.addEventListener("yt-navigate-finish", () => {
    if (state.active || state.preparing) stopDub(null);
    ensureButton();
  });
  // Cheap idempotent poll (getElementById early-return) — more robust than a
  // subtree MutationObserver on YouTube's constantly-mutating DOM.
  setInterval(ensureButton, 1500);
  ensureButton();
})();
