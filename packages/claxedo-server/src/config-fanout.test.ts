import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = {
  broadcastRuntimeConfig: vi.fn(async () => {}),
  syncEmbeddedWorkspaceRuntimes: vi.fn(async () => {}),
  syncOpencodeMcpConfig: vi.fn(async () => {}),
  log: {
    warn: vi.fn(),
  },
}

vi.mock("./workspace/supervisor/supervisor", () => ({
  broadcastRuntimeConfig: mocks.broadcastRuntimeConfig,
}))

vi.mock("./deployments/local/embedded-workspace-runtime", () => ({
  syncEmbeddedWorkspaceRuntimes: mocks.syncEmbeddedWorkspaceRuntimes,
}))

vi.mock("./opencode/mcp-sync", () => ({
  syncOpencodeMcpConfig: mocks.syncOpencodeMcpConfig,
}))

vi.mock("./lib/log", () => ({
  Log: {
    create: () => mocks.log,
  },
}))

const { fanOutConfig } = await import("./config-fanout")

beforeEach(() => {
  vi.clearAllMocks()
  mocks.broadcastRuntimeConfig.mockResolvedValue(undefined)
  mocks.syncEmbeddedWorkspaceRuntimes.mockResolvedValue(undefined)
  mocks.syncOpencodeMcpConfig.mockResolvedValue(undefined)
})

describe("fanOutConfig", () => {
  test("warns for a rejected target while the other runtime targets still run", async () => {
    mocks.syncEmbeddedWorkspaceRuntimes.mockRejectedValue(
      new Error("runtime rejected config containing sk-secret"),
    )

    await expect(fanOutConfig()).resolves.toBeUndefined()

    expect(mocks.broadcastRuntimeConfig).toHaveBeenCalledOnce()
    expect(mocks.syncEmbeddedWorkspaceRuntimes).toHaveBeenCalledOnce()
    expect(mocks.syncOpencodeMcpConfig).toHaveBeenCalledOnce()
    expect(mocks.log.warn).toHaveBeenCalledOnce()
    expect(mocks.log.warn).toHaveBeenCalledWith("config fan-out target failed", {
      target: "deployments/local/embedded-workspace-runtime",
    })
    expect(JSON.stringify(mocks.log.warn.mock.calls)).not.toContain("sk-secret")
  })
})
