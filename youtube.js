// youtube.js — VoiceOne's one-click YouTube dub (content script).
// Adds a button to the YouTube player. On click: fetch the video's caption
// track, translate it to English on-device if needed (via the service worker),
// duck the original audio, and narrate the captions in clear English with
// speechSynthesis, kept in sync with the video clock.
//
// Classic (non-module) content script: shared helpers are pulled in with a
// dynamic import of lib/captions.js (declared web-accessible in the manifest).

(() => {
  "use strict";
  if (window.__voiceOneTube) return;
  window.__voiceOneTube = true;

  const BTN_ID = "voiceone-dub-btn";
  const TOAST_ID = "voiceone-yt-toast";
  const MS_PER_CHAR = 62; // ≈16 chars/sec at TTS rate 1.0

  let lib = null; // lazy-loaded lib/captions.js module
  let cap = null; // its exports, cached for synchronous use once a dub is live
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
    voice: null,
    prefs: { rate: 1.0, ytDuck: 0.12 },
    videoId: null, // which video the cues belong to
  };

  // ------------------------------------------------------------------ utils
  async function getLib() {
    if (!lib) lib = await import(chrome.runtime.getURL("lib/captions.js"));
    return lib;
  }

  async function loadPrefs() {
    try {
      const { prefs } = await chrome.storage.sync.get("prefs");
      if (prefs) {
        if (typeof prefs.rate === "number") state.prefs.rate = prefs.rate;
        if (typeof prefs.ytDuck === "number") state.prefs.ytDuck = prefs.ytDuck;
      }
    } catch {
      /* defaults stand */
    }
  }

  const currentVideoId = () =>
    new URLSearchParams(location.search).get("v") || null;

  // YouTube plays ads through the same <video>, marking the player element.
  const isAdShowing = () => {
    const p = document.getElementById("movie_player");
    return !!p && (p.classList.contains("ad-showing") || p.classList.contains("ad-interrupting"));
  };

  function pickVoice() {
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return null;
    return (
      voices.find((v) => /Google US English/i.test(v.name)) ||
      voices.find((v) => (v.lang || "").toLowerCase() === "en-us") ||
      voices.find((v) => (v.lang || "").toLowerCase().startsWith("en")) ||
      null
    );
  }
  window.speechSynthesis?.addEventListener?.("voiceschanged", () => {
    if (!state.voice) state.voice = pickVoice();
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

  // ----------------------------------------------------------------- button
  function ensureButton() {
    if (location.pathname !== "/watch") return;
    if (document.getElementById(BTN_ID)) return;
    const controls = document.querySelector(".ytp-right-controls");
    if (!controls) return;

    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.className = "ytp-button";
    btn.title = "VoiceOne — dub in clear English";
    btn.setAttribute("aria-pressed", "false");
    // Fixed 24px speaker glyph, flex-centered like YouTube's own control buttons.
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
  async function onToggle() {
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

  const superseded = (myGen, startVideoId) =>
    state.gen !== myGen || currentVideoId() !== startVideoId;

  // The caption URLs in the page's own player data are gated behind a
  // proof-of-origin token since 2025 and return HTTP 200 with an EMPTY body
  // when fetched outside YouTube's player. The InnerTube API queried as the
  // ANDROID client returns caption URLs that still work, so ask it first and
  // keep the page's player response only as a fallback for track listing.
  // The page embeds a visitorData token; sending it (plus the tab's own
  // youtube.com cookies) lets the InnerTube call pass YouTube's bot check.
  function getVisitorData() {
    for (const s of document.getElementsByTagName("script")) {
      const m = /"visitorData":"([^"]+)"/.exec(s.textContent || "");
      if (m) return m[1];
    }
    return null;
  }

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
    cap = await getLib();
    if (superseded(myGen, startVideoId)) return; // navigated/stopped during prep

    toast("Loading captions…", true);
    const tracks = await getCaptionTracks(startVideoId);
    if (superseded(myGen, startVideoId)) {
      if (state.gen === myGen) toast(null);
      return;
    }

    const track = cap.pickTrack(tracks);
    if (!track || !track.baseUrl)
      throw new Error("this video has no captions, so it can't be dubbed.");

    const cues = await fetchCaption(track.baseUrl);
    if (superseded(myGen, startVideoId)) {
      if (state.gen === myGen) toast(null);
      return;
    }
    if (!cues.length)
      throw new Error("couldn't load captions for this video — try another video or reload the page.");

    state.video = video;
    state.cues = cues;
    state.videoId = startVideoId;
    state.voice = state.voice || pickVoice();
    state.idx = cap.findCueIndex(cues, video.currentTime * 1000);

    state.savedVolume = video.volume;
    applyDuck();

    state.active = true;
    state.inAd = isAdShowing();
    setButtonState("on");

    const lang = (track.languageCode || "en").toLowerCase();
    if (!lang.startsWith("en")) translateCues(myGen, lang);
    else toast("Dubbing in clear English — click the button again to stop.");

    video.addEventListener("seeking", onSeek);
    video.addEventListener("pause", onPause);
    video.addEventListener("play", onPlay);
    video.addEventListener("volumechange", onVolumeChange);
    state.timer = setInterval(tick, 200);
  }

  function stopDub(message) {
    state.gen++; // invalidate any in-flight prep/translation
    state.active = false;
    state.inAd = false;
    clearInterval(state.timer);
    state.timer = null;
    window.speechSynthesis.cancel();
    if (state.video) {
      if (state.savedVolume !== null) {
        state.applyingDuck = true;
        state.video.volume = state.savedVolume;
      }
      state.video.removeEventListener("seeking", onSeek);
      state.video.removeEventListener("pause", onPause);
      state.video.removeEventListener("play", onPlay);
      state.video.removeEventListener("volumechange", onVolumeChange);
    }
    state.video = null;
    state.cues = [];
    state.savedVolume = null;
    setButtonState("off");
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
    // Keep sync over completeness: a lagging utterance yields to the next cue.
    if (synth.speaking || synth.pending) synth.cancel();

    const pbr = state.video.playbackRate || 1;
    const availMs = Math.max((cue.end - nowMs) / pbr, 500);
    const estMs = cue.text.length * MS_PER_CHAR;
    const needed = estMs / availMs;
    const rate = Math.min(Math.max(state.prefs.rate, needed), 2.5);

    const u = new SpeechSynthesisUtterance(cue.text);
    if (state.voice) u.voice = state.voice;
    u.lang = "en-US";
    u.rate = rate;
    u.volume = 1;
    synth.speak(u);
  }

  function onSeek() {
    window.speechSynthesis.cancel();
    if (!state.active || !state.video || !cap) return;
    state.idx = cap.findCueIndex(state.cues, state.video.currentTime * 1000);
  }
  function onPause() {
    window.speechSynthesis.cancel();
  }
  function onPlay() {
    if (!state.active || !state.video || !cap || isAdShowing()) return;
    state.idx = cap.findCueIndex(state.cues, state.video.currentTime * 1000);
  }

  // ------------------------------------------------------- translation
  async function translateCues(myGen, sourceLang) {
    const cues = state.cues; // captured — a later dub gets its own fresh array
    // Keep originals; clear text so untranslated cues aren't spoken yet.
    for (const c of cues) {
      c.orig = c.text;
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
      const res = await sendTranslate(sourceLang, slice.map((i) => cues[i].orig));
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
      if (pct < 100) toast(`Translating captions on-device… ${pct}%`, true);
    }
    if (state.active) toast("Dubbing in clear English — click the button again to stop.");
  }

  // One retry covers a transient service-worker restart during the first
  // (model-download) chunk.
  async function sendTranslate(source, texts) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await chrome.runtime.sendMessage({
          ns: "voiceone",
          from: "yt",
          action: "yt-translate",
          source,
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
