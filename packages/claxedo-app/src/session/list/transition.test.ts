/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId, projectId, sessionId, type ListedStatus, type ProjectId, type SessionRow } from "@/server"
import { nativeHarness } from "@/lib/harness-selection"
import { initialListState, type FetchedPage, type FetchedWindow, type ListState } from "./model"
import { listTransition } from "./transition"
import { visibleOrder } from "./visible-rows"

const ALPHA = projectId("prj_alpha")
const BRAVO = projectId("prj_bravo")

function row(project: ProjectId, id: string, createdAt: number, lastHumanTurnAt?: number): SessionRow {
  return {
    ref: { projectId: project, placementId: placementId(`${project}_folder`), sessionId: sessionId(id) },
    title: id,
    createdAt,
    updatedAt: createdAt,
    ...(lastHumanTurnAt === undefined ? {} : { lastHumanTurnAt }),
  }
}

function page(project: ProjectId, rows: SessionRow[], nextAfter?: string, statuses: Array<[string, ListedStatus]> = []): FetchedPage {
  return { projectId: project, rows, nextAfter, degraded: false, statuses: new Map(statuses.map(([id, status]) => [sessionId(id), status])) }
}

function window(pages: FetchedPage[], failures: FetchedWindow["failures"] = [], sentAt = 1_000): FetchedWindow {
  return { pages, failures, sentAt }
}

function run(state: ListState, ...events: Parameters<typeof listTransition>[1][]): ListState {
  return events.reduce(listTransition, state)
}

const shown = (state: ListState) => visibleOrder(state).map((ref) => ref.sessionId as string)

test("a project's rail is its first page, in the server's order, with nothing past the page's last row", () => {
  const state = run(
    initialListState,
    { type: "fetchStarted" },
    {
      type: "fetched",
      window: window([
        page(ALPHA, [row(ALPHA, "a1", 30, 90), row(ALPHA, "a2", 50)], "cursor-a"),
        page(BRAVO, [row(BRAVO, "b1", 10)]),
      ]),
    },
    { type: "sessionUpserted", row: row(ALPHA, "a-older", 20) },
    { type: "sessionUpserted", row: row(ALPHA, "a-newer", 60) },
  )

  expect(shown(state)).toEqual(["a1", "a-newer", "a2", "b1"])
})

test("a session's saved harness and model survive a newer row that does not carry them, and a row that does replaces them", () => {
  const read = { ...row(ALPHA, "a1", 30), harness: nativeHarness("pi"), model: { providerId: "pi", modelId: "anthropic/claude-opus-4-8" } }
  const listed = run(initialListState, { type: "fetchStarted" }, { type: "fetched", window: window([page(ALPHA, [row(ALPHA, "a1", 30)])]) }, { type: "rowRead", row: read })
  const kept = run(listed, { type: "sessionUpserted", row: { ...row(ALPHA, "a1", 30), updatedAt: 40 } })
  const entry = kept.kind === "live" ? kept.entries.get(sessionId("a1")) : undefined
  expect(entry?.kind === "confirmed" ? [entry.row.updatedAt, entry.row.harness, entry.row.model] : undefined).toEqual([40, read.harness, read.model])
  const replaced = run(kept, { type: "sessionUpserted", row: { ...row(ALPHA, "a1", 30), updatedAt: 50, harness: nativeHarness("codex") } })
  const next = replaced.kind === "live" ? replaced.entries.get(sessionId("a1")) : undefined
  expect(next?.kind === "confirmed" ? [next.row.harness, next.row.model] : undefined).toEqual([nativeHarness("codex"), undefined])
})

test("a session read older than the row it meets never rolls back the row's selections", () => {
  const selected = { ...row(ALPHA, "a1", 30), updatedAt: 50, harness: nativeHarness("claude"), model: { providerId: "claude", modelId: "default" }, permissionMode: "plan" }
  const listed = run(initialListState, { type: "fetchStarted" }, { type: "fetched", window: window([page(ALPHA, [selected])]) })
  const stale = run(listed, { type: "rowRead", row: { ...selected, updatedAt: 45, permissionMode: "default" } })
  const entry = stale.kind === "live" ? stale.entries.get(sessionId("a1")) : undefined
  expect(entry?.kind === "confirmed" ? [entry.row.updatedAt, entry.row.permissionMode] : undefined).toEqual([50, "plan"])
})

