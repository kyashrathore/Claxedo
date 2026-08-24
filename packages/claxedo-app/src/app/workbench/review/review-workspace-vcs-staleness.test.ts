import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"

import { createReviewWorkspaceVcsStaleness } from "./review-workspace-vcs-staleness"

type Handler = (event: { details: { type: string; properties?: unknown } }) => void

function harness(run: (context: {
  emit: Handler
  invalidated: string[]
  staleness: ReturnType<typeof createReviewWorkspaceVcsStaleness>
  stopped: () => boolean
  dispose: () => void
}) => void) {
  let handler: Handler | undefined
  let stopped = false
  const invalidated: string[] = []
  createRoot((dispose) => {
    const staleness = createReviewWorkspaceVcsStaleness({
      listen: (next) => {
        handler = next
        return () => {
          stopped = true
        }
      },
      directory: () => "/repo",
      sessionId: () => "ses_review",
      invalidate: ({ directory }) => invalidated.push(directory),
    })
    run({
      emit: (event) => handler?.(event),
      invalidated,
      staleness,
      stopped: () => stopped,
      dispose,
    })
    dispose()
  })
}

describe("review workspace vcs staleness", () => {
  test("drops the shared cache and bumps the diffs version on a working-tree change", () => {
    harness(({ emit, invalidated, staleness }) => {
      expect(staleness.diffsVersion()).toBe(0)

      emit({ details: { type: "file.watcher.updated", properties: { file: "src/app.ts" } } })

      // Invalidating covers the review whose surface is unmounted; the version
      // covers the one on screen.
      expect(invalidated).toEqual(["/repo"])
      expect(staleness.diffsVersion()).toBe(1)
      expect(staleness.branchVersion()).toBe(0)
    })
  })

  test("bumps both versions on a branch update", () => {
    harness(({ emit, staleness, invalidated }) => {
      emit({ details: { type: "vcs.branch.updated" } })

      expect(invalidated).toEqual(["/repo"])
      expect(staleness.diffsVersion()).toBe(1)
      expect(staleness.branchVersion()).toBe(1)
    })
  })

  test("tracks this session's status across events and only reacts when a turn settles", () => {
    harness(({ emit, invalidated, staleness }) => {
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
      expect(invalidated).toEqual(["/repo"])
    })
  })

  test("ignores unrelated events and stops listening when the workspace goes away", () => {
    harness(({ emit, invalidated, staleness, stopped, dispose }) => {
      emit({ details: { type: "message.updated" } })
      emit({ details: { type: "file.watcher.updated", properties: { file: ".git/index" } } })
      expect(invalidated).toEqual([])
      expect(staleness.diffsVersion()).toBe(0)

      expect(stopped()).toBe(false)
      dispose()
      expect(stopped()).toBe(true)
    })
  })
})
