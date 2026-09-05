# Releasing Claxedo App

This package owns the Claxedo web app and the shared renderer used by the Electron desktop shell.

## Pre-Release Checklist

- [ ] Changes are merged to `dev`
- [ ] `bun run build` passes in `packages/claxedo-app`
- [ ] `bun run build` passes in `packages/claxedo-desktop`
- [ ] `bun run package:mac` or the platform package command passes in `packages/claxedo-desktop`

## Versioning

Bump the version in `packages/claxedo-app/package.json` and
`packages/claxedo-desktop/package.json` together; the desktop release
workflow (`.github/workflows/release-claxedo.yml`) reads the desktop version.

## Desktop Packaging

Desktop packaging now lives entirely in `packages/claxedo-desktop`.

```bash
cd packages/claxedo-desktop

bun run build
bun run package:mac
bun run package:win
bun run package:linux
```

`bun run package*` rebuilds first and validates the desktop packaging contract before `electron-builder` runs.

## Signing

Electron signing and notarization are handled by `electron-builder`.

### macOS

Provide the usual Apple signing and notarization environment variables:

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_PASSWORD`
- `APPLE_TEAM_ID`

### Windows

If Windows signing is enabled in CI, provide the certificate and password expected by your `electron-builder` setup.

### Linux

Linux artifacts do not require signing for local installation.

## Artifacts

Local Electron artifacts are written under:

```text
packages/claxedo-desktop/dist/
```

Typical outputs include:

- `.dmg` and `.zip` on macOS
- `nsis` installer output on Windows
- `.AppImage`, `.deb`, and `.rpm` on Linux

## Verification

After publishing:

1. Install the packaged app on each target platform.
2. Verify the app starts and connects to the bundled local server.
3. Verify the updater channel publishes the expected release artifacts.
4. Smoke test login, terminal, and workspace flows in both web and desktop builds.
