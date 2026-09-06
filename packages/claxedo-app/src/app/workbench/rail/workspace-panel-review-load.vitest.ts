import { afterEach, beforeEach, expect, test, vi } from "vitest"
vi.mock("@/app/workbench/review/review-workspace", () => ({ ReviewWorkspace: () => null }))
beforeEach(() => vi.resetModules())
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

test("idle warmup defers the shared load and repeated intents join one promise", async () => {
  const callbacks: IdleRequestCallback[] = []
  vi.stubGlobal("requestIdleCallback", vi.fn((callback: IdleRequestCallback) => { callbacks.push(callback); return 7 }))
  const { ReviewWorkspace, warmWorkspacePanelReview, warmWorkspacePanelReviewWhenIdle } = await import("./workspace-panel-review-load")
  const preload = vi.spyOn(ReviewWorkspace, "preload")
  warmWorkspacePanelReviewWhenIdle()
  expect(preload).not.toHaveBeenCalled()
  expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 1_200 })
  callbacks[0]({ didTimeout: false, timeRemaining: () => 20 })
  const first = warmWorkspacePanelReview()
  expect(warmWorkspacePanelReview()).toBe(first)
  await first
  expect(preload).toHaveBeenCalledTimes(1)
})

test("disposing a boot warmup cancels its scheduled idle callback", async () => {
  vi.stubGlobal("requestIdleCallback", vi.fn(() => 11))
  const cancel = vi.fn()
  vi.stubGlobal("cancelIdleCallback", cancel)
  const { ReviewWorkspace, warmWorkspacePanelReviewWhenIdle } = await import("./workspace-panel-review-load")
  const preload = vi.spyOn(ReviewWorkspace, "preload")
  warmWorkspacePanelReviewWhenIdle()()
  expect(cancel).toHaveBeenCalledWith(11)
  expect(preload).not.toHaveBeenCalled()
})
