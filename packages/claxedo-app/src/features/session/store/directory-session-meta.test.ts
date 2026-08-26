import { beforeEach, describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"
import type { SessionStatus } from "../data/sync/queries"
import { applyDirectorySessionMeta } from "./directory-session-meta"
import { subscribeSessionActivity } from "./session-status-dispatcher"

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
  test("replaying an identical payload keeps the stored objects", () => {
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
  })
})
