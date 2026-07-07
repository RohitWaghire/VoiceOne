// lib/captions.js
// Pure helpers for YouTube caption handling: extract the player response from a
// watch-page's HTML, choose the best caption track, and parse the json3 timed
// text format into speakable cues. No chrome.* / DOM access — Node-testable.

// Extract the ytInitialPlayerResponse JSON object embedded in watch-page HTML.
// Uses string-aware brace counting instead of a regex so nested braces and
// quoted "}" inside the JSON don't break extraction.
export function extractPlayerResponse(html) {
  const marker = "ytInitialPlayerResponse";
  let from = 0;
  while (true) {
    const at = html.indexOf(marker, from);
    if (at < 0) return null;
    const eq = html.indexOf("=", at + marker.length);
    // must be an assignment right after the identifier (allow whitespace)
    if (eq < 0) return null;
    if (html.slice(at + marker.length, eq).trim() !== "") {
      from = at + marker.length;
      continue;
    }
    const start = html.indexOf("{", eq);
    if (start < 0) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < html.length; i++) {
      const c = html[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') {
        inStr = true;
      } else if (c === "{") {
        depth++;
      } else if (c === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(html.slice(start, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }
}

export function listCaptionTracks(playerResponse) {
  return (
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || []
  );
}

const isEnglish = (t) => (t.languageCode || "").toLowerCase().startsWith("en");
const isAuto = (t) => t.kind === "asr";

// Preference order: manual English > auto English > manual any > any.
export function pickTrack(tracks) {
  if (!tracks || !tracks.length) return null;
  return (
    tracks.find((t) => isEnglish(t) && !isAuto(t)) ||
    tracks.find((t) => isEnglish(t)) ||
    tracks.find((t) => !isAuto(t)) ||
    tracks[0]
  );
}

// Parse YouTube's json3 timed-text into [{start, end, text}] (ms).
// Handles both manual tracks (one seg per event) and ASR tracks (word-level
// segs, "\n" filler events, rolling window duplicates).
export function parseJson3(json) {
  const events = json?.events || [];
  const raw = [];
  for (const ev of events) {
    if (!ev.segs || typeof ev.tStartMs !== "number") continue;
    const text = ev.segs
      .map((s) => s.utf8 || "")
      .join("")
      .replace(/\[[^\]]*\]/g, " ") // drop [Music]/[Applause]/[Laughter] sound-event tags
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    raw.push({
      start: ev.tStartMs,
      end: ev.tStartMs + (ev.dDurationMs || 3000),
      text,
    });
  }
  raw.sort((a, b) => a.start - b.start);

  const cues = [];
  for (const cue of raw) {
    const prev = cues[cues.length - 1];
    // Drop rolling-window repeats of the same line.
    if (prev && prev.text === cue.text && cue.start - prev.start < 5000) {
      prev.end = Math.max(prev.end, cue.end);
      continue;
    }
    cues.push(cue);
  }
  // Never let a cue's window run into the next cue (overlap → double speech).
  for (let i = 0; i < cues.length - 1; i++) {
    cues[i].end = Math.min(cues[i].end, cues[i + 1].start);
    if (cues[i].end <= cues[i].start) cues[i].end = cues[i].start + 200;
  }
  return cues;
}

// First cue index whose window hasn't fully passed at time `ms` (binary search).
export function findCueIndex(cues, ms) {
  let lo = 0;
  let hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].end <= ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function decodeXml(s) {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

// Parse the default / srv3 timed-text XML into cues — used as a fallback when
// the json3 format returns an empty body.
export function parseTimedTextXml(xml) {
  const cues = [];
  const re = /<text\s+([^>]*)>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(xml))) {
    const sm = /\bstart="([\d.]+)"/.exec(m[1]);
    if (!sm) continue;
    const dm = /\bdur="([\d.]+)"/.exec(m[1]);
    const start = parseFloat(sm[1]) * 1000;
    const dur = dm ? parseFloat(dm[1]) * 1000 : 3000;
    const text = decodeXml(m[2]).replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    cues.push({ start, end: start + dur, text });
  }
  cues.sort((a, b) => a.start - b.start);
  for (let i = 0; i < cues.length - 1; i++) {
    cues[i].end = Math.min(cues[i].end, cues[i + 1].start);
    if (cues[i].end <= cues[i].start) cues[i].end = cues[i].start + 200;
  }
  return cues;
}
