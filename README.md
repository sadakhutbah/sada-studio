# Sada Studio

Sada Studio is a kiosk-style broadcasting app for mosques. It runs on a computer in the mosque, captures the camera and microphone, and streams to a [Sada](https://github.com/sadakhutbah/sada) server over WHIP while a khutbah or a lesson is on air. Sada relays, records and transcribes the stream.

It is a client of the Sada API: it needs a Sada instance to pair with. Built with Electron, Vite, React and TypeScript.

## Features

- **Pairing**: on first launch, enter the address of your Sada instance; a code is displayed and is entered once in the Sada console (Devices). The device secret is stored encrypted with Electron `safeStorage` (DPAPI on Windows).
- **Unattended operation**: starts with the user session, sends a heartbeat to the server (every 30 s, 10 s while live) and streams **only while the server orders a live**. The camera is prepared shortly before a scheduled slot without sending anything.
- **Manual mode**: start and stop a live (khutbah, lesson, conference) outside the schedule, with a title. A scheduled slot never interrupts a manual live.
- **Workstation health panel** (read-only): camera, microphone, automatic Windows sign-in, Windows Update active hours versus the schedule, sleep settings, start-with-Windows. Each issue comes with a fix.
- **Resilience**: single instance, tray icon, crash recovery, retries with bounded backoff when the network or camera is missing.
- **Automatic updates** from GitHub Releases. An update is never installed during a live, an ordered live or a slot, nor in the 30 minutes before a slot.

The server contract is documented in [`docs/studio-devices.md`](https://github.com/sadakhutbah/sada/blob/main/docs/studio-devices.md) of the Sada repository. `scripts/mock-sada.mjs` is a mock server that follows it.

## Development

Requires Node.js 22.

```
npm ci
npm run dev        # app with hot reload
npm run mock       # mock Sada server on http://127.0.0.1:8787
npm run lint && npm run typecheck && npm test
```

To try pairing against the mock server:

```
SADA_STUDIO_INSTANCE=http://127.0.0.1:8787 npm run dev
```

`SADA_STUDIO_INSTANCE` is honoured only when running from source, not by the installed app. Without a camera (WSL, CI), set `SADA_STUDIO_FAKE_MEDIA=1` to simulate camera and microphone; on Linux without a sandbox, also pass `--no-sandbox`.

### Layout

```
src/core/       Electron-independent core (session, kiosk state machine, health checks, API client, transports)
src/main/       window, tray, single instance, IPC, device store, updater
src/preload/    `window.studio` bridge
src/renderer/   React UI
scripts/        mock server, icon generation
tests/          unit and integration tests (against the mock server)
```

The Sada client and the device secret live in the main process; the UI only receives a `KioskSnapshot`. The server is the master: the app streams only when it is ordered to.

## Build

```
npm run dist       # installer for the current OS, in dist/
```

Targets: Windows (NSIS), macOS (dmg, zip, universal), Linux (AppImage). The Windows installer cannot be built on Linux without `wine`; CI builds all three. The `appId` (`org.sadakhutbah.studio`) identifies the app to the OS and to updates: do not change it.

Builds are unsigned unless signing secrets are provided to the workflow (`MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` for macOS; `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` for Windows). Unsigned macOS builds are blocked by Gatekeeper and **cannot auto-update**; unsigned Windows builds trigger a SmartScreen warning.

## Publishing updates

Installed apps check the GitHub Releases of this repository (15 s after start, then every 6 h) and download in the background. No token is needed on the client.

1. Bump `version` in `package.json`.
2. Push a tag `vX.Y.Z`.

The workflow builds the three platforms and publishes the installers and `latest*.yml` files in a GitHub Release, using the workflow's `GITHUB_TOKEN`.

### Per-machine override

To point one machine at another static HTTP directory serving `latest.yml`, `latest-mac.yml` or `latest-linux.yml` and the installers (generic provider), set `SADA_STUDIO_UPDATE_URL` (and optionally `SADA_STUDIO_UPDATE_CHANNEL`), or create `update.json` in the app data directory:

```json
{ "url": "https://example.org/studio/", "channel": "latest" }
```

`https` is required; `http` is accepted only on localhost.

Local end-to-end test: build two versions (`electron-builder --linux -c.directories.output=/tmp/v2 -c.extraMetadata.version=0.1.1`), serve the newer one with `python3 -m http.server 8099 --bind 127.0.0.1`, run the older one under `xvfb-run` with `SADA_STUDIO_UPDATE_URL=http://127.0.0.1:8099/`, and read `studio.log`.

## License

[GNU AGPL-3.0-or-later](LICENSE), like Sada.
