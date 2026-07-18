# WorkGraph compatibility boundary

WorkGraph V2 is the production and published WorkGraph surface. Local Claxedo mounts its embedded SQLite composition at `/api/workgraph`; the implemented Claxedo Cloud composition mounts the hosted Convex adapter at the same path. The app and standalone stdio MCP use its authenticated HTTP contract. Local embedded agent tools, background workers, and execution adapters invoke the same command and query services directly under trusted `(organization, user)` scope. Hosted embedded tools require durable Session tenant provenance. Cloud release acceptance remains pending until the composition is deployed and passes signed cross-tenant and browser verification.

## Published entrypoints

| Entry                            | Scope                                                                                                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@claxedo/workgraph`             | V2 application services, ports, SQLite composition, HTTP router, backend candidate admission, portable archive operations, and explicit legacy migration operations |
| `@claxedo/workgraph/contracts`   | Browser-safe V2 commands, records, events, IDs, and execution contracts                                                                                                     |
| `@claxedo/workgraph/domain`      | Browser-safe lifecycle and completion rules                                                                                                                                 |
| `@claxedo/workgraph/hosted`      | Worker-safe hosted service and HTTP composition                                                                                                                             |
| `@claxedo/workgraph/connectors`  | Source-issue connectors authorized through live Connections capabilities                                                                                                    |
| `@claxedo/workgraph/matching`    | Browser-safe matching helpers                                                                                                                                               |
| `@claxedo/workgraph/ports`       | Runtime-neutral adapter ports                                                                                                                                               |
| `@claxedo/workgraph/conformance` | Backend-neutral adapter conformance cases                                                                                                                                   |

Every maintained production module is reachable from these entries or from one of the explicitly retained internal roots verified by `public-entrypoints-boundary.test.ts`. Claxedo server startup composes the package root and hosted entries through the Session V2 gateway and Connections capability boundary.

## Migration surface

`exportLegacyWorkGraphMigration` and `applyLegacyWorkGraphMigration` are explicit migration operations. They read supported legacy SQLite records, copy provable local Work Sources, place ambiguous work into migration intake, and count credential records without copying credential values.

The migration window retains these repository inputs:

- `src/adapters/sqlite/legacy-migration.ts` for export and apply behavior;
- `src/sqlite.ts` for SQLite host compatibility;
- `src/db/schema.ts` as the dependency-free legacy schema fixture;
- `test/sqlite-legacy-migration.test.ts` for credential exclusion, idempotency, collision detection, rollback, and preservation proof.

The legacy schema fixture owns static DDL only. Runtime graph, scheduler, provider-token, HTTP, MCP-planner, and event-substrate behavior belongs to the V2 composition and its maintained adapters.

## Portable archive surface

Core adapter conformance version 6 covers tenant isolation, atomic commands, opaque tenant-and-filter-bound cursors, ordered snapshots and changes across adapter restart, leases, Attempt runtime recovery, source-revision replacement fencing, Session-binding idempotency, and bounded Task-activity pagination. Archive conformance version 1 separately covers canonical tenant export/restore, exact retry, and rejection of cross-tenant, non-empty, conflicting, malformed, or secret-bearing restores.

SQLite and Convex implement the archive port, workspace cleanup, and organization/user-level permanent deletion. Stream visibility archive is a separate lifecycle presentation state and does not perform portable export. Cloud release acceptance remains gated on the ordered Convex-functions, Worker, and app staging deployment followed by signed policy and browser verification.

## Credential boundary

WorkGraph stores Connection references, the user's provider identity mapping, saved filters, and secret-free receipts. Connections owns organization credentials and metadata, connected-account authority, refresh, and health. Provider secrets and local CLI credentials stay outside WorkGraph records, snapshots, migration output, and public API responses.

Static graph tests require the maintained source set to remain reachable, keep compatibility-only packages out of source and package metadata, and retain the explicit migration proof. Server reachability tests require production startup to mount the embedded V2 service.
