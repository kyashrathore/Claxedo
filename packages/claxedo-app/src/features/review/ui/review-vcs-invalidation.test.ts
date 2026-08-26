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

  test("stales the diffs on a git index write -- `git add` produces nothing else", () => {
    expect(classify({ type: "file.watcher.updated", properties: { file: ".git/index" } }))
      .toEqual({ diffs: true, branch: false })
  })

  test("stales the diffs and branch when HEAD or refs move", () => {
    expect(classify({ type: "file.watcher.updated", properties: { file: ".git/HEAD" } }))
      .toEqual({ diffs: true, branch: true })
    expect(classify({ type: "file.watcher.updated", properties: { file: ".git/refs/heads/main" } }))
      .toEqual({ diffs: true, branch: true })
    expect(classify({ type: "file.watcher.updated", properties: { file: ".git/packed-refs" } }))
      .toEqual({ diffs: true, branch: true })
  })

  test("ignores noisy git internals and malformed watcher events", () => {
    expect(classify({ type: "file.watcher.updated", properties: { file: ".git/objects/ab/cdef0123" } }))
      .toEqual({ diffs: false, branch: false })
    expect(classify({ type: "file.watcher.updated", properties: { file: ".git/index.lock" } }))
      .toEqual({ diffs: false, branch: false })
    expect(classify({ type: "file.watcher.updated", properties: { file: ".git/refs/heads/main.lock" } }))
      .toEqual({ diffs: false, branch: false })
    expect(classify({ type: "file.watcher.updated", properties: { file: ".git/FETCH_HEAD" } }))
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
  test("separates worktree staleness from branch staleness, and drops git noise", () => {
    const stale = createReviewVcsDirectoryClassifier()
    const nothing = { diffs: false, branch: false }

    expect(stale({ type: "file.watcher.updated", properties: { file: "src/app.ts" } }))
      .toEqual({ diffs: true, branch: false })
    // `git add` / `git reset` write ONLY the index: it must invalidate the
    // diffs, but it never moves HEAD.
    expect(stale({ type: "file.watcher.updated", properties: { file: ".git/index" } }))
      .toEqual({ diffs: true, branch: false })
    // HEAD/refs writes are the ONLY thing that makes the cached branch wrong.
    expect(stale({ type: "file.watcher.updated", properties: { file: ".git/HEAD" } }))
      .toEqual({ diffs: true, branch: true })
    expect(stale({ type: "file.watcher.updated", properties: { file: ".git/refs/heads/main" } }))
      .toEqual({ diffs: true, branch: true })
    expect(stale({ type: "file.watcher.updated", properties: { file: ".git/packed-refs" } }))
      .toEqual({ diffs: true, branch: true })
    expect(stale({ type: "file.watcher.updated", properties: { file: ".git/objects/ab/cdef0123" } })).toEqual(nothing)
    expect(stale({ type: "file.watcher.updated", properties: { file: ".git/index.lock" } })).toEqual(nothing)
    expect(stale({ type: "vcs.branch.updated" })).toEqual({ diffs: true, branch: true })
    expect(stale({ type: "message.updated" })).toEqual(nothing)
  })

  test("stales the diffs when ANY session on the stream settles a turn, never the branch", () => {
    const stale = createReviewVcsDirectoryClassifier()
    const status = (sessionID: string, type: string) => ({
      type: "session.status",
      properties: { sessionID, status: { type } },
    })
    const settled = { diffs: true, branch: false }
    const nothing = { diffs: false, branch: false }

    // First observation of a session is not a completed turn.
    expect(stale(status("ses_a", "idle"))).toEqual(nothing)
    expect(stale(status("ses_a", "busy"))).toEqual(nothing)
    // A DIFFERENT session settling also means the worktree may have changed.
    expect(stale(status("ses_b", "busy"))).toEqual(nothing)
    expect(stale(status("ses_b", "idle"))).toEqual(settled)
    expect(stale(status("ses_a", "idle"))).toEqual(settled)
    // Idle to idle is not a settle.
    expect(stale(status("ses_a", "idle"))).toEqual(nothing)
    // A status event with no session id cannot be classified.
    expect(stale({ type: "session.status", properties: { status: { type: "idle" } } })).toEqual(nothing)
  })
})
