# Changelog

## Unreleased

### Added

- **Web source** in the Régie panel ("Sources locales"): add a web page (counter, donation widget, any public `http(s)` address), show or hide it, choose overlay or full screen, the corner and the size, reload it, remove it. The page is rendered on the broadcast computer in a hidden window and composed over the camera, in the local monitor and in the live. Its address and layout are remembered.
- **Screen and window share**: pick a screen or a window from a list with thumbnails, then switch the share on or off from the Régie panel. The chosen source is the only one served to the application (no automatic choice of the whole screen); the local microphone stays mixed in. If the operator stops sharing from the system, the studio goes back to the camera and the live goes on.
- **Live switching**: showing or hiding the web source, or switching the screen share on or off, changes the picture of a running live without cutting the connection (the video and audio senders' tracks are replaced on the open WHIP session).
- macOS: when the screen-recording permission is refused, a clear message and a button to the System Settings replace an empty list.

- **Sound of the shared screen and of the web page in the live**: both are mixed (Web Audio) with the local microphone, each with its own on/off and volume (0 to 200 %) in the Régie panel; the settings are remembered. Switching a sound on or off swaps the audio sender on the open WHIP session (`replaceTrack`): the live is never cut, and while only the microphone is audible it goes out untouched. The microphone's mute still acts on the microphone alone. The web page stays silent on this computer: its sound is captured, not played.
- The screen's sound is captured through system audio loopback, which Electron only offers on Windows. On macOS and Linux the switch is disabled and says why; the microphone is still broadcast with the screen.

- **Global shortcuts** (configurable in the settings, working while the window is hidden): mute or restore the microphone, show or hide the web source, switch the screen share on or off, next and previous scene. A shortcut the system refuses (already taken) or that two actions share is reported.
- **Local control API** for Stream Deck, Bitfocus Companion or any HTTP client: off by default, listens on `127.0.0.1` only (default port 17420), runs the same actions plus `mic.mute`/`mic.unmute`, `browser.show`/`browser.hide`, `screen.start`/`screen.stop` and `scene.set`. A random token, stored locally and shown in the settings (with copy and regenerate), is required; non-local peers, other host names and non-local origins are refused, the token is compared in constant time and repeated failures are throttled. How to call it from Stream Deck and Companion is documented in the README. Removing a source is deliberately not an action.

### Changed

- The last shared screen or window is remembered. At the next launch it is selected again if it still exists (a window is found again by its name when the system gave it a new id, unless two windows share that name); otherwise the list opens so another one can be picked. Sharing itself stays off until the operator switches it on, and the list is only read at launch when the system already allows screen recording (no permission prompt at startup).

- The scene canvas is only used while a web source or a shared screen is shown; otherwise the camera stream is sent untouched. Drawing is driven by a timer, so it no longer freezes when the window is hidden in the notification area.
- Web source frames travel as raw pixels, at most 15 per second, scaled down to 1280×720 at most, one at a time (a frame is dropped if the previous one has not been consumed): no PNG encoding on the main process.

- Removing the web source now asks for confirmation first (a message in the Régie panel, Escape or "Keep" cancels). Showing or hiding it stays instant, with no confirmation.

### Security

- The web source runs in its own non-persistent session (`browser-source`) with no preload and no permission granted (camera, microphone, screen, notifications, devices…); the application's own policy does not apply to it, and nothing the page stored survives its removal.
- Addresses of this computer or of a private network are refused (localhost, loopback, 10/8, 172.16/12, 192.168/16, fc00::/7, link-local 169.254/16 and fe80::/10, local names, and names that resolve to such addresses), for the page itself, for its redirects, its frames and its sub-requests. Pop-ups are denied.
- The local-sources IPC channels are validated in the main process and only answer the application window.

### Fixed

- The quit dialog named Windows on every system; it now says macOS, Windows or "the computer".
