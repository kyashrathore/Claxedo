import { describe, expect, test } from "bun:test"
import { createRoot, flush } from "solid-js"

import { createReviewWorkspaceVcsStaleness } from "./review-workspace-vcs-staleness"

type Handler = (event: { details: { type: string; properties?: unknown } }) => void

/**
 * Builds the subscription inside an owned root and delivers events from OUTSIDE it.
 *
 * Solid 2 rejects a signal write made while an owned scope is current
 * (`REACTIVE_WRITE_IN_OWNED_SCOPE`), and the staleness counters are signals.
 * Delivering from outside the root is also what the app does: `sdk.event.listen`
 * calls the handler from the event stream, never from inside a computation. The
 * root still owns the subscription, so `dispose` runs its `onCleanup`.
 *
 * Each delivery settles before returning: Solid 2 stages writes until the
 * scheduler flushes, and a runtime event is its own task, so the version a
 * caller reads on the next line is the committed one.
 */
function harness(
  run: (context: {
    emit: Handler
    staleness: ReturnType<typeof createReviewWorkspaceVcsStaleness>
    stopped: () => boolean
    dispose: () => void
  }) => void,
) {
  let handler: Handler | undefined
  let stopped = false
  const { staleness, dispose } = createRoot((dispose) => ({
    staleness: createReviewWorkspaceVcsStaleness({
      listen: (next) => {
        handler = next
        return () => {
          stopped = true
        }
      },
      sessionId: () => "ses_review",
    }),
    dispose,
  }))
  run({
    emit: (event) => {
      handler?.(event)
      flush()
    },
    staleness,
    stopped: () => stopped,
    dispose,
  })
  dispose()
}

describe("review workspace vcs staleness", () => {
  test("bumps the diffs version on a working-tree change", () => {
    harness(({ emit, staleness }) => {
      expect(staleness.diffsVersion()).toBe(0)

      emit({ details: { type: "file.watcher.updated", properties: { file: "src/app.ts" } } })

      expect(staleness.diffsVersion()).toBe(1)
      expect(staleness.branchVersion()).toBe(0)
    })
  })

  test("bumps the diffs version on a git index write", () => {
    harness(({ emit, staleness }) => {
      emit({ details: { type: "file.watcher.updated", properties: { file: ".git/index" } } })

      expect(staleness.diffsVersion()).toBe(1)
      expect(staleness.branchVersion()).toBe(0)
    })
  })

  test("bumps both versions on a branch update", () => {
    harness(({ emit, staleness }) => {
      emit({ details: { type: "vcs.branch.updated" } })

      expect(staleness.diffsVersion()).toBe(1)
      expect(staleness.branchVersion()).toBe(1)
    })
  })

  test("tracks this session's status across events and only reacts when a turn settles", () => {
    harness(({ emit, staleness }) => {
      const status = (sessionID: string, type: string) => ({
        details: { type: "session.status", properties: { sessionID, status: { type } } },
      })

      emit(status("ses_review", "busy"))
      expect(staleness.diffsVersion()).toBe(0)

      emit(status("ses_other", "idle"))
      emit(status("ses_review", "idle"))
      expect(staleness.diffsVersion()).toBe(1)

      emit(status("ses_review", "idle"))
      expect(staleness.diffsVersion()).toBe(1)
    })
  })

  test("ignores unrelated events and stops listening when the workspace goes away", () => {
    harness(({ emit, staleness, stopped, dispose }) => {
      emit({ details: { type: "message.updated" } })
      emit({ details: { type: "file.watcher.updated", properties: { file: ".git/objects/ab/cdef0123" } } })
      emit({ details: { type: "file.watcher.updated", properties: { file: ".git/index.lock" } } })
      expect(staleness.diffsVersion()).toBe(0)

      expect(stopped()).toBe(false)
      dispose()
      expect(stopped()).toBe(true)
    })
  })
})
