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

  const adapter = {
    getVideo,
    // SPA sites change the URL per video; same-URL video swaps are out of scope.
    videoKey: () => location.pathname + location.search,
    isAdShowing: () => false,
    onStateChange: null, // no on-page button; the popup reflects state via snapshots
    async getCues(target, isSuperseded) {
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
      if (track.mode === "disabled") track.mode = "hidden";
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
  const bootPromise = (async () => {
    cap = await import(chrome.runtime.getURL("lib/captions.js"));
    const { createDubEngine } = await import(chrome.runtime.getURL("lib/dub-engine.js"));
    return createDubEngine(adapter);
  })();
  bootPromise.catch((err) => console.warn("[VoiceOne] engine failed to load:", err));

  // Popup remote control — same protocol as the YouTube adapter. Registered
  // synchronously at injection; handlers await the engine.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.ns !== "voiceone-yt") return;
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
