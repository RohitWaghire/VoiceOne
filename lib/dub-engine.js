// lib/dub-engine.js — the site-agnostic dubbing engine.
// Everything here works the same on any video site: cue scheduling, volume
// duck, the floating dub panel, translation batching, and the popup remote
// API. Site-specific knowledge (how to find the video, how to fetch captions,
// how ads are marked) comes in through an adapter:
//
//   createDubEngine(adapter, helpers)
//   adapter: {
//     getVideo(): HTMLVideoElement | null
//     videoKey(): string | null           // identity of the current video; a
//                                         // change means SPA-navigated away
//     isAdShowing(): boolean
//     onStateChange(mode)                 // "on" | "off" | "loading" — site
//                                         // button feedback (optional)
//     getCues(target, isSuperseded): Promise<{cues, sourceLang} | null>
//         // resolve null if isSuperseded() told you to abort;
//         // throw Error(userFacingMessage) when captions can't be had
//   }
//   helpers: { findCueIndex, bcp47For, labelFor, mergeLanguages } — from
//     lib/captions.js / lib/languages.js, passed in by the caller.
//
// MUST STAY A LEAF MODULE (no import statements): content scripts load it via
// import(chrome.runtime.getURL(...)) under use_dynamic_url, and Chrome fails
// the sub-import fetches of a module graph loaded through a dynamic WAR URL
// ("Failed to fetch dynamically imported module"). Leaf modules import fine —
// which is why the callers import captions/languages themselves and hand the
// helpers in.

const TOAST_ID = "voiceone-yt-toast";
const PANEL_ID = "voiceone-yt-panel";
const MS_PER_CHAR = 62; // seed estimate, ≈16 chars/sec at TTS rate 1.0 — calibrated live per voice
const RATE_STEP = 0.15; // max speaking-rate change between consecutive utterances
const LAG_MAX = 4000; // how far narration may trail the video before cues get dropped

