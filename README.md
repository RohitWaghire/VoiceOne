# VoiceOne

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Install-blue?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/voiceone/ingbabpokfkldjjpbgjkmfichemjagii)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Chrome](https://img.shields.io/badge/Chrome-138%2B-blue.svg)
![Manifest](https://img.shields.io/badge/Manifest-v3-green.svg)

Select any text, **translate it**, and have it **read aloud** — or **dub a whole YouTube
lecture** into your language with one click. Entirely powered by Chrome's **native, on-device
AI**; works on regular web pages and inside Chrome's built-in PDF viewer.

**▶ [Install from the Chrome Web Store](https://chromewebstore.google.com/detail/voiceone/ingbabpokfkldjjpbgjkmfichemjagii)**

<!-- hero demo GIF — record ~15s: open a captioned lecture → click the VoiceOne
     button → audio ducks, narration starts → switch language in the dub panel.
     Save as screenshots/dub-demo.gif, then uncomment:
![One-click YouTube dubbing](screenshots/dub-demo.gif)
-->


Everything runs locally in the browser:

- **Translation** → built-in **`Translator`** + **`LanguageDetector`** APIs
- **Speech** → native **`chrome.tts`** API

---

## Screenshots

Settings and the toolbar popup:

![VoiceOne settings and popup](screenshots/settings.png)

The floating panel reading a translation aloud:

![VoiceOne reading panel](screenshots/panel.png)

---

## Features

- **Right-click → VoiceOne** on any selected text:
  - **Auto Read Original Language** — reads the selection aloud in its own language.
  - **Translate & Read ▸ &lt;language&gt;** — translate into one of ~15 languages and read it.
- **🎓 YouTube dubbing (new in 1.1)** — a VoiceOne button in the YouTube player re-narrates any
  lecture in **the language you choose** with one click: the original audio ducks down and the
  video's captions are spoken in sync by a clean TTS voice, translated **on-device** when needed.
  A small on-page panel lets you **switch the dub language live**, adjust how loud the original
  stays, and stop. No downloads, no external services, no waiting.
- **Floating control panel** with **Pause · Resume · Repeat · Stop · Clear · ✕** and a live
  status line (e.g. `Translated mixed → fr · Google français`). Drag it by the header.
- **Toolbar popup** mirrors the panel and works as a fallback control surface.
- **Options** for voice, rate, pitch, volume, default target language, the original-audio level
  while dubbing, and which languages appear in the menu — including **adding your own language**
  (name + ISO code + optional voice locale) beyond the built-in set.

### How YouTube dubbing works (and its honest limits)

The dub re-narrates the video's **caption track** (auto-generated or manual — virtually every
instructional video has one), synchronized to the player clock. If the video already has a
caption track in your chosen language, it's used directly — no translation step at all. That
means:

- It's a **clear neutral TTS voice**, not a "de-accented" clone of the lecturer's own voice.
- A video with **no captions at all** can't be dubbed (you'll get a clear message).
- Caption transcription errors pass through to the narration.
- Live streams aren't supported.

---

## Requirements

- **Google Chrome 138 or newer** (built-in AI APIs).
- Chrome's on-device translation models download on **first use** of a language pair (you'll see
  a "Downloading model… %" status). If a model or language pair isn't available, VoiceOne tells
  you and (where possible) reads the original text instead.

---

## Install

**From the Chrome Web Store (recommended):**
[chromewebstore.google.com/detail/voiceone](https://chromewebstore.google.com/detail/voiceone/ingbabpokfkldjjpbgjkmfichemjagii)

**Or load the source (for development):**

1. Download or clone this repository.
2. Open `chrome://extensions`.
3. Toggle **Developer mode** (top-right).
4. Click **Load unpacked** and select the `VoiceOne` folder.
5. (For local PDFs via `file://`) click **Details** on VoiceOne and enable
   **Allow access to file URLs**.

---

## Usage

**Selections (any page or PDF):**

1. Select text on any page (or in a PDF).
2. Right-click → **VoiceOne** → **Auto Read Original Language** or **Translate & Read ▸ a language**.
3. The floating panel appears, shows the (translated) text, and reads it aloud. Use the panel or
   the toolbar popup to pause/resume/repeat/stop.

**YouTube dubbing:**

1. Open any YouTube video with captions (most lectures have auto-captions).
2. Click the **VoiceOne logo button** in the player's bottom-right controls.
3. The lecturer's audio ducks down and a clear voice narrates in sync. Videos in another language
   show a brief on-device "Translating… %" pass first.
4. Use the **VoiceOne dub panel** (bottom-left) to switch the dub language live, adjust how loud
   the original audio stays, or stop (✕). Clicking the player button again also stops. Defaults
   live in **Settings → YouTube dubbing**.

You can also click the toolbar icon to read the current selection, translate to your default
language, control playback, or open **Settings**.

---

## Project layout

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest, permissions, menu |
| `background.js` | Service worker: menus, detection, translation, `chrome.tts`, panel state |
| `panel.js` | Floating control panel injected into the page (Shadow DOM) |
| `youtube.js` | YouTube site adapter: dub button, caption fetch, ad detection, SPA-navigation glue |
| `lib/dub-engine.js` | Site-agnostic dub engine: synced narration, audio duck, dub panel, translation batching |
| `popup.html` / `popup.js` | Toolbar popup + fallback controls |
| `options.html` / `options.js` | Preferences (`chrome.storage.sync`) |
| `lib/languages.js` | Language list + TTS hints |
| `lib/captions.js` | YouTube caption helpers: player-response extraction, track picking, json3/XML parsing |
| `icons/` | Toolbar/store icons |

---

## Troubleshooting

- **"No on-device model for X → Y"** — that language pair isn't supported by the built-in
  Translator on your Chrome build; try another target or update Chrome.
- **Panel doesn't appear over a PDF** — use the **toolbar popup**, which mirrors the same
  controls and status.
- **No voice / wrong language voice** — install or pick a voice in **Settings**; some languages
  use Chrome's online "Google" voices, which need a network connection.
- **"VoiceOne was updated — reload this page"** — after installing or reloading the extension,
  YouTube tabs that were already open keep the old script; refresh the tab once.
- **"couldn't load captions"** — YouTube occasionally gates caption requests; reload the page and
  try again, or try another video.

---

## Roadmap

- **Dubbing beyond YouTube** — the dub engine is now site-agnostic; adapters for more
  lecture/video platforms are in progress, enabled per-site so the extension never asks for
  broad permissions up front.
- Better voices, per-language voice preferences.

---

## License

Released under the [MIT License](LICENSE) © 2026 Rohit Waghire.

---

*VoiceOne is a local-first demo of Chrome's built-in AI.*
