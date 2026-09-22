import { beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"
import type { QuestionRequest, SessionStatus } from "../data/sync/queries"
import { applyDirectoryEventToShellQueries } from "../data/sync/directory-event-projector"
import { applyDirectorySessionMeta } from "./directory-session-meta"
import { dispatchSessionRequestsEvent, subscribeSessionActivity } from "./session-status-dispatcher"

const SESSION = "ses_meta"
const OTHER = "ses_other"

const readStatus = (sessionID: string) =>
  queryClient.getQueryData<SessionStatus>(shellDataKeys.sessionId(sessionID, "status"))
const readRequests = (sessionID: string) =>
  queryClient.getQueryData<{ permissions: unknown[]; questions: unknown[] }>(
    shellDataKeys.sessionId(sessionID, "requests"),
  )

const permission = (id: string, sessionID: string) =>
  ({ id, sessionID, permission: "edit", patterns: [], metadata: {}, always: [] }) as never

const question = (id: string, sessionID: string): QuestionRequest =>
  ({ id, sessionID, questions: [{ question: "Keep going?", header: "Next", options: [] }] })

describe("applyDirectorySessionMeta", () => {
  beforeEach(() => {
    queryClient.removeQueries({ queryKey: ["shell", "session"] })
  })

  test("projects one session's slice out of a directory-wide read", () => {
    applyDirectorySessionMeta({
      sessionID: SESSION,
      status: { [SESSION]: { type: "busy" }, [OTHER]: { type: "idle" } },
      permissions: [permission("perm_mine", SESSION), permission("perm_theirs", OTHER)],
      questions: [],
    })

    expect(readStatus(SESSION)).toEqual({ type: "busy" })
    expect(readRequests(SESSION)?.permissions).toEqual([permission("perm_mine", SESSION)])
    // The other session's row in the same payload is not this call's business.
    expect(readStatus(OTHER)).toBeUndefined()
  })

  test("a session absent from the payload settles to idle rather than staying unknown", () => {
    applyDirectorySessionMeta({ sessionID: SESSION, status: {}, permissions: [], questions: [] })

    expect(readStatus(SESSION)).toEqual({ type: "idle" })
  })

  test("omitted request lists keep the cached ones instead of clearing them", () => {
    applyDirectorySessionMeta({
      sessionID: SESSION,
      status: { [SESSION]: { type: "busy" } },
      permissions: [permission("perm_mine", SESSION)],
      questions: [],
    })

    // A status-only read (`includeRequests: false`) must not erase requests.
    applyDirectorySessionMeta({ sessionID: SESSION, status: { [SESSION]: { type: "busy" } } })

    expect(readRequests(SESSION)?.permissions).toEqual([permission("perm_mine", SESSION)])
  })

  test("a failed status leg does not erase busy while successful requests reconcile", () => {
    applyDirectorySessionMeta({
      sessionID: SESSION,
      status: { [SESSION]: { type: "busy" } },
      permissions: [],
      questions: [],
    })

    applyDirectorySessionMeta({
      sessionID: SESSION,
      permissions: [permission("perm_mine", SESSION)],
      questions: [],
    })

    expect(readStatus(SESSION)).toEqual({ type: "busy" })
    expect(readRequests(SESSION)?.permissions).toEqual([permission("perm_mine", SESSION)])
  })

  test("a failed cold status leg does not invent idle while requests reconcile", () => {
    applyDirectorySessionMeta({
      sessionID: SESSION,
      permissions: [permission("perm_mine", SESSION)],
      questions: [],
    })

    expect(readStatus(SESSION)).toBeUndefined()
    expect(readRequests(SESSION)?.permissions).toEqual([permission("perm_mine", SESSION)])
  })

  test("a partial request read cannot erase cached busy with an idle status", () => {
    queryClient.setQueryData(shellDataKeys.sessionId(SESSION, "status"), { type: "busy" })

    applyDirectorySessionMeta({
      sessionID: SESSION,
      status: { [SESSION]: { type: "idle" } },
      // Questions completed empty, but permissions failed and are unknown.
      questions: [],
    })

    expect(readStatus(SESSION)).toEqual({ type: "busy" })
    expect(readRequests(SESSION)).toEqual({ permissions: [], questions: [] })
  })

  test("a real status change still reaches session-activity subscribers", () => {
    applyDirectorySessionMeta({ sessionID: SESSION, status: { [SESSION]: { type: "idle" } }, permissions: [], questions: [] })
    let notified = 0
    const release = subscribeSessionActivity(SESSION, () => { notified += 1 })

    applyDirectorySessionMeta({ sessionID: SESSION, status: { [SESSION]: { type: "busy" } }, permissions: [], questions: [] })

    expect(notified).toBeGreaterThan(0)
    expect(readStatus(SESSION)).toEqual({ type: "busy" })
    release()
  })

  // Replaying the same payload must not churn the stored objects. It still
  // emits a cache event -- `setQueryData` always does -- so this pins the
  // identity contract the two cache-only observers read through, not silence.
  // A full read stamps `reconciledAt` from the clock, so the clock is held.
  test("replaying an identical payload keeps the stored objects", () => {
    setSystemTime(1_790_000_000_000)
    try {
      const payload = {
        sessionID: SESSION,
        status: { [SESSION]: { type: "idle" as const } },
        permissions: [],
        questions: [],
      }
      applyDirectorySessionMeta(payload)
      const status = readStatus(SESSION)
      const requests = readRequests(SESSION)

      applyDirectorySessionMeta(payload)

      expect(readStatus(SESSION)).toBe(status)
      expect(readRequests(SESSION)).toBe(requests)
    } finally {
      setSystemTime()
    }
  })
})

describe("applyDirectorySessionMeta, requests already resolved", () => {
  const RESOLVED = "ses_resolved"

  beforeEach(() => {
    queryClient.removeQueries({ queryKey: ["shell", "session"] })
  })

  const ask = (question: QuestionRequest) =>
    applyDirectoryEventToShellQueries({
      event: { type: "question.asked", properties: question },
      directory: "/w",
    })
  const reply = (type: "question.replied" | "permission.replied", sessionID: string, requestID: string) =>
    applyDirectoryEventToShellQueries({
      event: { type, properties: { sessionID, requestID } },
      directory: "/w",
    })

  test("a read that still lists a replied question does not put it back", () => {
    ask(question("que_answered", RESOLVED))
    reply("question.replied", RESOLVED, "que_answered")

    applyDirectorySessionMeta({
      sessionID: RESOLVED,
      status: { [RESOLVED]: { type: "idle" } },
      permissions: [],
      questions: [question("que_answered", RESOLVED)],
    })

    expect(readRequests(RESOLVED)?.questions).toEqual([])
  })

  test("a read that still lists a replied permission does not put it back", () => {
    applyDirectorySessionMeta({
      sessionID: RESOLVED,
      status: { [RESOLVED]: { type: "busy" } },
      permissions: [permission("perm_decided", RESOLVED)],
      questions: [],
    })
    reply("permission.replied", RESOLVED, "perm_decided")

    applyDirectorySessionMeta({
      sessionID: RESOLVED,
      status: { [RESOLVED]: { type: "idle" } },
      permissions: [permission("perm_decided", RESOLVED)],
      questions: [],
    })

    expect(readRequests(RESOLVED)?.permissions).toEqual([])
  })

  // The question dock clears its own entry on a successful reply, before the
  // server's `question.replied` frame arrives.
  test("an optimistically cleared question does not come back with the next read", () => {
    ask(question("que_answered", RESOLVED))
    dispatchSessionRequestsEvent({
      event: {
        type: "session.requests",
        source: "optimistic",
        sessionID: RESOLVED,
        requests: (previous) => ({
          permissions: previous?.permissions ?? [],
          questions: (previous?.questions ?? []).filter((item) => item.id !== "que_answered"),
        }),
      },
    })

    applyDirectorySessionMeta({
      sessionID: RESOLVED,
      status: { [RESOLVED]: { type: "idle" } },
      permissions: [],
      questions: [question("que_answered", RESOLVED)],
    })

    expect(readRequests(RESOLVED)?.questions).toEqual([])
  })

  test("a replied question in the read is no evidence that the turn is still running", () => {
    ask(question("que_answered", RESOLVED))
    reply("question.replied", RESOLVED, "que_answered")
    queryClient.setQueryData(shellDataKeys.sessionId(RESOLVED, "status"), { type: "busy" })

    applyDirectorySessionMeta({
      sessionID: RESOLVED,
      status: { [RESOLVED]: { type: "idle" } },
      permissions: [],
      questions: [question("que_answered", RESOLVED)],
    })

    expect(readStatus(RESOLVED)).toEqual({ type: "idle" })
  })

  test("a question asked after the reply reaches the dock through the same read", () => {
    ask(question("que_answered", RESOLVED))
    reply("question.replied", RESOLVED, "que_answered")

    applyDirectorySessionMeta({
      sessionID: RESOLVED,
      status: { [RESOLVED]: { type: "busy" } },
      permissions: [],
      questions: [question("que_answered", RESOLVED), question("que_next", RESOLVED)],
    })

    expect(readRequests(RESOLVED)?.questions).toEqual([question("que_next", RESOLVED)])
  })

  test("the server asking a fresh request again re-opens it", () => {
    ask(question("que_answered", RESOLVED))
    reply("question.replied", RESOLVED, "que_answered")

    ask(question("que_next", RESOLVED))
    applyDirectorySessionMeta({
      sessionID: RESOLVED,
      permissions: [],
      questions: [question("que_next", RESOLVED)],
    })

    expect(readRequests(RESOLVED)?.questions).toEqual([question("que_next", RESOLVED)])
  })

  // Request ids are minted per ask, so a same-id `asked` frame is only ever a
  // replay of the one already answered — it must not re-open the dock.
  test("a replayed ask for a resolved id stays closed", () => {
    ask(question("que_answered", RESOLVED))
    reply("question.replied", RESOLVED, "que_answered")

    ask(question("que_answered", RESOLVED))
    applyDirectorySessionMeta({
      sessionID: RESOLVED,
      permissions: [],
      questions: [question("que_answered", RESOLVED)],
    })

    expect(readRequests(RESOLVED)?.questions).toEqual([])
  })

  // The guard has to retire, or a reused id could never be shown again.
  test("a read that stops listing the replied question retires the guard", () => {
    ask(question("que_answered", RESOLVED))
    reply("question.replied", RESOLVED, "que_answered")
    applyDirectorySessionMeta({ sessionID: RESOLVED, permissions: [], questions: [] })

    applyDirectorySessionMeta({
      sessionID: RESOLVED,
      permissions: [],
      questions: [question("que_answered", RESOLVED)],
    })

    expect(readRequests(RESOLVED)?.questions).toEqual([question("que_answered", RESOLVED)])
  })

  // A mark the server never stops echoing came from a read whose snapshot
  // predated the ask — the request was never resolved — so the echo bound
  // drops it and the pending request surfaces again.
  test("a marked id the server keeps echoing is unmarked past the echo window", () => {
    const start = Date.now()
    setSystemTime(start)
    try {
      ask(question("que_pending", RESOLVED))
      applyDirectorySessionMeta({ sessionID: RESOLVED, permissions: [], questions: [] })

      applyDirectorySessionMeta({
        sessionID: RESOLVED,
        permissions: [],
        questions: [question("que_pending", RESOLVED)],
      })
      expect(readRequests(RESOLVED)?.questions).toEqual([])

      setSystemTime(start + 16_000)
      applyDirectorySessionMeta({
        sessionID: RESOLVED,
        permissions: [],
        questions: [question("que_pending", RESOLVED)],
      })
      applyDirectorySessionMeta({
        sessionID: RESOLVED,
        permissions: [],
        questions: [question("que_pending", RESOLVED)],
      })
      expect(readRequests(RESOLVED)?.questions).toEqual([question("que_pending", RESOLVED)])
    } finally {
      setSystemTime()
    }
  })

  // The attach gate releases held requests only once a read newer than the
  // attach confirms them — a same-lists read still has to advance the stamp.
  test("a canonical read with unchanged lists still advances reconciledAt", () => {
    const start = Date.now()
    setSystemTime(start)
    try {
      applyDirectorySessionMeta({
        sessionID: RESOLVED,
        permissions: [],
        questions: [question("que_open", RESOLVED)],
      })
      const first = readRequests(RESOLVED) as { reconciledAt?: number } | undefined
      expect(first?.reconciledAt).toBe(start)

      setSystemTime(start + 1_000)
      applyDirectorySessionMeta({
        sessionID: RESOLVED,
        permissions: [],
        questions: [question("que_open", RESOLVED)],
      })
      const second = readRequests(RESOLVED) as { reconciledAt?: number } | undefined
      expect(second?.reconciledAt).toBe(start + 1_000)
      expect(second?.questions).toBe(first?.questions)
    } finally {
      setSystemTime()
    }
  })
})
