import { describe, expect, test, vi } from "vitest"
import { runWorkspaceRuntimeHost, WORKSPACE_RUNTIME_BOOT_FAILED } from "./host-run"

describe("workspace-runtime host entry", () => {
  test("a boot failure is named on stderr and exits non-zero", async () => {
    // A rejected top-level await kills the entry silently, so the driver only
    // ever sees its readiness probe time out.
    const io = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(() => undefined as never),
    }

    await runWorkspaceRuntimeHost(async () => {
      throw new Error("WORKSPACE_RUNTIME_PORT must be an integer: nope")
    }, io)

    expect(io.exit).toHaveBeenCalledWith(78)
    expect(io.error.mock.calls[0][0]).toContain(WORKSPACE_RUNTIME_BOOT_FAILED)
    expect(io.error.mock.calls[0][0]).toContain("WORKSPACE_RUNTIME_PORT must be an integer")
    expect(io.log).not.toHaveBeenCalled()
  })
})