export function createDubEngine(adapter, { findCueIndex, bcp47For, labelFor, mergeLanguages }) {
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
    uttering: false, // an utterance is in flight — set false at every cancel site
    liveRate: null, // smoothed speaking rate (drifts toward what sync needs)
    msPerChar: MS_PER_CHAR, // per-voice speed estimate, calibrated from real utterances
    voice: null,
    target: null, // dub language (base code, e.g. "en"); null until prefs load
    bcp47: "en-US",
    prefs: { rate: 1.0, ytDuck: 0.12, customLangs: [] },
    videoKey: null, // which video the cues belong to
  };

  // ------------------------------------------------------------------ utils
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

    // The host page's global shortcuts (space, arrows…) must not fire while using the panel.
    for (const evt of ["keydown", "keyup", "keypress"])
      el.addEventListener(evt, (e) => e.stopPropagation());

    el.querySelector('[data-vo="close"]').addEventListener("click", () =>
      stopDub("Dub off — original audio restored.")
    );

    const sel = el.querySelector('[data-vo="lang"]');
    for (const l of mergeLanguages(state.prefs.customLangs)) {
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

  // ------------------------------------------------------------ volume duck
  function applyDuck() {
    if (!state.video) return;
    const duck = Math.max(0, Math.min(1, state.prefs.ytDuck));
    // A same-value write fires no volumechange event, which would leave the
    // applyingDuck flag stale and swallow the next genuine user volume event.
    if (Math.abs(state.video.volume - duck) < 0.001) return;
    state.applyingDuck = true;
    state.video.volume = duck;
  }
  // Sites re-write video.volume on slider/keyboard/ad transitions, which
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
    adapter.onStateChange?.("loading");
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
      // Only the generation that owns the flag may clear it — a superseded
      // prep must not clear the flag of the restart that replaced it.
      if (state.gen === myGen) state.preparing = false;
    }
  }

  async function restartDub() {
    stopDub(null);
    await onToggle();
  }

  const superseded = (myGen, startKey) =>
    state.gen !== myGen || adapter.videoKey() !== startKey;

  async function startDub(myGen) {
    const video = adapter.getVideo();
    if (!video) throw new Error("no video player found on this page.");
    if (video.duration === Infinity) throw new Error("live streams aren't supported.");

    const startKey = adapter.videoKey();
    await loadPrefs();
    if (superseded(myGen, startKey)) return; // navigated/stopped during prep

    toast("Loading captions…", true);
    const got = await adapter.getCues(state.target, () => superseded(myGen, startKey));
    if (got === null || superseded(myGen, startKey)) {
      if (state.gen === myGen) toast(null);
      return;
    }
    const { cues, sourceLang } = got;

    state.video = video;
    state.cues = cues;
    state.videoKey = startKey;
    state.bcp47 = bcp47For(state.target);
    state.voice = pickVoiceFor(state.bcp47);
    state.idx = findCueIndex(cues, video.currentTime * 1000);

    state.savedVolume = video.volume;
    applyDuck();

    state.active = true;
    state.inAd = adapter.isAdShowing();
    adapter.onStateChange?.("on");
    showPanel();

    if (sourceLang !== state.target) translateCues(myGen, sourceLang);
    else setStatus(`Dubbing in ${labelFor(state.target)}`);

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
    state.preparing = false; // the invalidated prep no longer owns the flag
    state.inAd = false;
    clearInterval(state.timer);
    state.timer = null;
    window.speechSynthesis.cancel();
    state.uttering = false;
    state.liveRate = null; // next dub starts back at the user's configured rate
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
    adapter.onStateChange?.("off");
    hidePanel();
    toast(null);
    if (message) toast(message);
  }

  // ---------------------------------------------------------- dub engine
  function tick() {
    if (!state.active || !state.video) return;
    // SPA navigation to another video → stop cleanly.
    if (adapter.videoKey() !== state.videoKey) {
      stopDub(null);
      return;
    }
    // Ads share the <video> with their own clock — never narrate over them.
    if (adapter.isAdShowing()) {
      if (!state.inAd) {
        state.inAd = true;
        window.speechSynthesis.cancel();
        state.uttering = false;
      }
      return;
    }
    if (state.inAd) {
      state.inAd = false;
      state.idx = findCueIndex(state.cues, state.video.currentTime * 1000);
    }

    const v = state.video;
    if (v.paused || v.seeking) return;
    const now = v.currentTime * 1000;

    // Drop only cues that are too stale to be worth speaking. The tolerance is
    // LAG_MAX (not ~0) because translated speech is often longer than the
    // original — dense zh→en subtitles overrun chronically — and trailing the
    // video a few seconds like an interpreter reads far better than dropping
    // every cue the moment its window passes.
    while (state.idx < state.cues.length && state.cues[state.idx].end < now - LAG_MAX)
      state.idx++;

    if (state.idx < state.cues.length && state.cues[state.idx].start <= now) {
      // Never interrupt the current utterance — chopped words read as stutter.
      // The cue stays pending; when the utterance ends we chain straight back
      // here, and truly stale cues are dropped whole by the skip loop above.
      if (state.uttering) return;
      const cue = state.cues[state.idx];
      state.idx++;
      if (cue.text) speak(cue, now);
    }
  }

  function speak(cue, nowMs) {
    const pbr = state.video.playbackRate || 1;
    // Budget: from now to the end of this cue's claim on the timeline — its own
    // end, or the next cue's start when there's a gap to spill into. When
    // running late, never let the budget collapse below the cue's own duration:
    // pacing "one cue's worth of speech per cue" keeps the rate near the real
    // translation-expansion factor and holds the lag steady (the tick skip loop
    // bounds it at LAG_MAX). A collapsing budget is what pinned the rate at the
    // 2× cap on Bilibili's dense zh→en cues — audible as mumbling.
    const next = state.cues[state.idx]; // idx already points past `cue`
    const claimEnd = Math.max(cue.end, next ? next.start : 0);
    const availMs = Math.max(
      (claimEnd - nowMs) / pbr,
      (cue.end - cue.start) / pbr,
      600
    );
    const estMs = cue.text.length * state.msPerChar;
    const needed = estMs / availMs;
    // Baseline is the user's rate; only climb when genuinely behind, capped at
    // 2× (beyond that most voices garble). Move at most ±RATE_STEP per
    // utterance so the voice never jumps speeds between sentences.
    const target = Math.min(Math.max(state.prefs.rate, needed), 2);
    const prev = state.liveRate ?? state.prefs.rate;
    const rate = Math.max(prev - RATE_STEP, Math.min(prev + RATE_STEP, target));
    state.liveRate = rate;

    const u = new SpeechSynthesisUtterance(cue.text);
    if (state.voice) u.voice = state.voice;
    u.lang = state.bcp47;
    u.rate = rate;
    u.volume = 1;
    let startedAt = 0;
    u.onstart = () => {
      startedAt = performance.now();
    };
    u.onend = u.onerror = (e) => {
      state.uttering = false;
      // Calibrate how fast this voice actually speaks (ms per char at rate 1)
      // so `needed` stops being systematically wrong for slow/fast voices.
      if (startedAt && e?.type === "end" && cue.text.length >= 8) {
        const measured = ((performance.now() - startedAt) * rate) / cue.text.length;
        if (measured > 20 && measured < 200)
          state.msPerChar = state.msPerChar * 0.7 + measured * 0.3;
      }
      if (state.active) tick(); // chain into the next due cue without waiting for the interval
    };
    state.uttering = true;
    window.speechSynthesis.speak(u);
  }

  function onSeek() {
    window.speechSynthesis.cancel();
    state.uttering = false;
    if (!state.active || !state.video) return;
    state.idx = findCueIndex(state.cues, state.video.currentTime * 1000);
  }
  function onPause() {
    window.speechSynthesis.cancel();
    state.uttering = false;
  }
  function onPlay() {
    if (!state.active || !state.video || adapter.isAdShowing()) return;
    state.idx = findCueIndex(state.cues, state.video.currentTime * 1000);
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
    if (state.active) setStatus(`Dubbing in ${labelFor(target)}`);
  }

  // One retry covers a transient service-worker restart during the first
  // (model-download) chunk.
  async function sendTranslate(source, target, texts) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await chrome.runtime.sendMessage({
          ns: "voiceone",
          from: "dub",
          action: "dub-translate",
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

  // ------------------------------------------------------- popup remote API
  async function stateSnapshot() {
    await loadPrefs();
    return {
      active: state.active,
      preparing: state.preparing,
      target: state.target || "en",
      duck: state.prefs.ytDuck,
      customLangs: state.prefs.customLangs,
    };
  }

  function setTarget(code) {
    state.target = code;
    savePref({ ytTarget: code });
    if (state.active || state.preparing) restartDub();
  }

  function setDuck(value, persist) {
    state.prefs.ytDuck = Number(value);
    if (state.active) applyDuck();
    if (persist) savePref({ ytDuck: state.prefs.ytDuck });
    const panelDuck = document.querySelector(`#${PANEL_ID} [data-vo="duck"]`);
    if (panelDuck) {
      panelDuck.value = state.prefs.ytDuck;
      panelDuck.dispatchEvent(new Event("input"));
    }
  }

  return {
    toggle: onToggle,
    stop: stopDub,
    stateSnapshot,
    setTarget,
    setDuck,
    get active() {
      return state.active;
    },
    get preparing() {
      return state.preparing;
    },
  };
}
