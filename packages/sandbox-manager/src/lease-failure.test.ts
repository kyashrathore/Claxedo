import { describe, expect, test } from "vitest"
import { runtimeBootDiagnostic, sandboxLeaseEndedUnderStart, sandboxRuntimeBootFailedError, sandboxRuntimeBootFailure, workspaceRuntimeBootReason } from "./lease-failure"

describe("the reason a person is told for a boot that failed", () => {
  const diagnostic = [
    "Boat bx_puyhsbd8 runtime did not become healthy: the runtime container is exited; status=exited exit=78 oom=false",
    "[claxedo-workspace-runtime] starting",
    "[claxedo-workspace-runtime] workspace_runtime_boot_failed: Error: The branch \"lane-b-no-such-branch\" does not exist in https://github.com/octocat/git-consortium",
    "    at checkOut (file:///opt/claxedo-runtime/workspace-runtime-host.mjs:74202:69)",
    "    at async prepareRuntimeRepository (file:///opt/claxedo-runtime/workspace-runtime-host.mjs:74250:12)",
  ].join("\n")

  test("is the runtime's own line from the driver's diagnostic, without the stack beneath it", () => {
    expect(workspaceRuntimeBootReason(diagnostic)).toBe("The branch \"lane-b-no-such-branch\" does not exist in https://github.com/octocat/git-consortium")
    expect(sandboxRuntimeBootFailure(sandboxRuntimeBootFailedError(diagnostic))).toBe("The branch \"lane-b-no-such-branch\" does not exist in https://github.com/octocat/git-consortium")
  })

  test("survives a driver's bound on the log: the boot-failure line is kept whole and the stack under it dropped, while a log without one keeps its tail", () => {
    const kept = runtimeBootDiagnostic(`${diagnostic}\n${"    at async run (file:///opt/claxedo-runtime/workspace-runtime-host.mjs:74300:1)\n".repeat(20)}`, 600)
    expect(kept).toBe("workspace_runtime_boot_failed: The branch \"lane-b-no-such-branch\" does not exist in https://github.com/octocat/git-consortium")
    expect(sandboxRuntimeBootFailure(sandboxRuntimeBootFailedError(kept))).toBe("The branch \"lane-b-no-such-branch\" does not exist in https://github.com/octocat/git-consortium")
    expect(runtimeBootDiagnostic(`${"x".repeat(800)}\nStartup failed: bun install failed\n`, 600)).toBe(`${"x".repeat(565)}\nStartup failed: bun install failed`)
  })

  test("is the driver's whole diagnostic when the runtime never named one", () => {
    expect(workspaceRuntimeBootReason("the runtime container is exited; container diagnostics unavailable")).toBeUndefined()
    expect(sandboxRuntimeBootFailure(sandboxRuntimeBootFailedError("the image has no runtime"))).toBe("the image has no runtime")
    expect(sandboxRuntimeBootFailure("provider hiccup")).toBeUndefined()
  })
})

test("a lease stopped, destroyed or replaced under a start step is not the start's failure", () => {
  expect(["runtime_lease_changed", "runtime_lease_stopped", "runtime_lease_destroyed"].every(sandboxLeaseEndedUnderStart)).toBe(true)
  expect(sandboxLeaseEndedUnderStart("runtime_lease_not_ready")).toBe(false)
  expect(sandboxLeaseEndedUnderStart(sandboxRuntimeBootFailedError("no runtime"))).toBe(false)
  expect(sandboxLeaseEndedUnderStart(undefined)).toBe(false)
})
