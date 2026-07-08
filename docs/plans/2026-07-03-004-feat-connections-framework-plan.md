# Connections Framework

Status: retained code-grounded reference
Last updated: 2026-07-09

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
  allowed only from loopback.
- Token/auth-failure routes additionally require loopback and
  `x-claxedo-connections: 1`.
- The custom header keeps browser token reads non-simple/preflighted so CORS
  policy actually gates them.

## Storage Contract

`claxedo_connection` stores non-secret connection state keyed by
`integration_id`. Secrets live in the server credential store under provider ids
such as `integration:{integration_id}`.

## Tests To Check

- `packages/claxedo-connections/src/*.test.ts`
- `packages/claxedo-server/src/connections-host/connections-host.test.ts`
- `packages/claxedo-server/src/connections-cors.test.ts`

## Maintenance Rule

Keep this file as a short pointer to current code. Do not add product-roadmap
consumers or historical implementation logs here.
