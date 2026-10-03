import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { SessionAttentionEvent, SessionRef } from "@claxedo/agent-runtime-contract"
import type { HostSessionRow, SessionAttentionPublication } from "@claxedo/server-core/platform/auth/host-session-rows"
import { createSessionRowsPublisher, type SessionRowsPublisher } from "./session-rows-publisher"
import type { SessionRowSource } from "./local-session-rows"

const URL = "https://control-plane.test/api/claxedo/host/session-rows"
const WS_A = "ws_a"
const WS_B = "ws_b"

type Sent = { url: string; token: string | null; body: { hostId: string; rows: HostSessionRow[]; removed: SessionRef[]; attention: SessionAttentionPublication[] } }

function row(workspaceId: string, sessionId: string, overrides: Partial<HostSessionRow> = {}): HostSessionRow {
  return {
    workspaceId,
    sessionId,
    title: sessionId,
    createdAt: 1_000,
    updatedAt: 2_000,
    status: { kind: "idle", awaitingInput: false, at: 2_000 },
    attention: { sequence: 1, generation: 1, activitySequence: 1, activityAt: 1_000, working: false, awaitingInput: false },
    ...overrides,
  }
}

const batch = (workspaceId: string, sessionId: string) => ({ workspaceId, sessionId, generation: 1, through: 1, events: [] })

