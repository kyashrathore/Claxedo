import { describe, expect, test } from "bun:test"

import {
  createReviewVcsDirectoryClassifier,
  reviewVcsInvalidationFromEvent,
} from "./review-vcs-invalidation"

const sessionId = "ses_review"

function classify(event: { type: string; properties?: unknown }, lastSessionStatusType?: string) {
  return reviewVcsInvalidationFromEvent({ event, sessionId, lastSessionStatusType })
}

describe("review vcs invalidation", () => {
  test("stales the diffs when a watched file changes", () => {
    expect(classify({ type: "file.watcher.updated", properties: { file: "src/app.ts" } }))
      .toEqual({ diffs: true, branch: false })
  })

  test("ignores git's own bookkeeping and malformed watcher events", () => {
    expect(classify({ type: "file.watcher.updated", properties: { file: ".git/index" } }))
      .toEqual({ diffs: false, branch: false })
    expect(classify({ type: "file.watcher.updated", properties: {} }))
      .toEqual({ diffs: false, branch: false })
    expect(classify({ type: "file.watcher.updated" }))
      .toEqual({ diffs: false, branch: false })
  })

  test("stales both the diffs and the branch names on a branch update", () => {
    expect(classify({ type: "vcs.branch.updated" })).toEqual({ diffs: true, branch: true })
  })

  test("stales the diffs only when this session's turn settles", () => {
    const running = classify({ type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } })
    expect(running).toEqual({ diffs: false, branch: false, nextSessionStatusType: "busy" })

    expect(classify(
      { type: "session.status", properties: { sessionID: sessionId, status: { type: "idle" } } },
      running.nextSessionStatusType,
    )).toEqual({ diffs: true, branch: false, nextSessionStatusType: "idle" })

    // Already idle: nothing ran, so nothing changed.
    expect(classify(
      { type: "session.status", properties: { sessionID: sessionId, status: { type: "idle" } } },
      "idle",
    )).toEqual({ diffs: false, branch: false, nextSessionStatusType: "idle" })

    // First status seen for a session is not a completed turn.
    expect(classify({ type: "session.status", properties: { sessionID: sessionId, status: { type: "idle" } } }))
      .toEqual({ diffs: false, branch: false, nextSessionStatusType: "idle" })
  })

  test("ignores another session's status and unrelated events", () => {
    expect(classify(
      { type: "session.status", properties: { sessionID: "ses_other", status: { type: "idle" } } },
      "busy",
    )).toEqual({ diffs: false, branch: false })
    expect(classify({ type: "message.updated" })).toEqual({ diffs: false, branch: false })
  })
})

describe("review vcs directory classifier", () => {
  test("stales on working-tree and branch changes, never on git bookkeeping", () => {
    const stale = createReviewVcsDirectoryClassifier()

    expect(stale({ type: "file.watcher.updated", properties: { file: "src/app.ts" } })).toBe(true)
    expect(stale({ type: "file.watcher.updated", properties: { file: ".git/index" } })).toBe(false)
    expect(stale({ type: "vcs.branch.updated" })).toBe(true)
    expect(stale({ type: "message.updated" })).toBe(false)
  })

  test("stales when ANY session on the stream settles a turn", () => {
    const stale = createReviewVcsDirectoryClassifier()
    const status = (sessionID: string, type: string) => ({
      type: "session.status",
      properties: { sessionID, status: { type } },
    })

    // First observation of a session is not a completed turn.
    expect(stale(status("ses_a", "idle"))).toBe(false)
    expect(stale(status("ses_a", "busy"))).toBe(false)
    // A DIFFERENT session settling also means the worktree may have changed.
    expect(stale(status("ses_b", "busy"))).toBe(false)
    expect(stale(status("ses_b", "idle"))).toBe(true)
    expect(stale(status("ses_a", "idle"))).toBe(true)
    // Idle to idle is not a settle.
    expect(stale(status("ses_a", "idle"))).toBe(false)
    // A status event with no session id cannot be classified.
    expect(stale({ type: "session.status", properties: { status: { type: "idle" } } })).toBe(false)
  })
})
