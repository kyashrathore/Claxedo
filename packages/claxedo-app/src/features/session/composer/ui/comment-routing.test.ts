import { describe, expect, test } from "bun:test"
import { createPromptCommentRouter } from "./comment-routing"

function createHarness(input?: { diffFiles?: string[]; reviewOpened?: boolean }) {
  const calls: unknown[] = []
  let focus: { file: string; id: string } | undefined
  let reviewOpened = input?.reviewOpened ?? false
  const router = createPromptCommentRouter({
    comments: {
      setActive: (next) => calls.push(["setActive", next]),
      setFocus: (next) => {
        focus = next
        calls.push(["setFocus", next])
      },
      focus: () => focus,
    },
    diffFiles: () => input?.diffFiles,
    view: () => ({
      reviewPanel: {
        opened: () => reviewOpened,
        open: () => {
          reviewOpened = true
          calls.push(["review.open"])
        },
      },
    }),
    layout: {
      fileTree: {
        setTab: (tab) => calls.push(["fileTree.setTab", tab]),
      },
    },
    tabs: () => ({
      open: (tab) => calls.push(["tabs.open", tab]),
      setActive: (tab) => calls.push(["tabs.setActive", tab]),
    }),
    files: {
      tab: (path) => `file:${path}`,
      load: (path) => {
        calls.push(["files.load", path])
      },
    },
    scheduleFrame: (callback) => callback(),
  })

  return { calls, router }
}

describe("prompt comment routing", () => {
  test("ignores context items without a saved comment id", () => {
    const harness = createHarness()

    harness.router({ path: "src/a.ts" })

    expect(harness.calls).toEqual([])
  })

  test("opens review comments in the review tab and focuses the comment", () => {
    const harness = createHarness()

    harness.router({ path: "src/a.ts", commentID: "c1", commentOrigin: "review" })

    expect(harness.calls.slice(0, 4)).toEqual([
      ["setActive", { file: "src/a.ts", id: "c1" }],
      ["review.open"],
      ["fileTree.setTab", "changes"],
      ["tabs.setActive", "review"],
    ])
    expect(harness.calls).toContainEqual(["setFocus", { file: "src/a.ts", id: "c1" }])
  })

  test("treats diff-backed comments as review comments unless explicitly file-originated", async () => {
    const harness = createHarness({ diffFiles: ["src/a.ts"], reviewOpened: true })

    harness.router({ path: "src/a.ts", commentID: "c1" })

    expect(harness.calls.slice(0, 3)).toEqual([
      ["setActive", { file: "src/a.ts", id: "c1" }],
      ["fileTree.setTab", "changes"],
      ["tabs.setActive", "review"],
    ])

    const fileHarness = createHarness({ diffFiles: ["src/a.ts"], reviewOpened: true })
    fileHarness.router({ path: "src/a.ts", commentID: "c1", commentOrigin: "file" })
    await Promise.resolve()
    await Promise.resolve()

    expect(fileHarness.calls.slice(0, 5)).toEqual([
      ["setActive", { file: "src/a.ts", id: "c1" }],
      ["fileTree.setTab", "all"],
      ["tabs.open", "file:src/a.ts"],
      ["tabs.setActive", "file:src/a.ts"],
      ["files.load", "src/a.ts"],
    ])
  })
})
