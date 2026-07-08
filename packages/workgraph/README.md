# @claxedo/workgraph

**An event-sourced work inbox for AI agents.**

One inbox for issues from GitHub, Linear, and Jira. Stage what agents should
work on. Run attempts with any agent runner. Answer blocking questions. Sync
results back to the tracker your team already uses — with a full audit log of
what happened and who (human or agent) did it.

```sh
npm install @claxedo/workgraph
```

## Why

Your issues live in three trackers. Your agents can't triage any of them.
Existing agent-orchestration tools give you 1-issue→1-agent with mutable
state and no history. `workgraph` gives you:

- **One inbox, many trackers** — GitHub, Linear, Jira connectors included; a
  new connector is one small interface (`queryIssues` / `hydrateIssue` /
  `updateIssue` / `addComment` / `createIssue`).
- **Mirrored vs staged** — sync everything matching a filter (safe firehose:
  the mirror is a disposable projection), then deliberately *stage* what
  agents may touch. Nothing runs by accident.
- **Event-sourced** — every state change is an event with actor provenance
  (`user:* | agent:* | system`). Replayable, auditable. No last-write-wins
  mystery.
- **Attempts, not mutations** — starting a card creates an attempt (worktree +
  session). Retry = a new attempt; old ones are preserved evidence.
- **The needs-you loop** — four typed interrupts (blocking question,
  approval, review-ready, failed) on one queue, answerable programmatically
  or over the HTTP/MCP surface.
- **Sync-back you control** — per-connection policy: `silent` (write nothing
  back), `announce` (comment when work finishes), or `full` (status
  transitions too). Receipts recorded for every external write.
- **Headless** — a SQLite file and a TypeScript API. No server, no UI, no
  daemon required. Bring your own runner and your own frontend. (An HTTP app
  — `createApp` — and MCP tool registration ship in the box when you want
  them.)

## Quickstart

```ts
import { createWorkGraph, github } from "@claxedo/workgraph"

const wg = createWorkGraph({ db: "./work.db" })

// 1. Connect sources (filtered firehose — raw GitHub search syntax)
await wg.connect(github({ token, query: "repo:acme/app is:open label:bug" }), {
  syncBack: "announce",
})
await wg.sync() // idempotent mirror

// 2. Triage: browse the mirror, stage what agents may work on
const [bug] = wg.items({ status: "new", label: "bug" })
await wg.stage(bug.id, {
  context: "Repro is in the linked Slack thread. Fix + regression test.",
  loadout: "fix-bug", // agent config name — your runner decides what it means
})

// 3. Execute: bring your own runner (Claude Code, OpenCode, anything)
wg.executor({
  launch: async ({ item, attempt, prompt }) => {
    const session = await myRunner.spawn({ prompt, cwd: attempt.worktree })
    return { sessionId: session.id, worktree: attempt.worktree }
  },
})
const { runId, nodeId } = await wg.start(bug.id)

// 4. The needs-you loop (poll on your cadence; on() fires for new interrupts)
wg.on("interrupt", async (q) => {
  // q.kind: "question" | "approval" | "review" | "failure"
  if (q.kind === "question") await wg.answer(q.id, "Use approach B.")
})
await wg.poll()

// 5. Done → sync-back (announce policy: one comment on the source issue)
```

## The model

```text
Connection (github / linear / jira / claxedo)
   └─ WorkItem        durable card; mirror of a source issue (or native)
        └─ Attempt    one try: worktree + session, preserved on retry
             └─ Session   your runner's execution
```

Item status and execution status are **two independent state machines**;
illegal transitions are rejected (a finished attempt cannot un-finish). The
flat status you see is derived, not stored.

Every mutation is an event with provenance:

```ts
wg.events(item.id)
// item_created (actor: user:yash) → item_updated (staged, actor: user:yash)
// → item_updated (in_progress, actor: system) → item_updated (done)
```

## Native items (no external tracker)

The built-in `claxedo` provider implements the same connector interface
against the local store and is **connected by default** — `create` works on a
fresh `createWorkGraph()` with zero setup:

```ts
await wg.create({ title: "Spike: swap the JSON parser", label: "chore" })
```

**One `create`, for humans and agents.** There is exactly one creation call;
provenance comes from the caller's identity (`actor` option / MCP caller),
not from separate methods. A human quick-add and an agent filing follow-up
work mid-run emit the same `item_created` event, differing only in `actor`.

## Auto-triage rules

```ts
await wg.policy({
  when: { source: "github", label: "P1" },
  then: { stage: true, loadout: "fix-bug" },
})
```

Rules apply to newly mirrored cards on `sync()`. (Concurrency caps are on the
roadmap, not shipped.)

## HTTP + MCP surfaces

The same engine ships as a Hono app (`createApp`) — item/slice/connection
routes, run execution, decisions, triage — and as MCP tools
(`registerWorkGraphTools`) so agents can read scratchpads, write findings,
and report status (`workgraph_update_status`, `workgraph_write_scratchpad`,
`workgraph_create_artifact`, …). Supervisor agents can triage the backlog
through the same tools humans use over HTTP.

## Writing a connector

```ts
import type { ConnectorInterface } from "@claxedo/workgraph"

export const myTracker: ConnectorInterface = {
  provider: "mytracker",
  queryIssues(mode, params) { /* firehose search → ProviderPreview[] */ },
  hydrateIssue(params)      { /* one issue → NormalizedIssue */ },
  updateIssue(params, patch){ /* sync-back: status/title/body */ },
  addComment(params, body)  { /* sync-back: announce receipts */ },
  createIssue(params, data) { /* optional: push native items out */ },
}
```

For hosted setups the recommended form is `github({ getToken })` — a
token-supplier seam shaped like `@claxedo/connections`' `CapabilityHandle`:

```ts
github({
  getToken: () => handle.getToken().then((r) => r.token), // resolved per request — rotation just works
  reportAuthFailure: (reason) => handle.reportAuthFailure(reason), // 401 marks the credential broken
  query: "repo:acme/app is:open label:bug",
})
```

This wires a plain-fetch executor against `api.github.com`, so **no Composio
account is needed when you bring your own token supply**. Alternatively,
GitHub ships wired through Composio's proxy (`github({ token })`) or any
custom `executor` you provide; Linear and Jira take a thin `client` you
construct (see `LinearConnector` / `JiraConnector` client interfaces).

## What this is not

- **Not a DAG engine.** No dependency edges gate execution. `parentId` gives
  you fan-out (a goal card with child cards); ordering between cards is a
  human decision. We deleted our DAG; the market data says you won't miss it.
- **Not a UI.** Headless by design. (Claxedo ships an inbox UI on top.)
- **Not a tracker.** Your tracker stays the system of record; the mirror is
  disposable and rebuildable.

## License

MIT
