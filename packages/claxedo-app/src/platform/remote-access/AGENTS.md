# Machine Remote Access Capability

Publishing THIS MACHINE for remote access, as a named operation rather than a
request. One user action — "Enable remote access" — with two mechanisms
underneath: an authenticated HTTP call on the self-hosted Node product, which
serves `/api/claxedo/remote-access/*` itself, and Electron IPC on the desktop,
whose sidecar serves none of those paths because the Host Connector in Electron
main owns machine publication.

Shared app code must not hardcode either one. It did, and the desktop's Enable
button kept posting to a route its sidecar had stopped serving.

The desktop bridge is a closed set of four operations — status, start, pause,
revoke — for the same reason `platform/account` is: main holds the account
bearer and a non-expiring machine signing key, so a generic
`run(url, method, body)` would make it a confused deputy. No implementation here
ever receives a token.

```json
{
  "owns": "The machine remote-access port, its binder, and the HTTP and Electron implementations",
  "writerOf": [],
  "mustNotImport": ["@/app/*", "@/features/*", "@/shell/*", "@/context/*", "@/components/*", "@/claxedo-ui/*", "@/ui/*"]
}
```
