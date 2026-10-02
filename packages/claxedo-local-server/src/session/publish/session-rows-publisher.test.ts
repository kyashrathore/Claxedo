import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { SessionRef } from "@claxedo/agent-runtime-contract"
import type { HostSessionRow } from "@claxedo/server-core/platform/auth/host-session-rows"
import { createSessionRowsPublisher, type SessionRowsPublisher } from "./session-rows-publisher"
import type { SessionRowSource } from "./local-session-rows"

const URL = "https://control-plane.test/api/claxedo/host/session-rows"
const WS_A = "ws_a"
const WS_B = "ws_b"

type Sent = { url: string; token: string | null; body: { hostId: string; rows: HostSessionRow[]; removed: SessionRef[] } }

function row(workspaceId: string, sessionId: string, overrides: Partial<HostSessionRow> = {}): HostSessionRow {
  return {
    workspaceId,
    sessionId,
    title: sessionId,
    createdAt: 1_000,
    updatedAt: 2_000,
    status: { kind: "idle", awaitingInput: false, at: 2_000 },
    ...overrides,
  }
}

function harness(options: { maxDirtySessions?: number; url?: string | undefined } = {}) {
  const rows = new Map<string, Map<string, HostSessionRow>>()
  const children = new Set<string>()
  const sent: Sent[] = []
  const answers: Array<() => Response> = []
  const reads = { list: 0, read: 0 }
  const unreadable = new Set<string>()
  const source: SessionRowSource = {
    listRows: async (workspaceId) => {
      reads.list++
      if (unreadable.has(workspaceId)) throw new Error(`${workspaceId} unreadable`)
      return [...(rows.get(workspaceId)?.values() ?? [])]
    },
    readRow: async (workspaceId, sessionId) => {
      reads.read++
      if (children.has(sessionId)) return { kind: "child" }
      const hit = rows.get(workspaceId)?.get(sessionId)
      return hit ? { kind: "row", row: hit } : { kind: "absent" }
    },
  }
  let url: string | undefined = "url" in options ? options.url : URL
  const publisher = createSessionRowsPublisher({
    source,
    url: () => url,
    random: () => 0.5,
    ...(options.maxDirtySessions !== undefined ? { maxDirtySessions: options.maxDirtySessions } : {}),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body
      if (typeof body !== "string") throw new Error("the publisher sent a body that is not text")
      sent.push({
        url: input instanceof Request ? input.url : input.toString(),
        token: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(body) as Sent["body"],
      })
      const answer = answers.shift()
      return answer ? answer() : Response.json({ accepted: 0, refused: [] })
    }) as typeof fetch,
  })
  const put = (entry: HostSessionRow) => {
    const workspace = rows.get(entry.workspaceId) ?? new Map<string, HostSessionRow>()
    workspace.set(entry.sessionId, entry)
    rows.set(entry.workspaceId, workspace)
  }
  return {
    publisher,
    sent,
    reads,
    put,
    drop: (workspaceId: string, sessionId: string) => rows.get(workspaceId)?.delete(sessionId),
    child: (sessionId: string) => children.add(sessionId),
    unreadable: (workspaceId: string, is: boolean) => (is ? unreadable.add(workspaceId) : unreadable.delete(workspaceId)),
    answer: (...next: Array<() => Response>) => answers.push(...next),
    setUrl: (next: string | undefined) => {
      url = next
    },
    serve: (workspaceIds: string[], token = "htt.1") => publisher.credentialChanged({ hostId: "host_1", token, workspaceIds }),
  }
}

let stopped: SessionRowsPublisher[] = []

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  for (const publisher of stopped) publisher.stop()
  stopped = []
  vi.useRealTimers()
})

function up(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options)
  stopped.push(h.publisher)
  return h
}

const settle = (ms = 300) => vi.advanceTimersByTimeAsync(ms)

