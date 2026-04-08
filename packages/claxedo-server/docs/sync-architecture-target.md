# Sync Architecture (Target RFC)

Status: draft proposal  
Scope: future architecture, not implemented yet

## Goals

1. Keep local UX fast while supporting multi-device state.
2. Make sync behavior explicit, observable, and repairable.
3. Avoid dual-writer ambiguity by defining a single canonical owner per entity.
4. Enable gradual rollout to a cloud-backed metadata store without breaking current flows.
5. Keep storage backend swappable (`SyncDB`) so we can start with SQLite and later move to a remote store.

## Non-Goals

- Turning all runtime data into globally replicated state.
- Replacing live runtime event streaming with DB polling.
- Migrating PTY I/O into central storage.

## Target Source of Truth

| Entity | Canonical owner (target) | Derived/cache copies |
|--------|---------------------------|----------------------|
| Session metadata | Central metadata store via `SyncDB` (`sessions`) | Local read cache allowed |
| Message history | Central metadata store via `SyncDB` (`messages`, `message_parts`) | Runtime replay cache allowed as non-canonical optimization |
| PTY/terminal metadata | Central metadata store via `SyncDB` (`pty_sessions`) | Runtime in-memory state + local disk scrollback cache |
| Process definitions | Central process config store (`process_definitions`) | Workspace/runtime view derived dynamically from central definitions + active workspace context |
| Workspace registry metadata | Central metadata store via `SyncDB` (`workspaces`) | Local cache allowed |
| Pages | Central metadata store via `SyncDB` | Local cache allowed |
| Workgraph metadata | Central metadata store via `SyncDB` | Local cache allowed |
| App/user config (skills, MCP, auth config metadata) | Central metadata store via `SyncDB` | Runtime in-memory cache allowed |

Hard rule: one canonical writer per entity. Any mirrored copy must be treated as derived data.

Product note:

- Multi-device message continuity is default behavior (no explicit handoff button required).
- Closing laptop and reopening on mobile should read from central message history.
- PTY metadata is synchronized centrally.
- Local PTYs are never recreated cross-device; cloud PTYs may reconnect.

## Locality Envelope (Required Fields)

For entities that represent runtime-bound state (sessions, messages, PTYs, pages/workgraph runs when runtime-bound), include:

- `workspace_id`
- `runtime_kind` -> `local | cloud`
- `runtime_url` -> nullable; required when `runtime_kind=cloud`
- `runtime_id` -> nullable runtime/sandbox identifier

## SyncTarget Contract

The sync interface should be explicit and idempotent:

- `upsertSession(input)`
- `deleteSession(input)`
- `upsertSessionsBulk(input[])`
- `upsertWorkspace(input)`
- `upsertMessage(input)` / `upsertMessagePart(input)` / `upsertMessagesBulk(input[])`
- `upsertPtySession(input)` / `deletePtySession(input)`
- `upsertProcessDefinition(input)` / `deleteProcessDefinition(input)`
- `upsertPage(input)`
- `upsertWorkgraphMeta(input)`
- `upsertUserConfigMeta(input)` (skills/MCP/auth config metadata)

Each method should accept:

- stable primary key (`session_id`, `workspace_id`, etc.)
- `updated_at` for last-write-wins
- optional `source` metadata for audit/debug
- idempotency key when event-driven delivery is used

## Consistency Model (Target)

- Metadata writes (sessions, workspaces, process defs, pages, workgraph, config metadata) are fail-closed for mutating APIs after cutover.
- Read path is strongly consistent with canonical backend for metadata endpoints.
- Message history is canonical in central store; replay cache is best-effort acceleration only.
- Runtime event streams remain real-time transport, not canonical persistence.
- PTY restore policy:
  - `local`: metadata visible cross-device, no auto-recreate/attach.
  - `cloud`: reconnect/reattach allowed when runtime is alive.

Target SLOs:

- Session metadata write success: >= 99.9% over 24h.
- Session metadata read freshness: P95 <= 1s.
- Replay availability lag: P95 <= 1s; fallback <= 1%.

