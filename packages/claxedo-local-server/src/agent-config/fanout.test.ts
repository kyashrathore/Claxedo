import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = {
  syncEmbeddedWorkspaceRuntimes: vi.fn(async () => {}),
  log: {
    warn: vi.fn(),
  },
}

vi.mock("../deployments/local/embedded-workspace-runtime", () => ({
  syncEmbeddedWorkspaceRuntimes: mocks.syncEmbeddedWorkspaceRuntimes,
}))

vi.mock("@claxedo/server-core/platform/runtime/lib/log", () => ({
  Log: {
    create: () => mocks.log,
  },
}))

const { fanOutConfig } = await import("./fanout")

beforeEach(() => {
  vi.clearAllMocks()
  mocks.syncEmbeddedWorkspaceRuntimes.mockResolvedValue(undefined)
})

describe("fanOutConfig", () => {
  test("a rejected runtime fails the fan-out and is logged without the config it quoted", async () => {
    mocks.syncEmbeddedWorkspaceRuntimes.mockRejectedValue(
      new Error("runtime rejected config containing sk-secret"),
    )

    await expect(fanOutConfig()).rejects.toThrow("config fan-out failed")

    expect(mocks.syncEmbeddedWorkspaceRuntimes).toHaveBeenCalledOnce()
    expect(mocks.log.warn).toHaveBeenCalledOnce()
    expect(mocks.log.warn).toHaveBeenCalledWith("config fan-out target failed", {
      target: "deployments/local/embedded-workspace-runtime",
    })
    expect(JSON.stringify(mocks.log.warn.mock.calls)).not.toContain("sk-secret")
  })
})