test("a session read older than the row it meets gives the row none of its selections", () => {
  const listed = run(initialListState, { type: "fetchStarted" }, { type: "fetched", window: window([page(ALPHA, [{ ...row(ALPHA, "a1", 30), updatedAt: 50 }])]) })
  const stale = run(listed, { type: "rowRead", row: { ...row(ALPHA, "a1", 30), updatedAt: 45, harness: nativeHarness("claude"), permissionMode: "plan" } })
  const entry = stale.kind === "live" ? stale.entries.get(sessionId("a1")) : undefined
  expect(entry?.kind === "confirmed" ? [entry.row.updatedAt, entry.row.harness, entry.row.permissionMode] : undefined).toEqual([50, undefined, undefined])
})

test("an unsigned send that changes the session's mode keeps its place through the mode write and returns to the server's place when its turn starts", () => {
  const listed = run(
    initialListState,
    { type: "fetchStarted" },
    { type: "fetched", window: window([page(ALPHA, [row(ALPHA, "a2", 50, 50), { ...row(ALPHA, "a1", 30, 30), harness: nativeHarness("claude"), permissionMode: "default" }])]) },
    { type: "sendStarted", sessionId: sessionId("a1"), clientRequestId: "send-1", at: 100 },
  )
  expect(shown(listed)).toEqual(["a1", "a2"])
  const moded = run(listed, { type: "sessionUpserted", row: { ...row(ALPHA, "a1", 30, 30), updatedAt: 90, harness: nativeHarness("claude"), permissionMode: "plan" } })
  expect(shown(moded)).toEqual(["a1", "a2"])
  const started = run(moded, { type: "sessionUpserted", row: { ...row(ALPHA, "a1", 30, 30), updatedAt: 95, harness: nativeHarness("claude"), permissionMode: "plan" } })
  const entry = started.kind === "live" ? started.entries.get(sessionId("a1")) : undefined
  expect(entry?.kind === "confirmed" ? [entry.pendingSend, entry.row.permissionMode] : undefined).toEqual([undefined, "plan"])
  expect(shown(started)).toEqual(["a2", "a1"])
})

test("a signed send that changes the session's mode stays on top through the mode write and its human turn", () => {
  const listed = run(
    initialListState,
    { type: "fetchStarted" },
    { type: "fetched", window: window([page(ALPHA, [row(ALPHA, "a2", 50, 50), { ...row(ALPHA, "a1", 30, 30), harness: nativeHarness("claude"), permissionMode: "default" }])]) },
    { type: "sendStarted", sessionId: sessionId("a1"), clientRequestId: "send-1", at: 100 },
  )
  const moded = run(listed, { type: "sessionUpserted", row: { ...row(ALPHA, "a1", 30, 30), updatedAt: 90, harness: nativeHarness("claude"), permissionMode: "plan" } })
  expect(shown(moded)).toEqual(["a1", "a2"])
  const landed = run(moded, { type: "sessionUpserted", row: { ...row(ALPHA, "a1", 30, 95), updatedAt: 95, harness: nativeHarness("claude"), permissionMode: "plan" } })
  const entry = landed.kind === "live" ? landed.entries.get(sessionId("a1")) : undefined
  expect(entry?.kind === "confirmed" ? [entry.pendingSend, entry.row.lastHumanTurnAt] : undefined).toEqual([undefined, 95])
  expect(shown(landed)).toEqual(["a1", "a2"])
})

test("show more extends only its own project, and a page that ends the project shows every row after it", () => {
  const first = run(
    initialListState,
    { type: "fetchStarted" },
    { type: "fetched", window: window([page(ALPHA, [row(ALPHA, "a1", 50)], "cursor-a"), page(BRAVO, [row(BRAVO, "b1", 40)], "cursor-b")]) },
    { type: "moreStarted", projectId: ALPHA },
  )
  expect(first.kind === "live" && first.more.get(ALPHA)?.kind).toBe("loading")
  expect(first.kind === "live" && first.more.get(BRAVO)).toBeUndefined()

  const held = run(first, { type: "sessionUpserted", row: row(ALPHA, "a-late", 5) }, { type: "sessionUpserted", row: row(BRAVO, "b-late", 45) })
  expect(shown(held)).toEqual(["a1", "b-late", "b1"])

  const extended = run(held, { type: "moreFetched", projectId: ALPHA, window: window([page(ALPHA, [row(ALPHA, "a2", 20)])]) })
  expect(shown(extended)).toEqual(["a1", "b-late", "b1", "a2", "a-late"])
  expect(extended.windows.get(ALPHA)?.nextAfter).toBeUndefined()
  expect(extended.windows.get(BRAVO)?.nextAfter).toBe("cursor-b")
})

