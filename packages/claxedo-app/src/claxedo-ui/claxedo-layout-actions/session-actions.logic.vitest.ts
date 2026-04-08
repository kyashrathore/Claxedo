import { describe, expect, test, vi } from "vitest"
import { archiveSession } from "./session-actions.logic"

describe("archiveSession", () => {
  test("archives sidebar sessions even when the child store has not loaded them", async () => {
    const update = vi.fn().mockResolvedValue({})
    const setStore = vi.fn()
    const drop = vi.fn()
    const closeTab = vi.fn()
    const toast = vi.fn()
    const track = vi.fn()

    await archiveSession({
      item: {
        id: "ses_1",
        directory: "/ws/main",
        title: "Stale sidebar row",
      },
      update,
      setStore,
      drop,
      findTab: vi.fn(() => ({ id: "tab_1" })),
      closeTab,
      toast,
      track,
    })

    expect(track).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({
      directory: "/ws/main",
      sessionID: "ses_1",
      time: { archived: expect.any(Number) },
    })
    expect(setStore).toHaveBeenCalledTimes(1)
    expect(drop).toHaveBeenCalledWith({
      id: "ses_1",
      directory: "/ws/main",
      projectID: undefined,
      tags: undefined,
    })
    expect(closeTab).toHaveBeenCalledWith("tab_1")
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Session archived",
      variant: "success",
    }))
  })
})
