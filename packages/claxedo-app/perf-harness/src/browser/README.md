# Browser benchmark ownership

`runBrowser` in `../browser-runner.ts` schedules the selected scenarios,
collects each run, applies gates, and publishes evidence. Its `flowDrivers` map
connects the flow catalog to the scenario functions here.

| Owner | Responsibility |
| --- | --- |
| `environment.ts` | Production build, app server and Chromium lifetime, benchmark viewport, video cleanup |
| `fixtures.ts` | Deterministic workload data: sessions, transcript parts, files, diffs, and workspace labels |
| `mock-api.ts` | Register HTTP/WebSocket routes, enforce response and paging contracts, and account for requests |
| `mock-streams.ts` | Serve persistent SSE with canonical route envelopes and isolated page leases; app shutdown closes the listener |
| `state.ts` | Install initial persisted workbench state and construct navigation paths |
| `page-validation.ts` | Collect browser errors and validate visible application/transcript evidence |
| `diagnostics.ts` | Start, sample, stop, and merge the real process-tree profiler |
| `actions/` | Reusable navigation, session, review, workspace, and terminal operations |
| `scenarios/` | Measured interaction sequences and their family-specific contracts and tests |

The memory lane and diagnostic probes import these owners directly. They do
not load browser scheduling, budget evaluation, or publication to prepare a
fixture or drive a control. Diagnostic entrypoints live in `../../probes/`;
the session-switch and review-revive probes share their setup in
`../../probes/support/session-switch.ts`.

Keep scenario policy in the scenario: workload size, measurement start/end,
temperature, and required restoration evidence belong beside its contract.
An action implements the shared UI operation. Preserve distinct diagnostic
timeouts explicitly at the caller when reusing an action.

The heavy-workspace family measures the physical top-level reopen onto Review,
checks retained tab inventory and Review state, then explicitly activates the
saved file outside that window to verify its exact content and selection.
Review resume measures the following file-to-Review tab activation.

The session-switch-workspace family keeps cold sessions unvisited. Each cold
cell leaves home's closed/file/Review presentation for a new session whose
panel is closed; each warm cell returns to home's saved presentation. Session
readiness, outgoing surface release, destination closure, and saved-content
restoration have independent clocks. DOM disposal is expected at these
presentation changes; the same-workspace resource gate still requires cached
VCS, file, and workspace data to be reused.

Functions passed to Playwright `evaluate` or `waitForFunction` run in the page.
Their runtime dependencies must remain inside the serialized function or be
supplied through its argument; importing a Node-side helper into that callback
does not make the helper available in the browser.

`topology.test.ts` enforces an acyclic browser module graph and prevents
memory/probe imports of the orchestrator. `mock-api.test.ts` exercises installed
route handlers, including response cursors, rejected input, missing routes,
preflight accounting, private SSE forwarding, and independent page fixtures.
`mock-streams.test.ts` exercises real HTTP streams, heartbeat intervals,
disconnection, scope isolation, and shutdown. The colocated scenario
tests retain the benchmark's workload, timing, ownership, and readiness checks.

From `packages/claxedo-app/perf-harness`, run the focused checks with native Bun
HTTP globals (the app's HappyDOM preload replaces `Response` and `fetch`):

```sh
bun test ./src/browser ./test/runner.test.ts ./test/mock-message-page.test.ts
bun run typecheck
```
