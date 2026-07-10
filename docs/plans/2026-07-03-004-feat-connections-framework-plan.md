# Connections Framework

Status: retained code-grounded reference
Last updated: 2026-07-10

This document is retained because `packages/claxedo-server/src/server.ts` and
`packages/claxedo-server/src/storage/connection.sql.ts` point here for the
connections route/storage design.

## Current Implementation

- Kit package: `packages/claxedo-connections`
- Server host composition:
  `packages/claxedo-server/src/connections-host/connections-host.ts`
- Server store adapter:
  `packages/claxedo-server/src/connections-host/store-adapter.ts`
- Route mount:
  `packages/claxedo-server/src/server.ts`
- Persistent row:
  `packages/claxedo-server/src/storage/connection.sql.ts`
- Credential backing:
  `packages/claxedo-server/src/credentials/*`

## Current Shape

`@claxedo/connections` is a kit package. It owns the integration registry,
attempt state machine, token service, reference integration implementations,
route factory, and in-memory stores for tests. The host owns persistence, auth
gates, mount path, public URL, environment reads, and which integrations are
registered.

The current claxedo-server host registers:

- Notion
- Atlassian
- GitHub
- Google when `CLAXEDO_INTEGRATION_GOOGLE_CLIENT_ID` and
  `CLAXEDO_INTEGRATION_GOOGLE_CLIENT_SECRET` are present

All integration routes are mounted under `/api/claxedo/integrations`.

## Security Gates

- Normal routes accept signed control-plane auth, with unsigned local access
  allowed only from loopback. "Loopback" means the transport peer address
  (socket), not the client-controlled Host header — see
  `isLoopbackLocalRequest` in `routes/local-only-projection.ts`.
- Token/auth-failure routes additionally require loopback and
  `x-claxedo-connections: 1`.
- The custom header keeps browser token reads non-simple/preflighted so CORS
  policy actually gates them.
- `GET /callback` is deliberately ungated: it arrives from the user's browser
  via the provider redirect, so the guards are single-use TTL-bound attempt
  state and a fixed static response page. Do not add the auth gate to it.
- Signed principals manage team connections and their own personal
  connections. Subject-less loopback callers use the team partition only, so
  they never list, manage, or resolve a personal row.
- Token resolution accepts a host-minted, short-lived
  `x-claxedo-connection-turn` credential. A valid credential carrying a
  subject may resolve that subject's personal connection; absent, expired,
  unknown, and unattended credentials resolve team connections only.

## Storage Contract

`claxedo_connection` stores non-secret connection state with a durable `id` and
an optional opaque `owner`; an absent owner is the team partition. One team row
and one personal row per owner can coexist for an integration. Secrets live in
the server credential store under provider ids such as
`integration:{connection_id}`. The service enforces this: only declared
non-secret prompt fields survive `connect()` (see
`declaredNonSecretFields` in `service.ts`).

## Tests To Check

- `packages/claxedo-connections/src/*.test.ts`
- `packages/claxedo-connections/src/impls/*.test.ts`
- `packages/claxedo-server/src/connections-host/connections-host.test.ts`
- `packages/claxedo-server/src/connections-cors.test.ts`

## Maintenance Rule

Keep this file as a short pointer to current code. Do not add product-roadmap
consumers or historical implementation logs here.
