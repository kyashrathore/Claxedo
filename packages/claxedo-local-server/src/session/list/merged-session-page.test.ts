import { describe, expect, test } from "vitest"
import {
  compareSessionOrder,
  parseSessionListQuery,
  sessionOrderKey,
  type SessionListKeysetPage,
  type SessionNavigationRow,
} from "@claxedo/server-core/session/navigation-list"
import { readMergedSessionListPage, type SessionListSource } from "./merged-session-page"

type Stored = {
  session_id: string
  workspace_id: string
  project_id: string
  created_at: number
  updated_at: number
  last_human_turn_at?: number
}

const PROJECT = "prj_1"

function stored(workspaceId: string, sessionId: string, createdAt: number, lastHumanTurnAt?: number): Stored {
  return {
    session_id: sessionId,
    workspace_id: workspaceId,
    project_id: PROJECT,
    created_at: createdAt,
    updated_at: createdAt,
    ...(lastHumanTurnAt === undefined ? {} : { last_human_turn_at: lastHumanTurnAt }),
  }
}

function keyOf(row: Stored) {
  return {
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    ...(row.last_human_turn_at === undefined ? {} : { lastHumanTurnAt: row.last_human_turn_at }),
    sessionRef: `workspace:${row.workspace_id}:session:${row.session_id}`,
  }
}

/** A store paging its rows by the same keyset every real store builds. */
function memorySource(name: string, rows: Stored[], options: { required?: boolean; fail?: () => boolean } = {}): SessionListSource {
  return {
    name,
    required: options.required ?? false,
    read: async (page: SessionListKeysetPage) => {
      if (options.fail?.()) throw new Error(`${name} is unreachable`)
      return rows
        .filter((row) => !page.after || compareSessionOrder(keyOf(row), page.after, page.sort) > 0)
        .toSorted((a, b) => compareSessionOrder(keyOf(a), keyOf(b), page.sort))
        .slice(0, page.limit)
    },
  }
}

function query(limit: number, cursor?: string) {
  return parseSessionListQuery(new URL(
    `http://daemon.test/api/claxedo/session-list?scope=project&projectId=${PROJECT}&sort=human_turn_desc&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
  ))
}

async function walk(sources: SessionListSource[], limit: number, between?: (page: number) => void) {
  const pages: SessionNavigationRow[][] = []
  let cursor: string | undefined
  do {
    const response = await readMergedSessionListPage(query(limit, cursor), sources)
    pages.push(response.items ?? [])
    cursor = response.nextCursor
    between?.(pages.length)
  } while (cursor && pages.length < 50)
  return pages
}

function isOrdered(rows: SessionNavigationRow[]) {
  return rows.every((row, index) =>
    index === 0 || compareSessionOrder(sessionOrderKey(rows[index - 1]!), sessionOrderKey(row), "human_turn_desc") < 0)
}

describe("readMergedSessionListPage", () => {
  test("walks two stores as one order, in pages that are true prefixes, with nothing skipped or repeated", async () => {
    const local = [
      stored("ws_local", "l1", 10, 900),
      stored("ws_local", "l2", 20),
      stored("ws_local", "l3", 30, 500),
      stored("ws_local", "l4", 40),
      stored("ws_local", "l5", 50),
    ]
    const cloud = [
      stored("ws_cloud", "c1", 15, 950),
      stored("ws_cloud", "c2", 25),
      stored("ws_cloud", "c3", 35, 100),
      stored("ws_cloud", "c4", 45),
    ]
    const everything = [...local, ...cloud].map(keyOf).toSorted((a, b) => compareSessionOrder(a, b, "human_turn_desc"))

    const pages = await walk([memorySource("local", local, { required: true }), memorySource("control-plane", cloud)], 2)
    const walked = pages.flat()

    expect(pages.length).toBeGreaterThanOrEqual(3)
    expect(walked.map((row) => row.sessionRef)).toEqual(everything.map((key) => key.sessionRef))
    expect(isOrdered(walked)).toBe(true)
  })

  test("keeps paging when only one store has rows left", async () => {
    const local = [1, 2, 3, 4, 5].map((index) => stored("ws_local", `l${index}`, index * 10))
    const pages = await walk([memorySource("local", local, { required: true }), memorySource("control-plane", [])], 2)

    expect(pages.flat().map((row) => row.sessionId)).toEqual(["l5", "l4", "l3", "l2", "l1"])
  })

  test("sessions created between pages land where the order puts them, and nothing already listed repeats", async () => {
    const local = [stored("ws_local", "l1", 10, 900), stored("ws_local", "l2", 20), stored("ws_local", "l3", 30)]
    const cloud = [stored("ws_cloud", "c1", 15, 950), stored("ws_cloud", "c2", 25), stored("ws_cloud", "c3", 5)]
    const pages = await walk(
      [memorySource("local", local, { required: true }), memorySource("control-plane", cloud)],
      2,
      (page) => {
        if (page === 1) local.push(stored("ws_local", "l-new-behind", 1))
        if (page === 2) cloud.push(stored("ws_cloud", "c-new-ahead", 1_000, 2_000))
      },
    )
    const walked = pages.flat().map((row) => row.sessionId)

    expect(new Set(walked).size).toBe(walked.length)
    expect(walked).toContain("l-new-behind")
    expect(walked).not.toContain("c-new-ahead")
    for (const id of ["l1", "l2", "l3", "c1", "c2", "c3"]) expect(walked).toContain(id)
    expect(isOrdered(pages.flat())).toBe(true)
  })

  test("an unreachable optional source degrades the page instead of failing it", async () => {
    let down = true
    const local = [stored("ws_local", "l1", 10), stored("ws_local", "l2", 20)]
    const cloud = [stored("ws_cloud", "c1", 30)]
    const sources = [
      memorySource("local", local, { required: true }),
      memorySource("control-plane", cloud, { fail: () => down }),
    ]

    const degraded = await readMergedSessionListPage(query(5), sources)
    expect(degraded.items?.map((row) => row.sessionId)).toEqual(["l2", "l1"])
    expect(degraded.sources).toEqual({ degraded: ["control-plane"] })

    down = false
    const whole = await readMergedSessionListPage(query(5), sources)
    expect(whole.items?.map((row) => row.sessionId)).toEqual(["c1", "l2", "l1"])
    expect(whole.sources).toBeUndefined()
  })

  test("a required source failing fails the page", async () => {
    const sources = [memorySource("local", [], { required: true, fail: () => true })]
    await expect(readMergedSessionListPage(query(5), sources)).rejects.toThrow("local is unreachable")
  })

  test("a session two sources both answer is listed once, as the earlier source has it", async () => {
    const mine = { ...stored("ws_local", "shared", 10), title: "Local title" }
    const published = { ...stored("ws_local", "shared", 10), title: "Published title" }
    const response = await readMergedSessionListPage(query(5), [
      memorySource("local", [mine], { required: true }),
      memorySource("control-plane", [published]),
    ])

    expect(response.items?.map((row) => [row.sessionId, row.title])).toEqual([["shared", "Local title"]])
  })
})
