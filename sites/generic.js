// sites/generic.js — VoiceOne's generic site adapter for dubbing.
// Registered at runtime (chrome.scripting.registerContentScripts) for origins
// the user explicitly enabled via the popup. Works on any site that exposes
// captions the standard HTML5 way: <track> elements / video.textTracks — the
// browser parses the VTT, we just read the cues. Sites that hide captions
// behind their own APIs need a dedicated adapter instead.
//
// There is no on-page start button here — the toolbar popup is the trigger
// (ns "voiceone-yt" remote control, same protocol as the YouTube adapter).

(() => {
  "use strict";
  if (window.__voiceOneDub) return;
  window.__voiceOneDub = true;

  const contextAlive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };

  // Largest rendered <video> is the main player.
  function getVideo() {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll("video")) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) {
        bestArea = area;
        best = v;
      }
    }
    return best;
  }

  // VTT cue payloads may carry voice/format tags and sound markers.
  const cleanCueText = (s) =>
    String(s || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\[[^\]]*\]|♪+/g, " ")
      .replace(/>>+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  let cap = null; // lib/captions.js exports
  let flippedTrack = null; // track we switched disabled → hidden; restore on stop

  // ------------------------------------------------- site-specific getCues
  // Sites that hide captions behind their own APIs instead of HTML5 tracks.
  // Each returns { cues, sourceLang } like the base adapter, throwing
  // user-facing errors. Everything else (video lookup, ducking, panel) stays
  // shared. Spike findings per site are noted inline — they're load-bearing.

  const langBase = (l) => String(l || "").toLowerCase().replace(/^ai-/, "").split("-")[0];
  const pickByLang = (list, getLang, target) =>
    list.find((t) => langBase(getLang(t)) === String(target).toLowerCase()) || list[0];

  // Vimeo: player config JSON lists per-language VTT tracks; both the config
  // and captions.vimeo.com are CORS-open from vimeo.com (verified live).
  async function vimeoGetCues(target, isSuperseded) {
    const m = location.pathname.match(/\/(\d{6,})/);
    if (!m) throw new Error("open a Vimeo video page to dub.");
    const cfg = await (await fetch(`https://player.vimeo.com/video/${m[1]}/config`)).json();
    if (isSuperseded()) return null;
    const tracks = cfg?.request?.text_tracks || [];
    if (!tracks.length) throw new Error("this video has no captions, so it can't be dubbed.");
    const track = pickByLang(tracks, (t) => t.lang, target);
    const url = track.url.startsWith("http") ? track.url : "https://player.vimeo.com" + track.url;
    const cues = cap.mergeCues(cap.parseVttOrSrt(await (await fetch(url)).text()));
    if (isSuperseded()) return null;
    if (!cues.length) throw new Error("couldn't read this video's captions — try reloading the page.");
    return { cues, sourceLang: langBase(track.lang) || target };
  }

  // Dailymotion: the player lives in a cross-origin geo.dailymotion.com
  // iframe, so THIS SCRIPT RUNS INSIDE THAT FRAME (registered allFrames with
  // both origins). The frame's ?video= param names the video, and the
  // www.dailymotion.com metadata endpoint is CORS-open from the frame
  // (verified live). Subtitle files are SRT on their CDN, CORS-open.
  async function dailymotionGetCues(target, isSuperseded) {
    const id = new URLSearchParams(location.search).get("video");
    if (!id) throw new Error("couldn't identify the Dailymotion video in this player.");
    const meta = await (
      await fetch("https://www.dailymotion.com/player/metadata/video/" + id)
    ).json();
    if (isSuperseded()) return null;
    const subs = meta?.subtitles?.data || {};
    const langs = Object.keys(subs);
    if (!langs.length) throw new Error("this video has no captions, so it can't be dubbed.");
    const lang = pickByLang(langs, (l) => l, target);
    const url = subs[lang]?.urls?.[0];
    if (!url) throw new Error("this video's captions couldn't be located.");
    const cues = cap.mergeCues(cap.parseVttOrSrt(await (await fetch(url)).text()));
    if (isSuperseded()) return null;
    if (!cues.length) throw new Error("couldn't read this video's captions — try reloading the page.");
    return { cues, sourceLang: langBase(lang) || target };
  }

  // Bilibili: view API resolves bvid → cid, player API lists CC subtitle
  // JSON. Uses the tab's own session (subtitle URLs are login-gated for many
  // videos); "ai-" prefixed lan codes are Bilibili's auto-generated tracks.
  async function bilibiliGetCues(target, isSuperseded) {
    const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
    if (!m) throw new Error("open a Bilibili video page to dub.");
    const bvid = m[1];
    const view = await (
      await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { credentials: "include" })
    ).json();
    const cid = view?.data?.cid;
    if (!cid) throw new Error("couldn't load this Bilibili video's details.");
    const player = await (
      await fetch(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`, { credentials: "include" })
    ).json();
    if (isSuperseded()) return null;
    const subs = player?.data?.subtitle?.subtitles || [];
    if (!subs.length)
      throw new Error("no subtitles on this video (Bilibili often requires being logged in to see them).");
    const sub = pickByLang(subs, (s) => s.lan, target);
    let url = sub.subtitle_url || "";
    if (url.startsWith("//")) url = "https:" + url;
    if (!url) throw new Error("this video's subtitles couldn't be located — try logging into Bilibili.");
    const cues = cap.mergeCues(cap.parseBilibiliSubtitle(await (await fetch(url)).json()));
    if (isSuperseded()) return null;
    if (!cues.length) throw new Error("couldn't read this video's subtitles — try reloading the page.");
    return { cues, sourceLang: langBase(sub.lan) || target };
  }

  function siteGetCues() {
    const h = location.hostname;
    if (h === "geo.dailymotion.com" || /(^|\.)dailymotion\.com$/.test(h)) return dailymotionGetCues;
    if (/(^|\.)vimeo\.com$/.test(h)) return vimeoGetCues;
    if (/(^|\.)bilibili\.com$/.test(h)) return bilibiliGetCues;
    return null; // unknown site → base adapter reads HTML5 textTracks
  }

  const adapter = {
    getVideo,
    // SPA sites change the URL per video; same-URL video swaps are out of scope.
    videoKey: () => location.pathname + location.search,
    isAdShowing: () => false,
    // No on-page button; the popup reflects state via snapshots. Used here to
    // put a track we enabled back the way the site had it.
    onStateChange: (mode) => {
      if (mode === "off" && flippedTrack) {
        flippedTrack.mode = "disabled";
        flippedTrack = null;
      }
    },
    async getCues(target, isSuperseded) {
      const impl = siteGetCues();
      if (impl) return impl(target, isSuperseded);
      const video = getVideo();
      if (!video) throw new Error("no video player found on this page.");
      const tracks = [...(video.textTracks || [])].filter((t) =>
        ["subtitles", "captions"].includes(t.kind)
      );
      if (!tracks.length)
        throw new Error("no captions found on this page — this site may need its own adapter.");

      const tgt = String(target).toLowerCase();
      const track =
        tracks.find((t) => (t.language || "").toLowerCase().split("-")[0] === tgt) || tracks[0];

      // Cues only populate once the track is enabled; "hidden" parses without rendering.
      if (track.mode === "disabled") {
        track.mode = "hidden";
        flippedTrack = track;
      }
      const deadline = Date.now() + 4000;
      while ((!track.cues || !track.cues.length) && Date.now() < deadline) {
        if (isSuperseded()) return null;
        await new Promise((r) => setTimeout(r, 150));
      }
      if (!track.cues || !track.cues.length)
        throw new Error(
          "captions on this page never loaded (cross-origin tracks without CORS can't be read)."
        );

      const cues = cap.mergeCues(
        [...track.cues]
          .map((c) => ({
            start: c.startTime * 1000,
            end: c.endTime * 1000,
            text: cleanCueText(c.text),
          }))
          .filter((c) => c.text)
      );
      if (isSuperseded()) return null;
      if (!cues.length) throw new Error("couldn't read any caption text on this page.");

      // Unknown track language → assume it's already the target (skipping
      // translation beats mis-translating from a guessed language).
      const sourceLang = (track.language || "").split("-")[0].toLowerCase() || target;
      return { cues, sourceLang };
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

  // Popup remote control — same protocol as the YouTube adapter. Registered
  // synchronously at injection; handlers await the engine.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.ns !== "voiceone-yt") return;
    // On allFrames sites (e.g. Dailymotion) this script runs in every frame,
    // and tabs.sendMessage reaches all of them — only the frame that actually
    // holds the video answers, so the popup talks to the right one.
    if (!getVideo()) return;
    (async () => {
      const engine = await bootPromise;
      if (msg.cmd === "state") {
        sendResponse({ watch: !!getVideo(), ...(await engine.stateSnapshot()) });
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

  // SPA navigation: stop the dub when the URL no longer matches the dubbed video.
  // (The engine's own tick also detects videoKey changes; this just cleans up
  // when the video element is torn down between pages.)
  let lastKey = adapter.videoKey();
  setInterval(() => {
    const key = adapter.videoKey();
    if (key === lastKey) return;
    lastKey = key;
    if (!contextAlive()) return;
    bootPromise
      .then((engine) => {
        if (engine.active || engine.preparing) engine.stop(null);
      })
      .catch(() => {});
  }, 1500);
})();
