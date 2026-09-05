import { afterEach, describe, expect, test, vi } from "vitest"

const loaded = vi.fn(() => false)
const construct = vi.fn(() => { throw new Error("a credential write must not boot the SDK") })
vi.mock("./sdk-runtime", () => ({
  openCodeSdkRuntimeLoaded: () => loaded(),
  openCodeSdkRuntime: () => construct(),
}))

describe("OpenCode SDK credential bridge", () => {
  afterEach(() => {
    loaded.mockReset()
    construct.mockReset()
    loaded.mockReturnValue(false)
  })

  test("a credential write against a cold SDK host is deferred to the boot reconcile", async () => {
    const { syncCredentialsToSdk } = await import("./sdk-credential-bridge")
    await expect(syncCredentialsToSdk()).resolves.toEqual({ synced: [], removed: [] })
    expect(construct).not.toHaveBeenCalled()
  })

  test("a running SDK host receives the write", async () => {
    loaded.mockReturnValue(true)
    construct.mockImplementation(() => { throw new Error("a credential write must not boot the SDK") })
    const { syncCredentialsToSdk } = await import("./sdk-credential-bridge")
    await expect(syncCredentialsToSdk()).rejects.toThrow("a credential write must not boot the SDK")
    expect(construct).toHaveBeenCalledTimes(1)
  })
})
