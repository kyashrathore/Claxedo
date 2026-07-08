# @claxedo/wakes

Resume an idle agent session from an **out-of-band trigger** — a durable *wake*
fired by time, an external event, or an authorized approval. No resident process,
no durable-execution engine.

In-chat dialogue is the harness's job (an idle session resumes on its next
message). This layer handles only the resumptions the harness can't: a timer, a
webhook/CI event, or an approval that arrives from another surface.

```ts
import { createWakes, createScheduler, SqliteWakeStore } from "@claxedo/wakes"

const wakes = createWakes({
  store: new SqliteWakeStore({ path: "wakes.db" }),
  spawnTurn: async (sessionId, result) => host.resumeSession(sessionId, result),
  authorize: async (actor, workspaceId) => host.canApprove(actor, workspaceId),
  computeNextRun: (cron, after) => parseCron(cron, after), // only if you use cron
})

// three ways to create a wake
wakes.schedule({ sessionId, workspaceId, at: Date.now() + 3 * 864e5, intent: { note } })
wakes.watch({ sessionId, workspaceId, eventKey: "ci:pass:x", intent, expiresAt })
const { token } = wakes.requestApproval({ sessionId, workspaceId, prompt, expiresAt })

// three fire sources
createScheduler(wakes).start()          // 'at'  — heartbeat drives runDue()
await wakes.deliverEvent("ci:pass:x", payload) // 'on_event' — host webhook ingress
await wakes.resolve(token, answer, actor)      // 'on_approval' — inbound handler

// turn-side: make an irreversible external effect at-most-once across re-runs
await wakes.once(sessionId, "open-pr:branch-x", () => host.openPr(branch))
```

## Model

A **wake** is a durable row: *resume session S when trigger T fires, injecting a
result*. One lifecycle (`pending → firing → fired`), three trigger types (`at`,
`on_event`, `on_approval`). All three converge on one guarded firing path,
re-driven on boot, so a wake fires at-least-once and never drops its result on a
crash. Storage is a `WakeStore` port; a `better-sqlite3` adapter ships here.

See `docs/plans/2026-07-07-006-feat-wakes.md` for the full design.

## License

MIT
