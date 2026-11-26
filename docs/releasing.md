# Building and releasing Sada Studio

## Build

```
npm run dist       # installer for the current OS, in dist/
```

Targets: Windows (NSIS), macOS (dmg, zip, one per architecture: arm64 and x64, no universal build; each user downloads one file of about 125 MB instead of 290 MB), Linux (AppImage). The Windows installer cannot be built on Linux without `wine`; CI builds all three. The `appId` (`com.sada.sadakhutbah`) identifies the app to the OS and to updates: do not change it.

Builds are unsigned unless signing secrets are provided to the workflow (`MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` for macOS; `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` for Windows). Unsigned macOS builds are blocked by Gatekeeper and **cannot auto-update**; unsigned Windows builds trigger a SmartScreen warning.

## Publishing updates

Installed apps check the GitHub Releases of this repository (15 s after start, then every 6 h) and download in the background. No token is needed on the client.

Releases are driven by [release-please](https://github.com/googleapis/release-please), like the `sada` server. Never bump `version` by hand.

1. Commit to `main` (through PRs) with [Conventional Commits](https://www.conventionalcommits.org/): `fix:` gives a patch, `feat:` a minor, `feat!:` or a `BREAKING CHANGE:` footer a major. `chore:`, `docs:`, `ci:` and `test:` do not release.
2. release-please keeps a version PR (`chore(release): X.Y.Z`) open: it bumps `package.json` and `package-lock.json`, and writes `CHANGELOG.md`.
3. Merging that PR creates the tag `vX.Y.Z` and the GitHub Release. The same workflow run then builds the three platforms on that tag and attaches the installers and `latest*.yml` to the release, using the workflow's `GITHUB_TOKEN`.

The tag keeps the plain `vX.Y.Z` format (no component prefix): installed apps follow the latest GitHub Release and the `latest*.yml` it carries.

Known pitfalls:

- The version PR is pushed with `GITHUB_TOKEN`, so GitHub attaches no checks to it. The workflow dispatches `ci.yml` on the PR branch to compensate: look for that run (same head commit) before merging, and re-run it with `gh workflow run ci.yml --ref <release-please-branch>` if it is missing.
- A tag created with `GITHUB_TOKEN` triggers no workflow, which is why the installers are built in the same run as release-please, not on the tag.
- The release is visible a few minutes before its installers are attached (build time); the update feed is complete once the `release` job is green. If a build fails, re-run the failed jobs of that run: the upload is idempotent (`--clobber`).
- Manual fallback: pushing a tag `vX.Y.Z` by hand still builds the installers and, if no release exists for it, creates one. Use it only if release-please is unavailable, and keep `package.json` and the manifest `.release-please-manifest.json` in line with the tag.

### Per-machine override

To point one machine at another static HTTP directory serving `latest.yml`, `latest-mac.yml` or `latest-linux.yml` and the installers (generic provider), set `SADA_STUDIO_UPDATE_URL` (and optionally `SADA_STUDIO_UPDATE_CHANNEL`), or create `update.json` in the app data directory:

```json
{ "url": "https://example.org/studio/", "channel": "latest" }
```

`https` is required; `http` is accepted only on localhost.

Local end-to-end test: build two versions (`electron-builder --linux -c.directories.output=/tmp/v2 -c.extraMetadata.version=0.1.1`), serve the newer one with `python3 -m http.server 8099 --bind 127.0.0.1`, run the older one under `xvfb-run` with `SADA_STUDIO_UPDATE_URL=http://127.0.0.1:8099/`, and read `studio.log`.
