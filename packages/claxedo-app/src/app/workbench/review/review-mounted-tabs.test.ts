import { describe, expect, test } from "bun:test"

import { createReviewTabActivationTransition, reviewWorkspaceMountedTabs } from "./review-mounted-tabs"

const tabs = [
  { id: "review", kind: "review" },
  { id: "file:a", kind: "file" },
  { id: "file:b", kind: "file" },
  { id: "context", kind: "context" },
]

function mounted(activeTabId: string, pendingTabId?: string) {
  return reviewWorkspaceMountedTabs({ tabs, activeTabId, reviewTabId: "review", pendingTabId })
    .map((tab) => tab.id)
}

describe("review workspace mounted tabs", () => {
  test("mounts only the active tab", () => {
    expect(mounted("file:a")).toEqual(["file:a"])
    expect(mounted("context")).toEqual(["context"])
  })

  test("mounts nothing beside Review while Review is active", () => {
    expect(mounted("review")).toEqual([])
  })

  test("mounts a prepared tab alongside the active one until its activation commits", () => {
    // The frame between inserting a tab and activating it.
    expect(mounted("review", "file:b")).toEqual(["file:b"])
    expect(mounted("file:a", "file:b")).toEqual(["file:a", "file:b"])
    // Committed: the previous tab is gone the moment the new one is active.
    expect(mounted("file:b")).toEqual(["file:b"])
  })

  test("ignores a pending or active id the tab list no longer has", () => {
    expect(mounted("file:gone", "file:also-gone")).toEqual([])
  })
})

describe("review tab activation transition", () => {
  function withFakeFrames(run: (flush: () => void) => void) {
    const frames = new Map<number, FrameRequestCallback>()
    let nextId = 1
    const originalRequest = globalThis.requestAnimationFrame
    const originalCancel = globalThis.cancelAnimationFrame
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      const id = nextId++
      frames.set(id, callback)
      return id
    }) as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = ((id: number) => {
      frames.delete(id)
    }) as typeof cancelAnimationFrame
    try {
      run(() => {
        const pending = [...frames.values()]
        frames.clear()
        for (const callback of pending) callback(0)
      })
    } finally {
      globalThis.requestAnimationFrame = originalRequest
      globalThis.cancelAnimationFrame = originalCancel
    }
  }

  function harness() {
    const commits: string[] = []
    const pendingIds: (string | undefined)[] = []
    const transition = createReviewTabActivationTransition({
      commit: (activation: { id: string }) => commits.push(activation.id),
      setPendingTabId: (id) => pendingIds.push(id),
    })
    return { commits, pendingIds, transition }
  }

  test("commits a deferred activation on the next frame, mounting it while pending", () => {
    withFakeFrames((flush) => {
      const { commits, pendingIds, transition } = harness()
      transition.commit({ id: "file:new" }, true)
      expect(commits).toEqual([])
      expect(pendingIds.at(-1)).toBe("file:new")
      flush()
      expect(commits).toEqual(["file:new"])
      expect(pendingIds.at(-1)).toBeUndefined()
    })
  })

  test("a later direct click wins over a pending deferred activation", () => {
    withFakeFrames((flush) => {
      const { commits, pendingIds, transition } = harness()
      // A tab insertion defers its activation by one frame…
      transition.commit({ id: "file:new" }, true)
      // …and the user clicks another tab before that frame runs.
      transition.commit({ id: "review" })
      expect(commits).toEqual(["review"])
      // The superseded frame must never fire: the click is the last word.
      flush()
      expect(commits).toEqual(["review"])
      expect(pendingIds.at(-1)).toBeUndefined()
    })
  })

  test("a newer deferred activation supersedes an older pending one", () => {
    withFakeFrames((flush) => {
      const { commits, transition } = harness()
      transition.commit({ id: "file:a" }, true)
      transition.commit({ id: "file:b" }, true)
      flush()
      expect(commits).toEqual(["file:b"])
    })
  })

  test("cancel drops a pending deferred activation and its mount", () => {
    withFakeFrames((flush) => {
      const { commits, pendingIds, transition } = harness()
      transition.commit({ id: "file:a" }, true)
      transition.cancel()
      flush()
      expect(commits).toEqual([])
      expect(pendingIds.at(-1)).toBeUndefined()
    })
  })

  test("commits immediately when frames are unavailable", () => {
    const originalRequest = globalThis.requestAnimationFrame
    // @ts-expect-error simulating an environment without requestAnimationFrame
    globalThis.requestAnimationFrame = undefined
    try {
      const { commits, transition } = harness()
      transition.commit({ id: "file:a" }, true)
      expect(commits).toEqual(["file:a"])
    } finally {
      globalThis.requestAnimationFrame = originalRequest
    }
  })
})
