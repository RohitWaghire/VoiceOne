# VoiceOne — Privacy Policy

_Last updated: 2026-06-22_

VoiceOne is a Chrome extension that translates selected text and reads it aloud using
Chrome's built‑in, on‑device AI. This policy explains what data the extension handles.

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

- **Your preferences.** Settings such as preferred voice, speech rate/pitch/volume, default
  target language, and any custom languages you add are saved with `chrome.storage.sync`.
  Chrome may sync these settings across your own signed‑in devices through your Google account.
  The developer cannot access them.

## What the extension does NOT do

- No collection of personal, health, financial, authentication, location, web‑history, or
  user‑activity data.
- No analytics, telemetry, advertising, fingerprinting, or tracking.
- No selling or transferring of user data to third parties.
- No remote/hosted code — all logic ships inside the extension package.

## Permissions

VoiceOne requests the minimum permissions needed: `tts` (read aloud), `contextMenus`
(right‑click menu), `scripting` + `activeTab` (show the panel / read the selection on the
current tab only when you invoke the extension), and `storage` (save your preferences). It does
**not** request access to all websites.

## Contact

Questions or issues: please open an issue at
<https://github.com/RohitWaghire/VoiceOne/issues>.