test("a project whose page failed keeps the others' rows and names its own failure", () => {
  const error = { class: "network" as const, message: "unreachable", retryable: true }
  const state = run(
    initialListState,
    { type: "fetchStarted" },
    { type: "fetched", window: window([page(BRAVO, [row(BRAVO, "b1", 40)])], [{ projectId: ALPHA, error }]) },
  )

  expect(state.kind).toBe("live")
  expect(shown(state)).toEqual(["b1"])
  expect(state.failures.get(ALPHA)).toEqual(error)

  const recovered = run(state, { type: "rereadStarted" }, {
    type: "rereadFetched",
    mode: "replace",
    window: window([page(ALPHA, [row(ALPHA, "a1", 50)]), page(BRAVO, [row(BRAVO, "b1", 40)])], [], 2_000),
  })
  expect(recovered.failures.size).toBe(0)
  expect(shown(recovered)).toEqual(["a1", "b1"])
})

test("a listed status is a read at the page's send time: a newer event beats it, and it clears the listed wait", () => {
  const listed = run(
    initialListState,
    { type: "fetchStarted" },
    {
      type: "fetched",
      window: window([page(ALPHA, [row(ALPHA, "a1", 50), row(ALPHA, "a2", 40)], undefined, [
        ["a1", { status: { kind: "working" }, waitingOnUser: true }],
        ["a2", { status: { kind: "idle" }, waitingOnUser: false }],
      ])], [], 1_000),
    },
  )
  expect(listed.statuses.get(sessionId("a1"))).toMatchObject({ status: { kind: "working" }, waitingOnUser: true, source: "read" })

  const moved = run(listed, { type: "statusChanged", ref: row(ALPHA, "a1", 50).ref, status: { kind: "idle" }, at: 1_500 })
  expect(moved.statuses.get(sessionId("a1"))).toMatchObject({ status: { kind: "idle" }, waitingOnUser: false, source: "event" })

  const stale = run(moved, { type: "rereadStarted" }, {
    type: "rereadFetched",
    mode: "refresh",
    window: window([page(ALPHA, [row(ALPHA, "a1", 50)], undefined, [["a1", { status: { kind: "working" }, waitingOnUser: true }]])], [], 1_200),
  })
  expect(stale.statuses.get(sessionId("a1"))).toMatchObject({ status: { kind: "idle" }, source: "event" })
})

test("a turn's status that lands before its session's row is the row's status once the row arrives", () => {
  const live = run(initialListState, { type: "fetchStarted" }, { type: "fetched", window: window([page(ALPHA, [row(ALPHA, "a1", 50)])]) })
  const created = row(ALPHA, "a2", 60)
  const working = { type: "statusChanged" as const, ref: created.ref, status: { kind: "working" as const }, at: 1_100 }

  const creator = run(
    live,
    { type: "createStarted", clientRequestId: "r1", row: { ...created, ref: { ...created.ref, sessionId: sessionId("pending:r1") } } },
    working,
    { type: "createConfirmed", clientRequestId: "r1", row: created },
  )
  expect(shown(creator)).toEqual(["a2", "a1"])
  expect(creator.statuses.get(sessionId("a2"))?.status).toEqual({ kind: "working" })

  const watcher = run(live, working, { type: "rereadStarted" }, {
    type: "rereadFetched",
    mode: "refresh",
    window: window([page(ALPHA, [created, row(ALPHA, "a1", 50)])], [], 1_200),
  })
  expect(shown(watcher)).toEqual(["a2", "a1"])
  expect(watcher.statuses.get(sessionId("a2"))?.status).toEqual({ kind: "working" })
})