function harness(options: { maxDirtySessions?: number; url?: string | undefined; prepareWorkspace?: (workspaceId: string) => Promise<void>; beforeAttentionPage?: () => Promise<void> } = {}) {
  const rows = new Map<string, Map<string, HostSessionRow>>()
  const children = new Set<string>()
  const histories = new Map<string, SessionAttentionEvent[]>()
  const tombstones = new Map<string, Set<string>>()
  const sent: Sent[] = []
  const answers: Array<() => Response | Promise<Response>> = []
  const reads = { list: 0, read: 0 }
  const unreadable = new Set<string>()
  const unmounted = new Set<string>()
  const source: SessionRowSource = {
    prepareWorkspace: options.prepareWorkspace ?? (async () => {}),
    attentionSnapshot: (workspaceId, sessionId) => unmounted.has(workspaceId) ? undefined : [...(rows.get(workspaceId)?.values() ?? [])]
      .filter((row) => sessionId === undefined || row.sessionId === sessionId)
      .map((row) => ({ sessionId: row.sessionId, attention: row.attention! })),
    removedRows: async (workspaceId) => [...(tombstones.get(workspaceId) ?? [])].map((sessionId) => ({ workspaceId, sessionId })),
    attentionPage: async (workspaceId, sessionId, after) => {
      const facts = rows.get(workspaceId)?.get(sessionId)?.attention
      if (!facts) throw new Error("Missing canonical attention facts")
      await options.beforeAttentionPage?.()
      return { generation: facts.generation, through: facts.sequence,
        events: (histories.get(`${workspaceId}/${sessionId}`) ?? []).filter((event) => event.sequence > after) }
    },
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
      sent.push({
        url: input instanceof Request ? input.url : String(input),
        token: new Headers(init?.headers).get("authorization"),
        body: await new Response(init?.body).json() as Sent["body"],
      })
      const answer = answers.shift()
      const body = sent.at(-1)!.body
      const named = new Set([...body.rows, ...body.removed].map((ref) => `${ref.workspaceId}/${ref.sessionId}`))
      const histories = (body as typeof body & { attention: Array<{ workspaceId: string; sessionId: string }> }).attention
      const count = body.rows.length + body.removed.length + histories.filter((ref) => !named.has(`${ref.workspaceId}/${ref.sessionId}`)).length
      return answer ? answer() : Response.json({ accepted: count, refused: [] })
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
    history: (workspaceId: string, sessionId: string, events: SessionAttentionEvent[]) => histories.set(`${workspaceId}/${sessionId}`, events),
    drop: (workspaceId: string, sessionId: string) => {
      rows.get(workspaceId)?.delete(sessionId)
      const removed = tombstones.get(workspaceId) ?? new Set<string>()
      removed.add(sessionId)
      tombstones.set(workspaceId, removed)
    },
    omit: (workspaceId: string, sessionId: string) => rows.get(workspaceId)?.delete(sessionId),
    child: (sessionId: string) => children.add(sessionId),
    unreadable: (workspaceId: string, is: boolean) => (is ? unreadable.add(workspaceId) : unreadable.delete(workspaceId)),
    unmounted: (workspaceId: string, is: boolean) => (is ? unmounted.add(workspaceId) : unmounted.delete(workspaceId)),
    answer: (...next: Array<() => Response | Promise<Response>>) => answers.push(...next),
    setUrl: (next: string | undefined) => {
      url = next
    },
    serve: (workspaceIds: string[], token = "htt.1", generation = 0, enrollmentId = "enr_1") =>
      publisher.credentialChanged({ hostId: "host_1", token, workspaceIds, generation, enrollmentId }),
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
      body: { hostId: "host_1", rows: [row(WS_A, "a1", { replayed: true }), row(WS_A, "a2", { lastHumanTurnAt: 3_000, archivedAt: 4_000, replayed: true })], removed: [], attention: [batch(WS_A, "a1"), batch(WS_A, "a2")] },
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
    expect(h.sent[1]?.body).toEqual({ hostId: "host_1", rows: [row(WS_A, "a1", { title: "renamed", replayed: true })], removed: [], attention: [] })
    expect(h.reads.read).toBe(1)
  })

  test("a transient request and short completed turn survive coalescing and a failed ingest acknowledgement", async () => {
    const h = up()
    h.put(row(WS_A, "a1"))
    h.serve([WS_A])
    await settle()
    const question = { sequence: 2, kind: "question" as const, requestId: "q_transient", openedAt: 2_050 }
    const finished = { sequence: 8, kind: "outcome" as const, outcome: "completed" as const, openedAt: 2_100 }
    h.history(WS_A, "a1", [question, finished])
    h.put(row(WS_A, "a1", { status: { kind: "busy", awaitingInput: true, at: 2_050 },
      attention: { sequence: 2, generation: 1, activitySequence: 1, activityAt: 1_000, working: true, awaitingInput: true } }))
    h.publisher.sessionChanged(WS_A, "a1")
    await settle(50)
    h.put(row(WS_A, "a1", { status: { kind: "idle", awaitingInput: false, at: 2_100 },
      lastTurn: { status: "completed", completedAt: 2_100, assistantMessageId: "msg_completed" },
      attention: { sequence: 8, generation: 1, activitySequence: 1, activityAt: 1_000,
        outcome: { sequence: 8, status: "completed", completedAt: 2_100 }, working: false, awaitingInput: false } }))
    h.publisher.sessionChanged(WS_A, "a1")
    h.answer(() => Response.json({ accepted: 0, refused: [] }))
    await settle()
    expect(h.sent[1].body.attention).toEqual([{ workspaceId: WS_A, sessionId: "a1", generation: 1, through: 8, events: [question, finished] }])
    expect(h.sent[1].body.rows[0]).toMatchObject({ status: { kind: "idle", awaitingInput: false },
      lastTurn: { assistantMessageId: "msg_completed" } })
    await settle(10_000)
    expect(h.sent[2].body).toEqual(h.sent[1].body)
    h.publisher.sessionChanged(WS_A, "a1")
    await settle()
    expect(h.sent[3].body.attention).toEqual([])
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

  test("a new admitted serving generation or enrollment republishes unchanged quiet rows", async () => {
    const h = up()
    h.put(row(WS_A, "a1"))
    h.serve([WS_A])
    await settle()
    h.serve([WS_A], "htt.new-generation", 1)
    await settle()
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1].body.rows.map((row) => row.sessionId)).toEqual(["a1"])
    h.serve([WS_A], "htt.new-enrollment", 1, "enr_new")
    await settle()
    expect(h.sent).toHaveLength(3)
    expect(h.sent[2].body.rows.map((row) => row.sessionId)).toEqual(["a1"])
  })

  test("a deleted session is published as removed", async () => {
    const h = up()
    h.put(row(WS_A, "a1"))
    h.serve([WS_A])
    await settle()

    h.drop(WS_A, "a1")
    h.publisher.sessionRemoved(WS_A, "a1")
    await settle()

    expect(h.sent[1]?.body).toEqual({ hostId: "host_1", rows: [], removed: [{ workspaceId: WS_A, sessionId: "a1" }], attention: [] })
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

  test("a full resync publishes the runtime's committed tombstones", async () => {
    const h = up()
    h.put(row(WS_A, "a1"))
    h.put(row(WS_A, "a2"))
    h.serve([WS_A])
    await settle()

    h.drop(WS_A, "a2")
    h.publisher.resync()
    await settle()

    expect(h.sent[1]?.body).toEqual({ hostId: "host_1", rows: [row(WS_A, "a1", { replayed: true })], removed: [{ workspaceId: WS_A, sessionId: "a2" }], attention: [] })
  })

  test("startup recovers an unpublished committed deletion and never infers deletion from list absence", async () => {
    const h = up()
    h.drop(WS_A, "deleted_before_restart")
    h.put(row(WS_A, "a1"))
    h.serve([WS_A])
    await settle()
    expect(h.sent[0].body.removed).toEqual([{ workspaceId: WS_A, sessionId: "deleted_before_restart" }])
    h.omit(WS_A, "a1")
    h.publisher.sessionChanged(WS_A, "a1")
    await settle()
    expect(h.sent).toHaveLength(1)
    h.publisher.resync()
    await settle()
    expect(h.sent[1].body.removed).toEqual([{ workspaceId: WS_A, sessionId: "deleted_before_restart" }])
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
      rows: [row(WS_A, "a2", { replayed: true }), row(WS_A, "a3", { replayed: false })],
      removed: [{ workspaceId: WS_A, sessionId: "a1" }],
      attention: [batch(WS_A, "a3")],
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
    expect(h.sent[1]?.body.rows).toEqual([row(WS_A, "a1", { replayed: true })])
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

  test("a refused row still publishes its authoritative tombstone on recovery", async () => {
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

    expect(h.sent[1]?.body.removed).toEqual([{ workspaceId: WS_A, sessionId: "a1" }, { workspaceId: WS_A, sessionId: "a2" }])
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

  test("recovery seeds existing Working quietly while a first live busy row retains its entry on retry", async () => {
    const h = up()
    const held = row(WS_A, "held", { attention: { sequence: 10, generation: 1, activitySequence: 2, activityAt: 100,
      working: true, awaitingInput: false } })
    h.put(held)
    h.serve([WS_A])
    await settle()
    expect(h.sent[0]?.body.rows).toEqual([{ ...held, replayed: true }])
    const fresh = row(WS_A, "fresh", { attention: { sequence: 4, generation: 1, activitySequence: 2, activityAt: 200,
      working: true, awaitingInput: false } })
    h.put(fresh)
    h.answer(() => new Response("Fanout failed", { status: 500 }))
    h.publisher.sessionChanged(WS_A, "fresh")
    await settle()
    expect(h.sent[1]?.body.rows).toEqual([{ ...fresh, replayed: false }])
    await settle(1_000)
    expect(h.sent[2]?.body.rows).toEqual([{ ...fresh, replayed: false }])
  })

  test("an unreadable initial workspace keeps recovery provenance until its canonical snapshot is acknowledged", async () => {
    const h = up()
    h.unreadable(WS_A, true)
    h.serve([WS_A])
    await settle()
    expect(h.sent).toEqual([])
    const held = row(WS_A, "held", { attention: { sequence: 10, generation: 1, activitySequence: 2, activityAt: 100,
      working: true, awaitingInput: false } })
    h.put(held)
    h.unreadable(WS_A, false)
    await settle(1_000)
    expect(h.sent[0]?.body.rows).toEqual([{ ...held, replayed: true }])
    h.publisher.sessionChanged(WS_A, "held")
    await settle()
    expect(h.sent[1]?.body.rows).toEqual([{ ...held, replayed: true }])
  })

  test("an old successful POST cannot acknowledge a newer serving generation's recovery or attention position", async () => {
    const h = up()
    const previous = row(WS_A, "held", { attention: { sequence: 4, generation: 1, activitySequence: 2, activityAt: 100,
      working: true, awaitingInput: false } })
    const outcome = { sequence: 3, kind: "outcome" as const, outcome: "completed" as const, openedAt: 110 }
    h.put(previous)
    h.history(WS_A, "held", [outcome])
    let release!: (response: Response) => void
    h.answer(() => new Promise<Response>((resolve) => { release = resolve }))
    h.serve([WS_A])
    await settle()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.body.rows).toEqual([{ ...previous, replayed: true }])

    h.serve([WS_A], "htt.new-generation", 1)
    const recovered = row(WS_A, "held", { attention: { sequence: 10, generation: 1, activitySequence: 6, activityAt: 200,
      working: true, awaitingInput: false } })
    const question = { sequence: 6, kind: "question" as const, requestId: "question", openedAt: 200 }
    h.put(recovered)
    h.history(WS_A, "held", [outcome, question])
    release(Response.json({ accepted: 1, refused: [] }))
    await settle()
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]?.token).toBe("Bearer htt.new-generation")
    expect(h.sent[1]?.body.rows).toEqual([{ ...recovered, replayed: true }])
    expect(h.sent[1]?.body.attention).toEqual([{ workspaceId: WS_A, sessionId: "held", generation: 1, through: 10,
      events: [outcome, question] }])

    const live = { ...recovered, attention: { ...recovered.attention!, sequence: 14, activitySequence: 14 } }
    h.put(live)
    h.publisher.sessionChanged(WS_A, "held")
    await settle()
    expect(h.sent[2]?.body.rows).toEqual([{ ...live, replayed: false }])
  })

  test("same-authority token renewal preserves an in-flight acknowledgement and recovery baseline", async () => {
    const h = up()
    const held = row(WS_A, "held", { attention: { sequence: 4, generation: 1, activitySequence: 2, activityAt: 100,
      working: true, awaitingInput: false } })
    h.put(held)
    let release!: (response: Response) => void
    h.answer(() => new Promise<Response>((resolve) => { release = resolve }))
    h.serve([WS_A])
    await settle()
    h.serve([WS_A], "htt.renewed")
    release(Response.json({ accepted: 1, refused: [] }))
    await settle()
    expect(h.sent).toHaveLength(1)
    h.publisher.sessionChanged(WS_A, "held")
    await settle()
    expect(h.sent[1]?.token).toBe("Bearer htt.renewed")
    expect(h.sent[1]?.body.rows).toEqual([{ ...held, replayed: true }])
    expect(h.sent[1]?.body.attention).toEqual([])
  })

  test("credential loss fences a delayed refusal without poisoning the restored credential", async () => {
    const h = up()
    h.put(row(WS_A, "held"))
    let release!: (response: Response) => void
    h.answer(() => new Promise<Response>((resolve) => { release = resolve }))
    h.serve([WS_A])
    await settle()
    h.publisher.credentialChanged(undefined)
    h.serve([WS_A])
    release(new Response("Old serving scope refused", { status: 401 }))
    await settle()
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]?.token).toBe("Bearer htt.1")
    expect(h.sent[1]?.body.rows).toEqual([row(WS_A, "held", { replayed: true })])
    expect(vi.getTimerCount()).toBe(0)
  })

  test("a serving scope change during source acquisition sends only the current workspace snapshot", async () => {
    let release!: () => void
    let acquiring = true
    const h = up({ prepareWorkspace: async () => {
      if (acquiring) { acquiring = false; await new Promise<void>((resolve) => { release = resolve }) }
    } })
    h.put(row(WS_A, "old"))
    h.put(row(WS_B, "current"))
    h.serve([WS_A])
    await settle()
    expect(h.sent).toEqual([])
    h.serve([WS_B], "htt.current")
    release()
    await settle()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.token).toBe("Bearer htt.current")
    expect(h.sent[0]?.body.rows).toEqual([row(WS_B, "current", { replayed: true })])
    expect(vi.getTimerCount()).toBe(0)
  })

  test("a first live Working entry before the initial snapshot stays live through failed publication", async () => {
    const h = up()
    h.serve([WS_A])
    const fresh = row(WS_A, "fresh", { status: { kind: "busy", awaitingInput: false, at: 200 },
      attention: { sequence: 4, generation: 1, activitySequence: 2, activityAt: 200,
        working: true, awaitingInput: false } })
    h.put(fresh)
    h.publisher.sessionChanged(WS_A, "fresh")
    h.answer(() => new Response("Private fanout failed", { status: 500 }))
    await settle()
    expect(h.sent[0]?.body.rows).toEqual([{ ...fresh, replayed: false }])
    await settle(1_000)
    expect(h.sent[1]?.body.rows).toEqual([{ ...fresh, replayed: false }])
  })

  test("renaming an existing Working row before the initial snapshot does not turn its old entry live", async () => {
    const h = up()
    const held = row(WS_A, "held", { status: { kind: "busy", awaitingInput: false, at: 100 },
      attention: { sequence: 10, generation: 1, activitySequence: 2, activityAt: 100,
        working: true, awaitingInput: false } })
    h.put(held)
    h.serve([WS_A])
    const renamed = { ...held, title: "Renamed", attention: { ...held.attention!, sequence: 11 } }
    h.put(renamed)
    h.publisher.sessionChanged(WS_A, "held")
    await settle()
    expect(h.sent[0]?.body.rows).toEqual([{ ...renamed, replayed: true }])
  })

  test("runtime mounting seeds held entries before live frames while admitting a fresh root in the first batch", async () => {
    const h = up()
    h.unmounted(WS_A, true)
    h.serve([WS_A])
    const held = row(WS_A, "held", { status: { kind: "busy", awaitingInput: false, at: 100 },
      attention: { sequence: 10, generation: 1, activitySequence: 2, activityAt: 100,
        working: true, awaitingInput: false } })
    h.put(held)
    h.unmounted(WS_A, false)
    h.publisher.workspaceMounted(WS_A)
    h.publisher.sessionChanged(WS_A, "held")
    const fresh = { ...held, sessionId: "fresh", attention: { ...held.attention!, sequence: 4 } }
    h.put(fresh)
    h.publisher.sessionChanged(WS_A, "fresh")
    await settle()
    expect(h.sent[0]?.body.rows).toEqual([{ ...held, replayed: true }, { ...fresh, replayed: false }])
  })

  test("an old attention read cannot overwrite a newer serving generation's observed live entry", async () => {
    let release!: () => void
    let firstRead = true
    const h = up({ beforeAttentionPage: async () => {
      if (firstRead) { firstRead = false; await new Promise<void>((resolve) => { release = resolve }) }
    } })
    const previous = row(WS_A, "held", { status: { kind: "busy", awaitingInput: false, at: 100 },
      attention: { sequence: 4, generation: 1, activitySequence: 2, activityAt: 100,
        working: true, awaitingInput: false } })
    h.put(previous)
    h.serve([WS_A])
    await settle()
    expect(h.sent).toEqual([])
    h.serve([WS_A], "htt.current", 1)
    const live = { ...previous, attention: { ...previous.attention!, sequence: 10, activitySequence: 10 } }
    h.put(live)
    h.publisher.sessionChanged(WS_A, "held")
    release()
    await settle()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.token).toBe("Bearer htt.current")
    expect(h.sent[0]?.body.rows).toEqual([{ ...live, replayed: false }])
  })

  test("a collected old row and failed POST cannot replace a newer live entry's origin within one serving generation", async () => {
    let release!: () => void
    let firstRead = true
    const h = up({ beforeAttentionPage: async () => {
      if (firstRead) { firstRead = false; await new Promise<void>((resolve) => { release = resolve }) }
    } })
    const previous = row(WS_A, "held", { status: { kind: "busy", awaitingInput: false, at: 100 },
      attention: { sequence: 5, generation: 1, activitySequence: 2, activityAt: 100,
        working: true, awaitingInput: false } })
    h.put(previous)
    h.serve([WS_A])
    await settle()
    const live = { ...previous, attention: { ...previous.attention!, sequence: 8, activitySequence: 8 } }
    h.put(live)
    h.publisher.sessionChanged(WS_A, "held")
    h.answer(() => new Response("Private fanout failed", { status: 500 }))
    release()
    await settle()
    expect(h.sent[0]?.body.rows).toEqual([{ ...previous, replayed: true }])
    await settle(1_000)
    expect(h.sent[1]?.body.rows).toEqual([{ ...live, replayed: false }])
  })
})
