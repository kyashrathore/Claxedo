# Machine Remote Access Capability

Publishing THIS MACHINE for remote access, as a named operation rather than a
request. One user action — "Enable remote access" — with two mechanisms
underneath: an authenticated HTTP call on the self-hosted Node product, which
serves `/api/claxedo/remote-access/*` itself, and Electron IPC on the desktop,
whose sidecar serves none of those paths because the Host Connector in Electron
main owns machine publication.

Shared app code must not hardcode either one: the desktop sidecar does not
serve the HTTP routes. The HTTP implementation lives here; the Electron one
lives in `packages/claxedo-desktop/src/renderer/remote-access/`.

The desktop bridge (`hostConnector` in the preload) is a closed set of named
operations — status, start, pause, revoke, share, unshare, rename — plus a
status subscription, for the same reason `platform/account` is: main holds the
account bearer and a non-expiring machine signing key, so a generic
`run(url, method, body)` would make it a confused deputy. No implementation here
ever receives a token.
