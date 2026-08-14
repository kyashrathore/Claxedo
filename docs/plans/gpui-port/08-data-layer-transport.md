# 08 — Data layer & transport

## Scope
The Rust query/cache layer, SSE event stream, request discipline, and
persistence — the renderer-side data plane.

## Current implementation (port the LESSONS — all measured this session)
- Query defaults + persister: `packages/claxedo-app/src/platform/query/**`
  (staleTime map in `query-stale-times.ts`? — see H1 3 s dedupe constant in
  `features/session/data/sync/inventory-source.ts`), single-flight patterns
  (`route-bridge-resolution.ts`, workspace-resolve), structural gating
  (`useWorkspaceQuery` — never fire before workspace-ready; the fire-and-
  fail 404 class).
- Boot request graph: 39 requests (request-log lane, `browser-runner.ts`
  CLAXEDO_PERF_REQUEST_LOG) — this is the CONTRACT the Rust client must not
  regress; the per-request stack attribution method transfers.
- Event stream: global-sync SSE with 16 ms coalescer (`createEventCoalescer`)
  and per-session version signals (`conversation-registry.ts`).

## Target design
- One crate: typed client for the server's routes (generate from the same
  OpenAPI/SDK the TS client uses — `sdk.gen.ts`'s source), with: dedupe by
  key + staleTime, in-flight single-flight, structural enablement gates,
  disk persistence of the persisted-query subset, and a boot-request-count
  regression TEST (≤ 39, from a recorded fixture server).
- SSE consumer with frame-coalesced delivery into per-session channels
  (03 consumes); reconnect with the repair semantics from 05.

## Acceptance
Boot request log ≤ 39 identical semantic requests against the fixture
server; zero 4xx at boot; event→paint p95 within 03's streaming budget.
