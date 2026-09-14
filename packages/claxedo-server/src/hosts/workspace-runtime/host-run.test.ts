import { describe, expect, test, vi } from "vitest"

const startServer = vi.fn(() => ({ server: "listening" }))
const waitForWorkspaceRuntimeServerPort = vi.fn(async () => 2593)

// The listener itself belongs to @claxedo/workspace-runtime and is proven
// there; what is under test is the entry around it — which line is written, in
// which order, and what a boot that never reaches the listener does instead.
vi.mock("@claxedo/workspace-runtime", () => ({ startServer, waitForWorkspaceRuntimeServerPort }))

const { runWorkspaceRuntimeHost } = await import("./host-run")

function io() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn(() => undefined as never) }
}

describe("workspace-runtime host entry", () => {
  test("a boot failure is named on stderr and exits non-zero", async () => {
    // A rejected top-level await kills the entry silently, so the driver only
    // ever sees its readiness probe time out.
    const out = io()

    await runWorkspaceRuntimeHost(async () => {
      throw new Error("WORKSPACE_RUNTIME_PORT must be an integer: nope")
    }, out)

    expect(out.exit).toHaveBeenCalledWith(78)
    // The literal, not the constant: a log search is what reads this line, and
    // a test that spells it the same way the source does agrees with any value.
    expect(out.error.mock.calls[0][0]).toContain("workspace_runtime_boot_failed")
    expect(out.error.mock.calls[0][0]).toContain("WORKSPACE_RUNTIME_PORT must be an integer")
    expect(out.log).not.toHaveBeenCalled()
    expect(startServer).not.toHaveBeenCalled()
  })

  test("a booted host starts the listener and names the port it actually bound", async () => {
    const out = io()
    const options = { target: { workspaceId: "ws_1", directory: "/workspace" } }
    waitForWorkspaceRuntimeServerPort.mockResolvedValueOnce(43_117)

    await runWorkspaceRuntimeHost(async () => ({ port: 0, hostname: "0.0.0.0", options } as never), out)

    expect(startServer).toHaveBeenCalledWith(0, options, { signals: true })
    expect(out.log).toHaveBeenCalledWith(
      "[claxedo-workspace-runtime] listening on http://0.0.0.0:43117 workspaceId=ws_1 directory=/workspace",
    )
    expect(out.error).not.toHaveBeenCalled()
    expect(out.exit).not.toHaveBeenCalled()
  })
})
