# Building and releasing Sada Studio

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
