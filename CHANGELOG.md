# Changelog

## Unreleased

### Added

- **Web source** in the Régie panel ("Sources locales"): add a web page (counter, donation widget, any public `http(s)` address), show or hide it, choose overlay or full screen, the corner and the size, reload it, remove it. The page is rendered on the broadcast computer in a hidden window and composed over the camera, in the local monitor and in the live. Its address and layout are remembered.
- **Screen and window share**: pick a screen or a window from a list with thumbnails, then switch the share on or off from the Régie panel. The chosen source is the only one served to the application (no automatic choice of the whole screen); the local microphone stays mixed in. If the operator stops sharing from the system, the studio goes back to the camera and the live goes on.
- **Live switching**: showing or hiding the web source, or switching the screen share on or off, changes the picture of a running live without cutting the connection (the video and audio senders' tracks are replaced on the open WHIP session).
- macOS: when the screen-recording permission is refused, a clear message and a button to the System Settings replace an empty list.

### Changed

- The scene canvas is only used while a web source or a shared screen is shown; otherwise the camera stream is sent untouched. Drawing is driven by a timer, so it no longer freezes when the window is hidden in the notification area.
- Web source frames travel as raw pixels, at most 15 per second, scaled down to 1280×720 at most, one at a time (a frame is dropped if the previous one has not been consumed): no PNG encoding on the main process.

- Removing the web source now asks for confirmation first (a message in the Régie panel, Escape or "Keep" cancels). Showing or hiding it stays instant, with no confirmation.

### Security

- The web source runs in its own non-persistent session (`browser-source`) with no preload and no permission granted (camera, microphone, screen, notifications, devices…); the application's own policy does not apply to it, and nothing the page stored survives its removal.
- Addresses of this computer or of a private network are refused (localhost, loopback, 10/8, 172.16/12, 192.168/16, fc00::/7, link-local 169.254/16 and fe80::/10, local names, and names that resolve to such addresses), for the page itself, for its redirects, its frames and its sub-requests. Pop-ups are denied.
- The local-sources IPC channels are validated in the main process and only answer the application window.

### Fixed

- The quit dialog named Windows on every system; it now says macOS, Windows or "the computer".
