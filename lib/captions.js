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

const isAuto = (t) => t.kind === "asr";

// Preference order: manual track already in the target language > auto target >
// manual any > any. A track already in the target needs no translation at all.
export function pickTrack(tracks, target = "en") {
  if (!tracks || !tracks.length) return null;
  const tgt = String(target).toLowerCase().split("-")[0];
  const inTarget = (t) => (t.languageCode || "").toLowerCase().startsWith(tgt);
  return (
    tracks.find((t) => inTarget(t) && !isAuto(t)) ||
    tracks.find((t) => inTarget(t)) ||
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
      .replace(/>>+/g, " ") // drop ">>" speaker-change markers (else TTS says "greater than")
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

// Merge choppy caption lines (ASR emits 2–4s fragments) into sentence-sized
// cues. Longer utterances give the TTS natural phrasing and far fewer
// cancellation points, which is what caused stuttering/lost words.
export function mergeCues(
  cues,
  { maxChars = 170, maxGapMs = 1000, maxSpanMs = 9000 } = {}
) {
  const out = [];
  for (const c of cues) {
    const last = out[out.length - 1];
    if (
      last &&
      c.start - last.end <= maxGapMs &&
      c.end - last.start <= maxSpanMs &&
      last.text.length + c.text.length + 1 <= maxChars &&
      !/[.!?…।]["')\]]?$/.test(last.text) // don't merge across sentence ends
    ) {
      last.text += " " + c.text;
      last.end = c.end;
    } else {
      out.push({ ...c });
    }
  }
  return out;
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

// Parse YouTube timed-text XML into cues. Handles both dialects:
//   - classic:  <text start="1.5" dur="2.3">…</text>   (seconds)
//   - srv3:     <p t="1360" d="1680">…</p>             (milliseconds)
export function parseTimedTextXml(xml) {
  const raw = [];
  const re = /<(text|p)(\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[2] || "";
    let start;
    let dur;
    if (m[1] === "text") {
      const sm = /\bstart="([\d.]+)"/.exec(attrs);
      if (!sm) continue;
      const dm = /\bdur="([\d.]+)"/.exec(attrs);
      start = parseFloat(sm[1]) * 1000;
      dur = dm ? parseFloat(dm[1]) * 1000 : 3000;
    } else {
      const tm = /\bt="(\d+)"/.exec(attrs);
      if (!tm) continue;
      const dm = /\bd="(\d+)"/.exec(attrs);
      start = parseInt(tm[1], 10);
      dur = dm ? parseInt(dm[1], 10) : 3000;
    }
    const text = decodeXml(m[3])
      .replace(/\[[^\]]*\]|♪+/g, " ") // sound-event tags / music notes
      .replace(/>>+/g, " ") // ">>" speaker-change markers (else TTS says "greater than")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    raw.push({ start, end: start + dur, text });
  }
  raw.sort((a, b) => a.start - b.start);

  const cues = [];
  for (const cue of raw) {
    const prev = cues[cues.length - 1];
    if (prev && prev.text === cue.text && cue.start - prev.start < 5000) {
      prev.end = Math.max(prev.end, cue.end);
      continue;
    }
    cues.push(cue);
  }
  for (let i = 0; i < cues.length - 1; i++) {
    cues[i].end = Math.min(cues[i].end, cues[i + 1].start);
    if (cues[i].end <= cues[i].start) cues[i].end = cues[i].start + 200;
  }
  return cues;
}
