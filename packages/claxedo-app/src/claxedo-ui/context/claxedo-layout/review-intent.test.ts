import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"
import { createReviewIntentAdapter, pickPreviewSessionId, sumChanges, type ReviewPopoverMode } from "./review-intent"

function waitTick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function session(input: { id: string; directory: string; created: number; updated?: number; archived?: boolean }) {
  return {
    id: input.id,
    slug: input.id,
    projectID: "project-1",
    title: input.id,
    version: "v2",
    directory: input.directory,
    time: {
      created: input.created,
      updated: input.updated,
      archived: input.archived ?? false,
    },
  } as unknown as Session
}

describe("review intent adapter", () => {
  test("sumChanges returns aggregated additions/deletions", () => {
    const out = sumChanges([
      { file: "a.ts", before: "old", after: "new", additions: 3, deletions: 1 },
      { file: "b.ts", before: "old", after: "new", additions: 2, deletions: 4 },
      { file: "c.ts", before: "old", after: "new", additions: 0, deletions: 1 },
    ])
    expect(out).toEqual({ additions: 5, deletions: 6 })
  })

  test("pickPreviewSessionId chooses preferred session when present", () => {
    const sessions = [
      session({ id: "s1", directory: "/ws", created: 1, updated: 10 }),
      session({ id: "s2", directory: "/ws", created: 2, updated: 20 }),
    ]
    expect(pickPreviewSessionId({ directory: "/ws", sessions, preferred: "s1" })).toBe("s1")
  })

  test("pickPreviewSessionId falls back to most recently updated", () => {
    const sessions = [
      session({ id: "s1", directory: "/ws", created: 1, updated: 10 }),
      session({ id: "s2", directory: "/ws", created: 2, updated: 20 }),
      session({ id: "s3", directory: "/other", created: 3, updated: 30 }),
      session({ id: "s4", directory: "/ws", created: 4, updated: 40, archived: true }),
    ]
    expect(pickPreviewSessionId({ directory: "/ws", sessions })).toBe("s2")
  })

  test("loadBaseTargets returns resolved candidates", async () => {
    const adapter = createReviewIntentAdapter({
      session: {
        diffTargets: async () => ({ data: { defaultRef: "origin/dev", candidates: ["origin/dev", "origin/main"] } }),
        diff: async () => ({ data: [] }),
      },
      formatError: (error) => String(error),
    })

    const out = await adapter.loadBaseTargets({
      directory: "/ws",
      mode: "to-from",
      reviewWorktree: "/ws",
      context: { directory: "/ws", groupId: "g1" },
      activeWorkspaceId: "/ws",
      activeSessionId: "s1",
      routeDir: "/ws",
      routeTabId: "tab-1",
      routeSessionId: "s1",
    })

    expect(out).toEqual({ kind: "ok", defaultRef: "origin/dev", candidates: ["origin/dev", "origin/main"] })
  })

  test("refreshDiffModeStats patches missing input errors", () => {
    const calls: Array<{ mode: ReviewPopoverMode; error?: string }> = []
    const adapter = createReviewIntentAdapter({
      session: {
        diffTargets: async () => ({ data: undefined }),
        diff: async () => ({ data: [] }),
      },
      formatError: (error) => String(error),
    })

    adapter.refreshDiffModeStats({
      modes: ["to-from"],
      directory: undefined,
      sessionID: undefined,
      from: "",
      to: "",
      context: undefined,
      patch(mode, next) {
        calls.push({ mode, error: next.error })
      },
    })

    expect(calls).toEqual([
      { mode: "to-from", error: "Enter from and to refs" },
    ])
  })

  test("refreshDiffModeStats computes additions/deletions from SDK diff", async () => {
    const calls: Array<{ mode: ReviewPopoverMode; loading?: boolean; ready?: boolean; files?: number }> = []
    const adapter = createReviewIntentAdapter({
      session: {
        diffTargets: async () => ({ data: undefined }),
        diff: async () => ({
          data: [
            { file: "a.ts", before: "old", after: "new", additions: 2, deletions: 1 },
            { file: "b.ts", before: "old", after: "new", additions: 3, deletions: 4 },
          ],
        }),
      },
      formatError: (error) => String(error),
    })

    adapter.refreshDiffModeStats({
      modes: ["staged"],
      directory: "/ws",
      sessionID: "s1",
      from: "",
      to: "",
      context: { directory: "/ws", groupId: "g1", sessionID: "s1" },
      patch(mode, next) {
        calls.push({ mode, loading: next.loading, ready: next.ready, files: next.files })
      },
    })

    await waitTick()

    expect(calls[0]).toEqual({ mode: "staged", loading: true, ready: false, files: undefined })
    expect(calls[1]).toEqual({ mode: "staged", loading: false, ready: true, files: 2 })
  })
})
