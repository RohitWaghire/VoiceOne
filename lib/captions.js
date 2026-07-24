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
      !/[.!?…।。！？]["')\]」』”]?$/.test(last.text) // don't merge across sentence ends (Latin + CJK)
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

const cleanCueLine = (s) =>
  String(s || "")
    .replace(/<[^>]+>/g, " ") // VTT voice/format tags
    .replace(/\[[^\]]*\]|【[^】]*】|♪+/g, " ") // sound-event tags (latin + CJK brackets)
    .replace(/>>+/g, " ") // speaker-change markers (else TTS says "greater than")
    .replace(/\s+/g, " ")
    .trim();

// Shared post-processing: sort, drop rolling repeats, clamp overlaps.
function finishCues(raw) {
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

// Parse WebVTT or SRT text into cues (ms). The two formats share the cue
// shape; differences handled here: optional WEBVTT header/notes, optional
// numeric index lines, `.` (VTT) vs `,` (SRT) millisecond separators, and
// VTT's optional hours field.
export function parseVttOrSrt(text) {
  const ts =
    /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{3})/;
  const toMs = (h, m, s, ms) =>
    (Number(h || 0) * 3600 + Number(m) * 60 + Number(s)) * 1000 + Number(ms);
  const raw = [];
  for (const block of String(text || "").replace(/\r/g, "").split(/\n\n+/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => ts.test(l));
    if (at === -1) continue; // WEBVTT header, NOTE/STYLE blocks, stray text
    const m = ts.exec(lines[at]);
    const cueText = cleanCueLine(lines.slice(at + 1).join(" "));
    if (!cueText) continue;
    raw.push({
      start: toMs(m[1], m[2], m[3], m[4]),
      end: toMs(m[5], m[6], m[7], m[8]),
      text: cueText,
    });
  }
  return finishCues(raw);
}

// Parse Bilibili's subtitle JSON ({ body: [{ from, to, content }] }, seconds)
// into cues (ms).
export function parseBilibiliSubtitle(json) {
  const raw = [];
  for (const item of json?.body || []) {
    if (typeof item?.from !== "number") continue;
    const text = cleanCueLine(item.content);
    if (!text) continue;
    raw.push({
      start: Math.round(item.from * 1000),
      end: Math.round((typeof item.to === "number" ? item.to : item.from + 3) * 1000),
      text,
    });
  }
  return finishCues(raw);
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

// -------------------------------------------------------------------------
// Bilibili wbi request signing.
//
// Since ~2023 Bilibili gates several player/web APIs behind a "wbi" signature:
// requests need a `w_rid` (an md5 over the query params + a rotating "mixin
// key") and a `wts` timestamp, or the response silently omits data. The CC
// subtitle list is one such field — the legacy `player/v2` endpoint returns an
// empty `subtitles` array for many videos (notably AI-generated subtitles),
// while the signed `player/wbi/v2` endpoint returns them for a logged-in user.
//
// The mixin key is derived by re-ordering the two key strings pulled from the
// nav API (`wbi_img.img_url` / `sub_url` filenames) through a fixed table.
// These functions are pure; the caller fetches nav and passes the two URLs in.

const WBI_MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

// filename stem of a wbi image URL: ".../7cd084941338484aae1ad9425b84077c.png"
const wbiKey = (url) => String(url || "").split("/").pop().split(".")[0];

function wbiMixinKey(imgUrl, subUrl) {
  const orig = wbiKey(imgUrl) + wbiKey(subUrl);
  if (orig.length < 64) return null; // unexpected nav shape — caller falls back
  let key = "";
  for (const i of WBI_MIXIN_TAB) key += orig[i];
  return key.slice(0, 32);
}

// Sign a param object for a wbi-gated endpoint. Returns the full query string
// (`k=v&…&wts=…&w_rid=…`), or null if the keys look malformed so the caller can
// fall back to the unsigned endpoint. `wts` is injectable for deterministic
// tests; it defaults to the current unix time.
export function wbiSign(params, imgUrl, subUrl, wts = Math.floor(Date.now() / 1000)) {
  const mixin = wbiMixinKey(imgUrl, subUrl);
  if (!mixin) return null;
  const signed = { ...params, wts };
  const query = Object.keys(signed)
    .sort()
    .map(
      (k) =>
        encodeURIComponent(k) +
        "=" +
        // Bilibili strips !'()* from values before signing.
        encodeURIComponent(String(signed[k]).replace(/[!'()*]/g, ""))
    )
    .join("&");
  return query + "&w_rid=" + md5(query + mixin);
}

// Minimal RFC 1321 md5 (hex). Web Crypto has no md5, and wbi needs exactly it.
// Operates on UTF-8 bytes; input here is ASCII query text either way.
function md5(input) {
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
    9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
    16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10,
    15, 21,
  ];
  const K = [];
  for (let i = 0; i < 64; i++)
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;

  const msg = new TextEncoder().encode(input);
  const len = msg.length;
  const total = ((len + 8) >> 6) * 64 + 64; // room for 0x80 + 64-bit length
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  const bits = len * 8;
  dv.setUint32(total - 8, bits >>> 0, true);
  dv.setUint32(total - 4, Math.floor(bits / 4294967296) >>> 0, true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const rol = (x, c) => (x << c) | (x >>> (32 - c));

  for (let off = 0; off < total; off += 64) {
    const M = [];
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
      else { F = C ^ (B | ~D); g = (7 * i) & 15; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + rol(F, S[i])) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const hex = (n) => {
    let s = "";
    for (let i = 0; i < 4; i++)
      s += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
    return s;
  };
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}
