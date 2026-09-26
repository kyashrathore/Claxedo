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
| P-138 — Old token helpers were replaced or tightened | Informational | Keep strict principal validation and the tests that only trusted service code can mint service tokens (`packages/claxedo-server-core/src/authority/adapters/sqlite/workspace-authority.ts`, `packages/claxedo-server/src/authority/adapters/d1/host-access-authority.ts`). Remove dead paths rather than keep two token authorities. |
| P-119 — Missing subscription timestamp becomes arrival time | Low integrity | Timestamp-less webhooks are rejected (`packages/claxedo-server/src/billing/apply-polar-state.ts`). The billing provider's own ordering of events that do carry timestamps is not exercised by the in-process store and is unverified live. |

## Fixed, with part of the acceptance not run

- **P-93** (recovered and child-completion turns skip durable admission): the hosted Worker composition was not exercised live.
- **P-9** (beta and stable share update metadata): verifying the signed beta variant needs a beta release pipeline.
- **P-6** (tilde-prefixed paths become shell code): `wslpath` behaviour needs a WSL host.

## Accepted

- **H-1** — the runtime bearer stays in the privileged process. Each workspace has its own sandbox and credentials are brokered natively, so no bearer spans the host. Revisit if a host ever runs more than one workspace or brokering is unavailable.
- **M-1** — unsigned loopback MCP grants machine-owner scope. Unsigned mode is loopback-only and trusts the machine's own processes; keep the no-Origin and socket-peer checks.
- **R-1** — a header cannot prove relay provenance. The marker is provenance only; the runtime enforces authorization itself, so any relay-only policy must also live on the runtime.
- **P-108** — localhost cookies are shared across ports. Exact origins and guard order are enforced; another local port receiving the cookie is a compromised-machine scenario, and production is HTTPS on a real hostname.
