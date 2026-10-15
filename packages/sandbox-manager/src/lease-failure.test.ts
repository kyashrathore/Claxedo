import { describe, expect, test } from "vitest"
import {
  runtimeBootDiagnostic,
  sandboxLeaseEndedUnderStart,
  sandboxLeaseFailure,
  sandboxProviderFailedError,
  sandboxProviderKeyRefusedError,
  sandboxProviderRateLimit,
  sandboxProviderRateLimitedError,
  sandboxRuntimeBootFailedError,
  sandboxRuntimeBootFailure,
  sandboxStartFailureReason,
  workspaceRuntimeBootReason,
} from "./lease-failure"
import type { SandboxLease } from "./contract"

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

  test("a start step's error is told as the boot's reason, or in one line naming the provider without the driver's message", () => {
    expect(sandboxStartFailureReason(sandboxRuntimeBootFailedError(diagnostic))).toBe("The branch \"lane-b-no-such-branch\" does not exist in https://github.com/octocat/git-consortium")
    expect(sandboxStartFailureReason(sandboxProviderFailedError("boat", "Boat bx_1 runtime image preparation failed (exit 1): mkdir: cannot create directory\n    at run (boat.ts:1:1)")))
      .toBe("Boat returned an error.")
    expect(sandboxStartFailureReason(sandboxProviderKeyRefusedError("boat", "Boat POST /sandboxes was rejected (unauthorized)")))
      .toBe("Boat refused the sandbox provider key; fix it in Settings → Sandbox providers.")
    expect(sandboxStartFailureReason("runtime_unhealthy")).toBe("The workspace machine stopped answering.")
    expect(sandboxStartFailureReason("runtime_retry_cap_exceeded")).toBe("Several tries in a row failed; try again later.")
    expect(sandboxStartFailureReason("provider hiccup")).toBe("provider hiccup")
  })

  test("a provider's used-up start limit is one line: a day's says to try again later, and a minute's or an hour's, which Claxedo waits out, only which limit", () => {
    expect(sandboxStartFailureReason(sandboxProviderRateLimitedError("boat", { window: "day", limit: 200 }))).toBe("Boat's daily start limit (200) is used up; try again later.")
    expect(sandboxStartFailureReason(sandboxProviderRateLimitedError("boat", { window: "hour", limit: 60 }))).toBe("Boat's hourly start limit (60) is used up.")
    expect(sandboxStartFailureReason(sandboxProviderRateLimitedError("boat", { window: "minute", limit: 10 }))).toBe("Boat's per-minute start limit (10) is used up.")
    expect(sandboxProviderRateLimit(sandboxProviderRateLimitedError("boat", { window: "hour", limit: 60 }))).toBe("hour")
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

test("a lease that failed at the provider is told in one line naming the provider, and one whose boot failed by the runtime's reason", () => {
  const failed = (lastError: string): SandboxLease => ({
    workspaceId: "ws_1", homeRegion: "us-east", driver: "boat", epoch: 2, status: "unavailable", retryCount: 1, nextRetryAt: 2_000, updatedAt: 0, createdAt: 0, lastError,
  })
  expect(sandboxLeaseFailure(failed(sandboxProviderFailedError("boat", "Boat bx_1 runtime image preparation failed (exit 1): no space left on device\n    at run (boat.ts:1:1)")), { now: 1_000, maxRetryCount: 5 }))
    .toEqual({ kind: "provider", message: "Boat returned an error.", retrying: true })
  expect(sandboxLeaseFailure({ ...failed("runtime_unhealthy"), nextRetryAt: undefined }, { now: 1_000, maxRetryCount: 5 }))
    .toEqual({ kind: "unhealthy", message: "The workspace machine stopped answering.", retrying: false })
  expect(sandboxLeaseFailure(failed(sandboxRuntimeBootFailedError("workspace_runtime_boot_failed: Error: The branch \"x\" does not exist in https://github.com/o/r\n    at checkOut (a.mjs:1:1)")), { now: 1_000, maxRetryCount: 5 }))
    .toEqual({ kind: "boot", message: "The branch \"x\" does not exist in https://github.com/o/r", retrying: false })
})
