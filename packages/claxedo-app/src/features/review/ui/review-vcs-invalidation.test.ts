import { describe, expect, test } from "bun:test"

import { createReviewVcsDirectoryClassifier } from "./review-vcs-invalidation"

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
