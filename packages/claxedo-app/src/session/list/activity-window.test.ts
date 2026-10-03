/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId, projectId, sessionId, type ProjectId, type SessionRow } from "@/server"
import { ACTIVITY_WINDOW, initialListState, type FetchedPage, type ListState, type WindowKey } from "./model"
import { listTransition } from "./transition"
import { visibleOrder } from "./visible-rows"

const ALPHA = projectId("prj_alpha")
const BRAVO = projectId("prj_bravo")

function row(project: ProjectId, id: string, lastHumanTurnAt: number, updatedAt = 1): SessionRow {
  return { ref: { projectId: project, placementId: placementId(`${project}_folder`), sessionId: sessionId(id) }, title: id, createdAt: 1, updatedAt, lastHumanTurnAt }
}

function page(windowKey: WindowKey, rows: SessionRow[], nextAfter?: string): FetchedPage {
  return { windowKey, rows, nextAfter, degraded: false, statuses: new Map(), readers: new Map() }
}

const pages = (sentAt: number, ...fetched: FetchedPage[]) => ({ pages: fetched, failures: [], sentAt })

function run(state: ListState, ...events: Parameters<typeof listTransition>[1][]): ListState {
  return events.reduce(listTransition, state)
}

const projects = (state: ListState) => visibleOrder(state, false, "projects").map((ref) => ref.sessionId as string)
const activity = (state: ListState) => visibleOrder(state, false, ACTIVITY_WINDOW).map((ref) => ref.sessionId as string)

const booted = run(
  initialListState,
  { type: "fetchStarted" },
  {
    type: "fetched",
    window: pages(
      1_000,
      page(ALPHA, [row(ALPHA, "a1", 90)], "more-a"),
      page(BRAVO, [row(BRAVO, "b1", 80)], "more-b"),
      page(ACTIVITY_WINDOW, [row(ALPHA, "a1", 90), row(BRAVO, "b1", 80), row(ALPHA, "a2", 70)], "more-activity"),
    ),
  },
)

test("activity is one flat order across projects, and a row only its page brought stays out of its project's rows", () => {
  expect(activity(booted)).toEqual(["a1", "b1", "a2"])
  expect(projects(booted)).toEqual(["a1", "b1"])
})

test("the reader's own send moves a row to the top of activity before the server answers, and only the send does", () => {
  const sent = run(booted, { type: "sendStarted", sessionId: sessionId("a2"), clientRequestId: "send-1", at: 100 })
  expect(activity(sent)).toEqual(["a2", "a1", "b1"])

  const touched = run(booted, { type: "sessionUpserted", row: { ...row(BRAVO, "b1", 80, 500), title: "renamed" } })
  expect(activity(touched)).toEqual(["a1", "b1", "a2"])
})

test("a turn end's row read admits a row inside the activity window with the turn the notice named, and a row after every window stays out", () => {
  const ended = { status: "completed" as const, completedAt: 500 }
  const read = (listed: SessionRow) => run(booted, { type: "turnEndRowRead", window: pages(2_000, page(BRAVO, [listed])), ref: listed.ref, lastTurn: ended })
  const settled = { ...row(BRAVO, "b-settled", 75), lastTurn: { status: "completed" as const, completedAt: 100 } }
  const admitted = run(read(settled), { type: "readerChanged", ref: settled.ref, reader: { settledAt: 100 }, at: 3_000 })
  expect(activity(admitted)).toEqual(["a1", "b1", "b-settled", "a2"])
  expect(read(row(BRAVO, "b-old", 10)).entries.has(sessionId("b-old"))).toBe(false)
})

test("a replace re-read drops a row only when every window holding it was read", () => {
  const projectsOnly = run(booted, { type: "rereadStarted" }, {
    type: "rereadFetched",
    mode: "replace",
    window: pages(3_000, page(ALPHA, [row(ALPHA, "a1", 90)], "more-a"), page(BRAVO, [], undefined)),
  })
  expect(activity(projectsOnly)).toEqual(["a1", "b1", "a2"])

  const both = run(booted, { type: "rereadStarted" }, {
    type: "rereadFetched",
    mode: "replace",
    window: pages(3_000, page(ALPHA, [row(ALPHA, "a1", 90)], "more-a"), page(BRAVO, []), page(ACTIVITY_WINDOW, [row(ALPHA, "a1", 90), row(ALPHA, "a2", 70)])),
  })
  expect(activity(both)).toEqual(["a1", "a2"])
  expect(both.entries.has(sessionId("b1"))).toBe(false)
})

test("opening activity reads its first page, and an event during that read waits for the page", () => {
  const projectsBooted = run(initialListState, { type: "fetchStarted" }, { type: "fetched", window: pages(1_000, page(ALPHA, [row(ALPHA, "a1", 90)], "more-a")) })
  const opening = run(projectsBooted, { type: "moreStarted", windowKey: ACTIVITY_WINDOW }, { type: "sessionUpserted", row: row(BRAVO, "b-new", 95) })
  expect(opening.kind === "live" && opening.more.get(ACTIVITY_WINDOW)?.kind).toBe("loading")
  expect(activity(opening)).toEqual([])

  const opened = run(opening, { type: "moreFetched", windowKey: ACTIVITY_WINDOW, window: pages(2_000, page(ACTIVITY_WINDOW, [row(ALPHA, "a1", 90), row(BRAVO, "b2", 60)], "more")) })
  expect(activity(opened)).toEqual(["b-new", "a1", "b2"])
  expect(projects(opened)).toEqual(["a1"])
})
