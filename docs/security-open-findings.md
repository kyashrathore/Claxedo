# Security: open findings

What remains of the 161-finding audit of 2026-09-19 and its 2026-09-20
revalidation. Every finding not listed here is fixed, resolved, or consolidated
into one that is. The full tracker, with per-finding analysis and acceptance
evidence, is `docs/security-audit-revalidation-2026-09-20.md` at `98d3e5c88f`.

## Open

| Finding | Reassessed severity | What is left |
|---|---|---|
| S-1 — Any allowed localhost website can drive the local daemon | High, conditional | The daemon capability gate is mounted ahead of privileged routes, and Electron main stamps the capability only for the trusted top frame and exact daemon origin (`packages/claxedo-local-server/src/app/local-app.ts`). Signed packaged macOS acceptance has not run: it needs a Crabbox SSH profile for a signed macOS box, which is not configured. |
| P-84 — Local website can reconfigure the daemon's remote-control setup | High, hostile localhost origin | The same gate covers the machine-control routes (`packages/claxedo-local-server/src/workspace/host-serving-routes.ts`). Same signed packaged macOS acceptance as S-1. |
| S-3 — Packaged renderer has no document CSP | Low hardening | The packaged document now carries a CSP, stamped by Electron main (`packages/claxedo-desktop/src/main/renderer-content-security.ts`). It has not been verified in a packaged build. |
| P-138 — Old token helpers were replaced or tightened | Informational | Keep strict principal validation and the tests that only trusted service code can mint service tokens (`packages/claxedo-server/src/authority/adapters/d1/channel-runtime-authority.ts`, `packages/claxedo-server/src/authority/adapters/d1/host-access-authority.ts`). The D1 authority is the only token authority; the SQLite twin was removed with the self-hosted control plane. |

### Sign-in red team, 2026-10-18

| Finding | Severity | What is left |
|---|---|---|
| SI-1 — A process running as the user can spend the desktop's refresh token through the signed binary | Medium | No Electron fuse is flipped, so `NODE_OPTIONS=--require` or `--inspect` runs code inside the app the macOS Keychain item trusts, and `safeStorage.decryptString` returns the credential without a prompt. The fuses alone do not close it: the daemon child runs with `ELECTRON_RUN_AS_NODE` (`packages/claxedo-desktop/src/main/server-child-process.ts`), and that mode can `process.dlopen` a native addon. Needs the daemon off run-as-node, then `RunAsNode`, `EnableNodeOptionsEnvironmentVariable`, `EnableNodeCliInspectArguments` off and asar integrity on in the builder, verified on a signed packaged build. |
| SI-2 — The CLI mirror's `with-refresh` mode shares one rotating refresh-token family between the desktop and the CLI | Medium | `cli-credential-file.ts` copies the desktop's refresh token into `~/.claxedo/credentials.json`; the CLI rotates it on its own and the desktop never re-reads the file, so whichever side refreshes second presents a spent parent (sign-out of both, or family invalidation), and a desktop sign-out revokes the stale parent rather than the CLI's live child. Needs a CLI token family of its own, minted by an exchange, or the mirror limited to `access-token`. |
| SI-3 — The device page cannot show who asked for the code | Medium, inherent to RFC 8628 | The server now issues user codes only to `claxedo-cli` and the page says approving grants full account access, but a phished `/device?user_code=` link still shows the victim a code the attacker supplied. Needs the requester's address, country and time stored on `deviceCode` at `/device/code` and returned by the claimant-only `/device` read (`packages/claxedo-server/src/platform/auth/device-approval-transaction.ts`). |
| SI-4 — The MCP OAuth credential trusts introspection alone | Low today, High once MCP OAuth tools reach the control plane | `resolveOAuthMcpCredential` (`packages/claxedo-server/src/mcp/oauth-credential.ts`) runs no identity admission or session-evidence check, and an `offline_access` refresh token outlives the session it was issued in (`oauthRefreshToken.sessionId` is `on delete set null`). Contained while the first-party MCP tools re-enter with that bearer and `verifyNative` refuses it (`better-auth-d1-device-login.test.ts`). |
| SI-5 — A credential quarantined after a descriptor change is never revoked | Low | `rejectHeld` renames the record to `.rejected-<uuid>` and keeps it; the refresh token in it stays live for its 30 days. Needs a revoke while the stored issuer still matches, and pruning. |
| SI-6 — Packaged desktop builds honour `ELECTRON_RENDERER_URL` and a runtime `CLAXEDO_CORE_ORIGIN` | Low | Anyone who controls the launch environment can already inject code while SI-1 is open, so this becomes a boundary only after it. |
| SI-7 — `/login` continuing an authorization request with `prompt=login`, `max_age` or `prompt=select_account` loops between the two pages | Low | The signed-in reader is forwarded to `/oauth2/authorize`, which sends that prompt back to `/login`. |
| SI-8 — Another tab's account switch goes unnoticed until a 401 | Low | Nothing listens for `claxedo:auth:lastUserId` changing, so a tab keeps showing the first account and can write its drafts back after the switch cleared them. |

## Fixed, with part of the acceptance not run

- **P-93** (recovered and child-completion turns skip durable admission): the hosted Worker composition was not exercised live.
- **P-9** (beta and stable share update metadata): verifying the signed beta variant needs a beta release pipeline.
- **P-6** (tilde-prefixed paths become shell code): `wslpath` behaviour needs a WSL host.

## Accepted

- **H-1** — the runtime bearer stays in the privileged process. Each workspace has its own sandbox and credentials are brokered natively, so no bearer spans the host. Revisit if a host ever runs more than one workspace or brokering is unavailable.
- **M-1** — unsigned loopback MCP grants machine-owner scope. Unsigned mode is loopback-only and trusts the machine's own processes; keep the no-Origin and socket-peer checks.
- **R-1** — a header cannot prove relay provenance. The marker is provenance only; the runtime enforces authorization itself, so any relay-only policy must also live on the runtime.
- **P-108** — localhost cookies are shared across ports. Exact origins and guard order are enforced; another local port receiving the cookie is a compromised-machine scenario, and production is HTTPS on a real hostname.