describe("the machine session-rows publisher", () => {
  test("a credential publishes every served workspace's rows with the Host Tunnel Token", async () => {
    const h = up()
    h.put(row(WS_A, "a1"))
    h.put(row(WS_A, "a2", { lastHumanTurnAt: 3_000, archivedAt: 4_000 }))
    h.put(row(WS_B, "b1"))

    h.serve([WS_A])
    await settle()

    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toEqual({
      url: URL,
      token: "Bearer htt.1",
      body: { hostId: "host_1", rows: [row(WS_A, "a1"), row(WS_A, "a2", { lastHumanTurnAt: 3_000, archivedAt: 4_000 })], removed: [] },
    })
    expect(vi.getTimerCount(), "nothing pending, nothing scheduled").toBe(0)
  })

  test("a change publishes that session after the debounce, coalesced", async () => {
    const h = up()
    h.put(row(WS_A, "a1", { title: "first" }))
    h.serve([WS_A])
    await settle()

    h.publisher.sessionChanged(WS_A, "a1")
    await settle(100)
    h.put(row(WS_A, "a1", { title: "renamed" }))
    h.publisher.sessionChanged(WS_A, "a1")
    expect(h.sent, "still within the debounce").toHaveLength(1)
    await settle()

    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]?.body).toEqual({ hostId: "host_1", rows: [row(WS_A, "a1", { title: "renamed" })], removed: [] })
    expect(h.reads.read).toBe(1)
  })

  test("a token renewal alone republishes nothing; a changed workspace set republishes everything", async () => {
    const h = up()
    h.put(row(WS_A, "a1"))
    h.put(row(WS_B, "b1"))
    h.serve([WS_A])
    await settle()
    expect(h.sent).toHaveLength(1)

    h.serve([WS_A], "htt.2")
    await settle()
    expect(h.sent, "the renewed token carries the same set").toHaveLength(1)

    h.serve([WS_A, WS_B], "htt.2")
    await settle()
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]?.token).toBe("Bearer htt.2")
    expect(h.sent[1]?.body.rows.map((entry) => entry.sessionId)).toEqual(["a1", "b1"])
  })

  test("a deleted session is published as removed", async () => {
    const h = up()
    h.put(row(WS_A, "a1"))
    h.serve([WS_A])
    await settle()

    h.drop(WS_A, "a1")
    h.publisher.sessionRemoved(WS_A, "a1")
    await settle()

    expect(h.sent[1]?.body).toEqual({ hostId: "host_1", rows: [], removed: [{ workspaceId: WS_A, sessionId: "a1" }] })
  })

  test("a child session's change is not a row and not a removal", async () => {
    const h = up()
    h.serve([WS_A])
    await settle()
    h.child("a-child")

    h.publisher.sessionChanged(WS_A, "a-child")
    await settle()

    expect(h.sent).toHaveLength(0)
  })

  test("a full resync removes what it published before and no longer lists", async () => {
    const h = up()
    h.put(row(WS_A, "a1"))
    h.put(row(WS_A, "a2"))
    h.serve([WS_A])
    await settle()

    h.drop(WS_A, "a2")
    h.publisher.resync()
    await settle()

    expect(h.sent[1]?.body).toEqual({ hostId: "host_1", rows: [row(WS_A, "a1")], removed: [{ workspaceId: WS_A, sessionId: "a2" }] })
  })

  test("a snapshot rewrite republishes the workspace and removes what is gone", async () => {
    const h = up()
    h.put(row(WS_A, "a1"))
    h.put(row(WS_A, "a2"))
    h.serve([WS_A])
    await settle()

    h.drop(WS_A, "a1")
    h.put(row(WS_A, "a3"))
    h.publisher.workspaceChanged(WS_A)
    await settle()

    expect(h.sent[1]?.body).toEqual({
      hostId: "host_1",
      rows: [row(WS_A, "a2"), row(WS_A, "a3")],
      removed: [{ workspaceId: WS_A, sessionId: "a1" }],
    })
  })

  test("publishes at most 100 rows per request", async () => {
    const h = up()
    for (let index = 0; index < 250; index++) h.put(row(WS_A, `a${index}`))

    h.serve([WS_A])
    await settle()

    expect(h.sent.map((entry) => entry.body.rows.length)).toEqual([100, 100, 50])
  })

  test("backs off exponentially after failures and resets on success", async () => {
    const h = up()
    h.put(row(WS_A, "a1"))
    h.answer(() => new Response("down", { status: 503 }), () => new Response("down", { status: 503 }))

    h.serve([WS_A])
    await settle()
    expect(h.sent).toHaveLength(1)

    await settle(949)
    expect(h.sent, "the first retry waits a full second after the failed publish").toHaveLength(1)
    await settle(1)
    expect(h.sent).toHaveLength(2)

    await settle(1_999)
    expect(h.sent, "the second retry waits two").toHaveLength(2)
    await settle(1)
    expect(h.sent).toHaveLength(3)
    expect(vi.getTimerCount(), "the third attempt succeeded; nothing pending").toBe(0)

    h.publisher.sessionChanged(WS_A, "a1")
    await settle()
    expect(h.sent, "after a success the next change waits only the debounce").toHaveLength(4)
  })

  test("a workspace that cannot be read is retried on the backoff, not every debounce", async () => {
    const h = up()
    h.put(row(WS_A, "a1"))
    h.put(row(WS_B, "b1"))
    h.unreadable(WS_A, true)

    h.serve([WS_A, WS_B])
    await settle()
    expect(h.reads.list).toBe(2)
    expect(h.sent.map((entry) => entry.body.rows.map((row) => row.sessionId)), "the readable workspace still went out").toEqual([["b1"]])

    await settle(949)
    expect(h.reads.list, "no re-read before the first retry delay").toBe(2)
    await settle(1)
    expect(h.reads.list).toBe(3)
    await settle(1_999)
    expect(h.reads.list, "the second retry waits twice as long").toBe(3)
    await settle(1)
    expect(h.reads.list).toBe(4)

    h.unreadable(WS_A, false)
    await settle(4_000)
    expect(h.sent.at(-1)?.body.rows.map((row) => row.sessionId)).toEqual(["a1"])
    expect(vi.getTimerCount()).toBe(0)

    h.publisher.sessionChanged(WS_B, "b1")
    await settle()
    expect(h.sent, "after a clean flush the next change waits only the debounce").toHaveLength(3)
  })

  test("a failed chunk is put back and only it is retried", async () => {
    const h = up()
    h.serve([WS_A])
    await settle()
    for (let index = 0; index < 150; index++) h.put(row(WS_A, `a${index}`))
    h.answer(() => Response.json({ accepted: 100, refused: [] }), () => new Response("down", { status: 502 }))

    for (let index = 0; index < 150; index++) h.publisher.sessionChanged(WS_A, `a${index}`)
    await settle()
    expect(h.sent.map((entry) => entry.body.rows.length)).toEqual([100, 50])

    await settle(1_000)
    expect(h.sent.map((entry) => entry.body.rows.length)).toEqual([100, 50, 50])
    expect(h.sent[2]?.body.rows.map((entry) => entry.sessionId)).toEqual(h.sent[1]?.body.rows.map((entry) => entry.sessionId))
  })

  test("past the cap the change set collapses into one full resync", async () => {
    const h = up({ maxDirtySessions: 3 })
    for (let index = 0; index < 5; index++) h.put(row(WS_A, `a${index}`))
    h.serve([WS_A])
    await settle()
    const listsBefore = h.reads.list

    for (let index = 0; index < 5; index++) h.publisher.sessionChanged(WS_A, `a${index}`)
    await settle()

    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]?.body.rows).toHaveLength(5)
    expect(h.reads.list - listsBefore).toBe(1)
    expect(h.reads.read, "no per-session reads once the set was dropped").toBe(0)
  })

  test("publishes nothing without a credential", async () => {
    const h = up()
    h.put(row(WS_A, "a1"))

    h.publisher.sessionChanged(WS_A, "a1")
    h.publisher.resync()
    await settle(60_000)

    expect(h.sent).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  test("publishes nothing without a URL, and everything once one arrives with a credential", async () => {
    const h = up({ url: undefined })
    h.put(row(WS_A, "a1"))
    h.serve([WS_A])
    await settle(60_000)
    expect(h.sent).toEqual([])
    expect(vi.getTimerCount()).toBe(0)

    h.setUrl(URL)
    h.serve([WS_A])
    await settle()
    expect(h.sent).toHaveLength(1)
  })

  test("a change for a workspace this machine does not serve is dropped", async () => {
    const h = up()
    h.serve([WS_A])
    await settle()
    h.put(row(WS_B, "b1"))

    h.publisher.sessionChanged(WS_B, "b1")
    await settle()

    expect(h.sent).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  test("a 401 waits for the next credential instead of retrying, then republishes in full", async () => {
    const h = up()
    h.put(row(WS_A, "a1"))
    h.answer(() => new Response("refused", { status: 401 }))
    h.serve([WS_A])
    await settle()
    expect(h.sent).toHaveLength(1)

    h.publisher.sessionChanged(WS_A, "a1")
    await settle(5 * 60_000)
    expect(h.sent, "nothing is sent with the refused token").toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)

    h.serve([WS_A], "htt.1")
    await settle(5 * 60_000)
    expect(h.sent, "the same token again is still the refused one").toHaveLength(1)

    h.serve([WS_A], "htt.2")
    await settle()
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]?.token).toBe("Bearer htt.2")
    expect(h.sent[1]?.body.rows).toEqual([row(WS_A, "a1")])
  })

  test("losing the credential cancels what was scheduled and the next one republishes in full", async () => {
    const h = up()
    h.put(row(WS_A, "a1"))
    h.serve([WS_A])
    await settle()
    h.publisher.sessionChanged(WS_A, "a1")

    h.publisher.credentialChanged(undefined)
    await settle(60_000)
    expect(h.sent).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)

    h.serve([WS_A])
    await settle()
    expect(h.sent).toHaveLength(2)
    expect(h.reads.read, "the pending change was dropped with the credential").toBe(0)
  })

  test("a refused row is not remembered as published", async () => {
    const h = up()
    h.put(row(WS_A, "a1"))
    h.put(row(WS_A, "a2"))
    h.answer(() => Response.json({ accepted: 1, refused: [{ workspaceId: WS_A, sessionId: "a2", reason: "session_deleted" }] }))
    h.serve([WS_A])
    await settle()

    h.drop(WS_A, "a1")
    h.drop(WS_A, "a2")
    h.publisher.resync()
    await settle()

    expect(h.sent[1]?.body.removed).toEqual([{ workspaceId: WS_A, sessionId: "a1" }])
  })

  test("stop cancels a pending publish", async () => {
    const h = up()
    h.put(row(WS_A, "a1"))
    h.serve([WS_A])

    h.publisher.stop()
    await settle(60_000)

    expect(h.sent).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})
