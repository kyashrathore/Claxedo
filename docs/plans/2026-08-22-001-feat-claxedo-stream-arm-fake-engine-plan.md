# Claxedo stream benchmark arm — fake-engine composition

Status: PLANNED. Owner: benchmark campaign (perf branch). Prereq reading:
`packages/claxedo-app/perf-harness/compare/EXPERIMENTS.md` (2026-08-22 entry),
`docs/experiments-index.md`.

## Problem

`stream.interaction_p95_ms` and `stream.blocked_frame_ratio_pct` have never
been measured on Claxedo. The existing `controlled-stream-v1` scenario
(`perf-harness/src/agent-stream-scenario.ts`) PATCHes the engine's
`updatePart` HTTP route — a surface that only exists when the opencode engine
runs as a standalone HTTP server. The packaged app uses the embedded
composition (in-process transport, `opencodeRequest`), so there is no engine
HTTP to hit: the claxedo server exposes only `/session` list/create and the
message prompt route. Verified empirically 2026-08-22 (route probe: message
and part routes 404 on `launch.serverUrl`).

## Design — the T3-equivalent seam

T3's arm points the T3 app at a scripted opencode-engine surface
(`t3code/scripts/lib/agent-app-benchmark/replay/opencode-server.ts`, 494
lines) and replays the corpus turn through the app's real ingestion path.
Claxedo has the same seam available: `OPENCODE_URL` (read by
`claxedo-server/src/hosts/workspace-runtime/runtime-boot.ts:112`) switches the
`OpenCodeHarnessAdapter` from the in-process transport to an external engine
URL. The conversation profile should launch the app with `OPENCODE_URL`
pointing at a harness-hosted fake engine, so the REAL adapter -> runtime event
hub -> claxedo events -> renderer pipeline streams the corpus turn.

## Contract the fake engine must serve

From `packages/agent-sdk-runtime/src/harnesses/opencode/index.ts` (+
`events.ts`), the adapter calls exactly:

- `GET /global/event` — SSE stream (the turn's part/message events go here)
- `GET|POST /session`, `GET|PATCH|DELETE /session/{id}`
- `GET /session/{id}/message` — transcript (message + parts shapes as the
  vendored engine emits them; reuse the materializer's payload shapes)
- `POST /session/{id}/prompt_async` — accept, then replay the corpus stream
  turn's lifecycle events over SSE with the corpus `atMs` timing
- `GET /session/status`, `/mcp`, `/permission`, `/question` — static/empty
- `abort`/`command`/`fork`/`revert`/`unrevert`/`todo` — inert 200s

Scope: serve the STREAM session (order-sorted first corpus session) fully;
empty lists elsewhere. The rail inventory is independent (seeded
`claxedo_session_meta`), so only the stream session's surface is activated.

## Scenario rewrite

`runControlledStreamScenario` sends one real prompt through the app (or
`prompt_async` on the fake), then measures with the EXISTING
`beginStreamObservation`/`finishStreamObservation` (Event Timing + LoAF —
unchanged). Validity binds to the fake engine's emission log (harness-side
ground truth for expected events) plus the existing paint probes.

## Definition of done

1. `--profiles conversation-rich-v1` on `graded-v1` produces VALID
   `stream.interaction_p95_ms` and `stream.blocked_frame_ratio_pct` samples
   against the packaged app on a quiet, user-idle host.
2. The replayed turn's rendered text is verified against corpus content
   (part-granular, same discipline as the workspace profile).
3. Both T3 and Claxedo stream arms run against the same corpus stream events
   (identical event counts; ledger records the comparison).
4. No app-code changes required (composition-only via `OPENCODE_URL`); if any
   app change proves necessary, it lands as its own reviewed slice.

## Risks

- Dialect drift between the vendored engine's API and the adapter's parsing —
  build response shapes from the adapter source, not from T3's replay server.
- `OPENCODE_URL` applies to every workspace in the launch; keep the fake's
  non-stream surfaces well-behaved (empty, fast) so the other workspaces'
  adapters stay quiet.
- Foreground guard: measured runs need a user-idle host (runs invalidate on
  "application lost foreground" — correct behavior, plan around it).
