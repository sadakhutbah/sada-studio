<p align="center">
  <img src="src/renderer/src/assets/sada-mark-or.svg" alt="Sadā" width="96">
</p>

<h1 align="center">Sadā Studio</h1>

<p align="center">
  The broadcasting app of <a href="https://github.com/sadakhutbah/sada">Sadā</a>: a mosque computer with a camera
  becomes a live stream for the khutba and lessons, with nobody behind it.
</p>

<p align="center">
  <a href="https://github.com/sadakhutbah/sada-studio/actions/workflows/ci.yml"><img src="https://github.com/sadakhutbah/sada-studio/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
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
- **Automatic updates**, never during a live nor just before a slot.

## Download

Installers for Windows, macOS and Linux are on the [Releases](https://github.com/sadakhutbah/sada-studio/releases)
page. Studio needs a Sadā instance to pair with: self-hosted ([sada](https://github.com/sadakhutbah/sada))
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
The server contract is in [`docs/studio-devices.md`](https://github.com/sadakhutbah/sada/blob/main/docs/studio-devices.md)
of the Sadā repository.

Building installers and publishing updates: [`docs/releasing.md`](docs/releasing.md).

## License

[GNU AGPL-3.0](LICENSE), like Sadā. You may use, modify and redistribute Studio; if you distribute a
modified version, its source code must be published under the same license.