## Cloud Workspace Interception (Target)

For cloud `/session*` routes proxied to workspace-runtime:

- Intercept non-streaming responses for `POST/GET/PATCH/DELETE /session*`.
- Parse response bodies and emit `SyncTarget` upserts/deletes.
- Preserve original response semantics and latency budget.
- Never mutate response payload returned to client.

If parse fails:

- return original response unchanged
- emit sync failure metric/log with path and workspace/session identifiers
- trigger repair job from periodic list reconciliation

## Message History Strategy (Target)

Central persistence is mandatory; replay cache is optional:

- Persist `message.updated` / `message.part.updated` into central store on ingestion path.
- Keep replay table as local acceleration cache and recovery buffer.
- On cache miss, read from central store (not runner runtime as canonical source).
- Add dedupe guards by `(session_id, message_id, part_id?)` and idempotency keys for retries.

## PTY Strategy (Target)

Central persistence is metadata-only:

- Persist PTY lifecycle metadata (`created/updated/exited/deleted`, command/title/cwd, status, exit code, timestamps, runtime locality fields).
- Do not make full PTY stdout/stderr stream globally canonical.
- Keep scrollback/history local by default; cloud runtime reattach can provide continuity for cloud PTYs.
- UI restore behavior:
  - local PTY from another device -> show `unavailable (local-only)` + offer "start new terminal".
  - cloud PTY -> reconnect if runtime reachable, otherwise show ended state.

## Rollout Plan

### Phase 0: Contracts + Observability

- Land `SyncTarget` + `SyncDB` interfaces with backend swappability.
- Ship `SQLiteSyncDB` as default implementation (in-app DB for now).
- Add metrics/log fields defined in current architecture doc.
- Add dashboards and alerts before behavior changes.

### Phase 1: Central Layer on SQLite (No Behavior Change)

- Route session metadata + message history writes through `SQLiteSyncDB`.
- Route PTY metadata writes through `SQLiteSyncDB` with locality envelope fields.
- Route process definitions/pages/workgraph/config metadata writes through same layer.
- Keep behavior equivalent to today.
- Validate no regression in list composition, restore flows, and replay fallback rates.

Implementation note:

- SQLite remains local in-app for now.
- Optional short-term path: allow user-hosted SQLite over tunnel for cross-device experiments.

### Phase 2: Cloud Proxy Interception

- Add cloud `/session*` response interception and SyncTarget calls.
- Add reconciliation worker for missed events/responses.
- Prove parity against runtime list snapshots.

### Phase 3: Remote SyncDB Adapter (Shadow)

- Implement remote adapter (for example `ConvexSyncDB`).
- Shadow-write to remote while SQLite remains read source.
- Compare row counts/checksums/freshness windows continuously.

### Phase 4: Remote Read Cutover

- Switch metadata + message history reads to remote behind scoped rollout flag.
- Keep dual writes during canary.
- Roll back instantly on lag/error SLO breach.

### Phase 5: Cleanup

- Remove obsolete write paths.
- Update docs so current-state and target-state are in sync.

## Guardrails

- No schema change without migration + backward compatibility plan.
- No dual-write cutover without parity dashboard and rollback switch.
- No fail-closed mutation path until retry + alerting + repair are in place.

## Test Plan

Required coverage before cutover:

- Unit tests for SyncTarget idempotency and LWW behavior.
- Integration tests for cloud proxy interception and body parsing failures.
- Failure-mode tests: backend down, partial timeouts, malformed payloads.
- Consistency tests for metadata freshness and replay fallback behavior.
- Rollback test proving feature-flag disable restores prior path.

## Open Decisions

1. Exact remote backend choice for `SyncDB` (Convex vs alternative).
2. Exact boundary for auth config data: metadata-only vs encrypted secret payload ownership.
3. Rollout policy for user-hosted SQLite-over-tunnel experiments (supported vs unsupported preview).
4. PTY history retention policy for cloud reconnect (metadata-only vs bounded snippet cache).
