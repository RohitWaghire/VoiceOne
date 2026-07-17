# VoiceOne — Privacy Policy

_Last updated: 2026-07-17_

VoiceOne is a Chrome extension that translates selected text and reads it aloud — and can
dub videos on YouTube and on video sites you explicitly enable — using Chrome's built‑in,
on‑device AI. This policy explains what data the extension handles.

## Summary

**VoiceOne does not collect, store, or transmit your data to the developer or to any
analytics, advertising, or tracking service. There are no developer‑operated servers.**

## What the extension handles

- **Text you select.** When you choose "Translate & Read" or "Auto Read Original Language",
  the text you have selected is processed so it can be translated and spoken:
  - **Translation** is performed **on your device** by Chrome's built‑in Translator and
    Language Detector APIs. This text is **not** sent to the developer or any third‑party
    server for translation.
  - **Reading aloud** uses Chrome's native text‑to‑speech (`chrome.tts`). If you choose a
    **local** voice, synthesis happens entirely on your device. If you choose one of Chrome's
    **online ("Google") voices**, Chrome sends the text to its speech service to generate the
    audio. This is handled by Chrome itself, under Google's own privacy terms — VoiceOne does
    not receive or store that text.
  - Selected text is held only in memory for the duration of a read‑aloud action and is **not
    persisted**.

- **Video captions (dubbing).** When you start a dub — on YouTube, or on a video site you
  have explicitly enabled — VoiceOne reads that video's **caption track**:
  - Caption data comes **only from the site you are watching** (e.g. `youtube.com`), from
    your own browser session — the same way the site loads captions for its player. No
    other server is contacted, and nothing is sent to the developer.
  - Captions are **translated on your device** by Chrome's built‑in Translator and narrated
    with your browser's speech synthesis. As with read‑aloud, choosing one of Chrome's
    **online ("Google") voices** means Chrome sends the text to its speech service under
    Google's own privacy terms.
  - Captions are held only in memory while the dub is active and are **not persisted**.

- **Your preferences.** Settings such as preferred voice, speech rate/pitch/volume, default
  target language, dub language, original‑audio level, and any custom languages you add are
  saved with `chrome.storage.sync`. Chrome may sync these settings across your own signed‑in
  devices through your Google account. The developer cannot access them.

## What the extension does NOT do

- No collection of personal, health, financial, authentication, location, web‑history, or
  user‑activity data.
- No analytics, telemetry, advertising, fingerprinting, or tracking.
- No selling or transferring of user data to third parties.
- No remote/hosted code — all logic ships inside the extension package.

## Permissions

VoiceOne requests the minimum permissions needed: `tts` (read aloud), `contextMenus`
(right‑click menu), `scripting` + `activeTab` (show the panel / read the selection on the
current tab only when you invoke the extension), `storage` (save your preferences), and
`sidePanel` (show the settings page docked beside the tab).

Site access is opt‑in per site. Out of the box the only site access is **youtube.com**
(the dub button and caption loading). Any other site gets access **only if you enable it
yourself** via the popup's "Enable dubbing on this site" — each grant goes through Chrome's
own permission prompt, is used solely to read that site's captions and control the video's
volume for dubbing, and can be revoked at any time from `chrome://extensions` → VoiceOne →
Site access.

## Contact

Questions or issues: please open an issue at
<https://github.com/RohitWaghire/VoiceOne/issues>.
