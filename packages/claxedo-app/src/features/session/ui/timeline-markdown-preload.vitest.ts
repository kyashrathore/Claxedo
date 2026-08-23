import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  parser: { parse: vi.fn() },
  preloadMarkdown: vi.fn(),
}))

vi.mock("@/ui/session-kit", () => ({ preloadMarkdown: mocks.preloadMarkdown }))
vi.mock("@opencode-ai/ui/context/marked", () => ({ useMarked: () => mocks.parser }))

type IdleTask = (deadline?: { timeRemaining(): number }) => void | Promise<void>

describe("timeline markdown preload", () => {
  const idleTasks: IdleTask[] = []

  beforeEach(() => {
    vi.resetModules()
    mocks.preloadMarkdown.mockReset()
    idleTasks.length = 0
    vi.stubGlobal(
      "requestIdleCallback",
      vi.fn((task: IdleTask) => {
        idleTasks.push(task)
        return idleTasks.length
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test("continues draining after a markdown preload rejects", async () => {
    mocks.preloadMarkdown.mockRejectedValueOnce(new Error("parser failed")).mockResolvedValue(undefined)
    const { installTimelineMarkdownPreload } = await import("./timeline-markdown-preload")

    installTimelineMarkdownPreload({
      conversation: () => ({
        messages: [{ id: "message-1" }],
        parts: {
          "message-1": [
            { id: "part-1", type: "text", text: "first" },
            { id: "part-2", type: "text", text: "second" },
          ],
        },
      }),
    })

    await idleTasks.shift()?.({ timeRemaining: () => 10 })
    expect(mocks.preloadMarkdown.mock.calls.map((call) => call[1])).toEqual(["part-2", "part-1"])

    await idleTasks.shift()?.({ timeRemaining: () => 10 })
    installTimelineMarkdownPreload({
      conversation: () => ({
        messages: [{ id: "message-2" }],
        parts: { "message-2": [{ id: "part-3", type: "text", text: "third" }] },
      }),
    })
    await idleTasks.shift()?.({ timeRemaining: () => 10 })

    expect(mocks.preloadMarkdown.mock.calls.map((call) => call[1])).toEqual(["part-2", "part-1", "part-3"])
  })
})
