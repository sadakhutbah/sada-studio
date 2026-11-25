<p align="center">
  <img src="src/renderer/src/assets/sada-mark-or.svg" alt="Sadā" width="96">
</p>

<h1 align="center">Sadā Studio</h1>

<p align="center">
  The broadcasting app of <a href="https://github.com/thesadaproject/sada">Sadā</a>: a mosque computer with a camera
  becomes a live stream for the khutba and lessons, with nobody behind it.
</p>

<p align="center">
  <a href="https://github.com/thesadaproject/sada-studio/actions/workflows/ci.yml"><img src="https://github.com/thesadaproject/sada-studio/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-E2C27A" alt="License: AGPL-3.0"></a>
</p>

<p align="center"><b>English</b> · <a href="README.ar.md">العربية</a></p>

---

Sadā Studio runs on the mosque's computer, next to the camera and the microphone. You pair it once with
your Sadā instance, then it waits: when the schedule (or someone in the console) starts a live, it
streams to Sadā, which relays it to Facebook, YouTube or any RTMP destination, records it and prepares
the transcript and clips. When the live ends, it goes back to standby.

It replaces OBS for mosques that use the hosted version of Sadā: nothing to configure, nothing to start.

## Features

- **Pair with a code**: enter the address of your Sadā instance, type the code shown in the Sadā console.
  That's all the setup.
- **Hands-free**: starts with the computer, streams only when Sadā orders a live, prepares the camera
  shortly before a scheduled slot.
- **Manual live**: start a khutba, a lesson or a conference outside the schedule, with a title.
  A scheduled slot never cuts a manual live.
- **One stream per mosque**: if OBS or another device is already live, Studio is refused; an
  administrator can take over from the console.
- **Workstation health**: camera, microphone, sleep, automatic sign-in, Windows Update hours. Each issue
  comes with its fix, and Sadā e-mails the mosque if something stays broken.
- **Resilient**: single instance, tray icon, crash recovery, reconnects on its own when the network or
  the camera comes back.
- **Local sources**: a web page (counter, donation widget) and a screen or window share, composed with the
  camera; the sound of both is mixed with the microphone, with a volume per source.
- **Shortcuts and Stream Deck**: global keyboard shortcuts and a local control API (see
  [Remote control](#remote-control-shortcuts-and-stream-deck)).
- **Automatic updates**, never during a live nor just before a slot.

## Remote control: shortcuts and Stream Deck

Open **Réglages** (gear button), section *Raccourcis et API locale*.

**Global shortcuts** work even when the window is hidden in the notification area. Defaults (change or remove them
with the *Modifier* and *Retirer* buttons; a shortcut needs Ctrl, Alt or Cmd with a letter, digit, F key or arrow):

| Action | Default (`Ctrl` on Windows and Linux, `Cmd` on macOS) |
| --- | --- |
| Mute / restore the microphone | `Ctrl+Alt+Shift+M` |
| Show / hide the web source | `Ctrl+Alt+Shift+B` |
| Switch the screen share on / off | `Ctrl+Alt+Shift+S` |
| Next / previous scene | `Ctrl+Alt+Shift+Right` / `Left` |

A shortcut another application already holds is reported in the settings. Showing or hiding a source never asks
for confirmation; removing one always does, and cannot be triggered from a shortcut or from the API.

**Local API** (off by default; tick *Activer l'API locale*): an HTTP server on `127.0.0.1` only, default port
`17420`, that runs the same actions. The settings show the port and a random token (stored in the user data
directory, readable by your account only; *Régénérer* replaces it and the old one stops working at once).

- Every request needs the token: `Authorization: Bearer <token>` (or an `X-Sada-Token` header, or `?token=<token>`
  for clients that cannot send headers).
- Requests that do not come from this computer, are addressed to another host name, or carry a non-local `Origin`
  (a web page on another site) are refused. The token is compared in constant time, and repeated failures are
  throttled (`429`).
- `GET /v1/actions` lists the actions; `POST /v1/actions/<action>` (or `GET`) runs one and answers with the
  resulting state, for example `{"ok":true,"state":{"micMuted":true}}`. Errors have a stable `code`.

| Action | Effect |
| --- | --- |
| `mic.toggle`, `mic.mute`, `mic.unmute` | Microphone |
| `browser.toggle`, `browser.show`, `browser.hide` | Web source (error `no_browser_source` if none was added) |
| `screen.toggle`, `screen.start`, `screen.stop` | Screen share (error `no_screen_source` until a screen or window is chosen) |
| `scene.next`, `scene.previous` | Scene before or after the current one (error at either end, no wrap-around) |
| `scene.set` | A given scene: `?scene=avant` or a JSON body `{"scene":"avant"}` |

```bash
TOKEN=...   # shown in the settings
curl -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:17420/v1/actions/mic.toggle
curl -X POST -H "Authorization: Bearer $TOKEN" -d '{"scene":"avant"}' http://127.0.0.1:17420/v1/actions/scene.set
```

**Stream Deck** (no native plugin): with an HTTP request plugin such as *API Ninja*, add one button per action:
method `POST`, URL `http://127.0.0.1:17420/v1/actions/mic.toggle`, header `Authorization` with the value
`Bearer <token>`. The built-in *Website* action opens the address in a browser and cannot send headers: if you use
it, put the token in the address (`...?token=<token>`) and enable its background access option when your version
has one.

**Bitfocus Companion**: add a *Generic HTTP Requests* connection, then a *POST* action with the path
`/v1/actions/mic.toggle` and the header `Authorization: Bearer <token>`, with base URL `http://127.0.0.1:17420`.

## Download

Installers for Windows, macOS and Linux are on the [Releases](https://github.com/thesadaproject/sada-studio/releases)
page. Studio needs a Sadā instance to pair with: self-hosted ([sada](https://github.com/thesadaproject/sada))
or hosted.

## Development

Requires Node.js 22.

```bash
npm ci
npm run mock                                          # mock Sadā server on http://127.0.0.1:8787
SADA_STUDIO_INSTANCE=http://127.0.0.1:8787 npm run dev  # app with hot reload, paired to the mock
npm run lint && npm run typecheck && npm test
```

Without a camera (WSL, CI), set `SADA_STUDIO_FAKE_MEDIA=1`.

Layout: `src/core/` (pairing, kiosk state machine, health checks, API client), `src/main/` (window,
tray, device store, updater), `src/renderer/` (React UI), `scripts/` (mock server, icons), `tests/`.
The server contract is in [`docs/studio-devices.md`](https://github.com/thesadaproject/sada/blob/main/docs/studio-devices.md)
of the Sadā repository.

Building installers and publishing updates: [`docs/releasing.md`](docs/releasing.md).

## License

[GNU AGPL-3.0](LICENSE), like Sadā. You may use, modify and redistribute Studio; if you distribute a
modified version, its source code must be published under the same license.
