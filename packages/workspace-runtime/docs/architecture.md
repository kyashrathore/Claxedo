# Architecture

This is the map for `@claxedo/workspace-runtime`: the five deployment
shapes, the two event systems, the harness adapter seam, and the store. Each
section links back to the README section or source file that has the
authoritative detail — this doc is the overview, not a duplicate.

## Five deployment/exposure shapes

`workspace-runtime` mounts the same per-workspace `/api/wr/*` route surface
in every shape. What changes is the trust boundary: how the socket is
exposed and who is responsible for authenticating requests before they reach
the host. All five shapes are constructed from [`src/exposure.ts`](../src/exposure.ts)
and consumed by [`startServer`](../src/server.ts) or
`createWorkspaceRuntimeApp`.

| Shape | Constructor | Trust boundary |
| --- | --- | --- |
| Local loopback / trusted local | `loopbackWorkspaceRuntimeExposure()` | Socket is loopback-only (`127.0.0.1`/`localhost`); no host-level auth required. Local dev and app-owned desktop flows. |
| Private VM runtime | `privateNetworkWorkspaceRuntimeExposure(...)` / `privateNetworkDevUnsafeWorkspaceRuntimeExposure(reason)` | Non-loopback listen inside an operator-controlled VM. Must pair with a host guard and runtime auth, or explicitly opt into the dev-unsafe path (self-managed deployments where the surrounding network is the auth boundary). |
| Relay-attached runtime | `relayWorkspaceRuntimeExposure(auth)` + `relayHostAuthFromEnv()` / `hostTunnelFromEnv()` | Verifies Relay Host Tokens (RHTs) minted by `workspace-relay`; relay-issued requests must carry `x-forwarded-by: workspace-relay`. May also maintain an outbound host tunnel back to the relay. |
| Embedded Hono app | `embeddedWorkspaceRuntimeExposure(guard)` via `createWorkspaceRuntimeApp()` | No socket of its own; mounted inside another trusted process, which owns the outer network/auth boundary and supplies the `guard`. |
| Low-level host object | `createWorkspaceHost()` / `mountWorkspaceCore()`, no `startServer()` | No socket, no exposure check. The caller owns routing, auth, lifecycle, and disposal — use only behind an existing trusted API surface. |

`startServer()` requires an explicit `exposure` and throws
(`assertWorkspaceRuntimeExposure`) if it is missing, or if the exposure kind
doesn't match the listen host (for example, a `loopback` exposure on a
non-loopback hostname). See the README's
[Supported runtime shapes](../README.md#supported-runtime-shapes) and
[Standalone listen policy](../README.md#standalone-listen-policy) sections
for the full auth/env matrix.

## Two event systems

`workspace-runtime` has two independent event surfaces with different jobs —
they are not two views onto the same stream:

- **`RuntimeEventHub`** ([`src/runtime-event-hub.ts`](../src/runtime-event-hub.ts))
  is the primary hub for session/runtime events. Session routes publish
  OpenCode-compatible `CompatEnvelope` events to its global channel; this is
  what `GET /global/event` (SSE) and `GET /api/wr/runtime-events` (SSE, raw
  `AgentRuntimeEvent` payloads via `mountWorkspaceCore()`) serve from.
- **`workspaceRuntimeBus`** ([`src/bus.ts`](../src/bus.ts)) is intentionally
  process-global runtime state, used by PTY, process, and agent-hook code
  that already lives inside the workspace-runtime process. `GET /event` and
  `GET /api/wr/events` (both SSE) serve `WorkspaceRuntimeEvent` values from
  this bus: PTY lifecycle, PTY stream summaries, process status/config
  events, agent lifecycle, session lifecycle, and heartbeats. Bus
  subscribers are isolated — a throwing subscriber is reported but cannot
  block later subscribers from receiving the same event. The product-branded
  `claxedoBus` / `ClaxedoEvent` names are deprecated aliases for the same bus,
  exported from `@claxedo/workspace-runtime/host`.

`RuntimeEventHub` bridges only terminal lifecycle states into
`workspaceRuntimeBus` as `agent.lifecycle` compatibility events (busy →
`Busy`, permission/question asks → `UserActionRequired`, `session.idle` →
`Idle`, `session.error` → `Error`) — the bridge is one-directional and
narrow, not a merge of the two systems. The README's
[Event contract](../README.md#event-contract) table has the full route list.

## Harness adapter seam

The `AgentHarnessAdapter` interface (defined in
`@claxedo/agent-sdk-runtime/adapters`, re-exported as a type from this
package's root) is the single deep seam between the host and a specific
harness — OpenCode, ACP harnesses, native SDK harnesses, or Pi. Adapter
*implementations* live in `@claxedo/agent-sdk-runtime`, not here;
workspace-runtime owns hosting, routing, target containment, config apply,
PTYs, processes, files, diffs, and relay attachment around whichever adapter
is selected.

Adapter selection is strict type-based dispatch that happens once, at host
construction time in [`src/workspace/runtime.ts`](../src/workspace/runtime.ts).
After that point the rest of the codebase calls only through the
`AgentHarnessAdapter` interface — there is no harness-type branching in the
route/call paths. The full interface, error semantics (`sendMessage` yields
`{ type: "error", error }` events on adapter faults; `abort` returns a typed
`AbortResult`; `dispose()` races a wall-clock drain timeout), and crash
recovery behavior (ACP crashes mark the affected session `"recovering"` and
emit `session.recover` without taking down the workspace) are documented in
the README's [`AgentHarnessAdapter` contract](../README.md#agentharnessadapter-contract)
section.

## The store: journal plus SQLite projection

`RuntimeStore` ([`src/store.ts`](../src/store.ts)) treats the append-only
journal as the source of truth and the rest of its SQLite schema (`session`,
`message`, `part`, `todo`, `pending_permission`, `pending_question`, …) as a
derived projection rebuilt from it:

- Every committed control/event mutation is appended as a row to the
  `runtime_journal` table (keyed by `session_id, seq`) first. Only after that
  insert succeeds does `apply()` update the projection tables and
  `journal_checkpoint`, inside one transaction. If projection fails after the
  journal append, that second transaction rolls back and a later runtime
  start rebuilds the projection from the journal via `replay()` — the
  journal row itself is never lost.
- `RuntimeStore` also understands on-disk per-session `.jsonl` files: on
  startup it imports any files under `<store>/sessions/*.jsonl` into
  `runtime_journal` (idempotently, via `INSERT OR IGNORE`) for stores
  migrating from the older flat-file journal layout, and
  `exportJournalJsonl(sessionId?)` serializes journal rows back to that same
  JSONL text shape for export/debugging.
- Startup always calls `replay()`: it resets the projection tables and
  replays every `runtime_journal` row, in `(session_id, seq)` order, back
  through `apply()`. Replay-time recovery normalization (marking `busy`
  sessions interrupted, terminalizing stale `pending`/`running` tool parts),
  multi-row event projections, session deletion, and multi-field session
  updates all run inside SQLite transactions.
- Adapters that construct their own `RuntimeStore` close it during adapter
  disposal; callers that inject their own store instance remain responsible
  for closing it themselves.

See the README's [Runtime store durability](../README.md#runtime-store-durability)
section for the durability guarantee stated at the product level.
