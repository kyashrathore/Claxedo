import { describe, expect, test } from "vitest"
import type { SandboxLifecycleEvent, SandboxStartPhaseEvent } from "@claxedo/sandbox-manager"
import { sandboxLifecycleSink, sandboxStartPhaseSink } from "./sandbox-telemetry"

function sink() {
  const captured: Array<{ distinctId: string; event: string; properties?: Record<string, unknown> }> = []
  return { captured, telemetry: { capture: (distinctId: string, event: string, properties?: Record<string, unknown>) => void captured.push({ distinctId, event, properties }) } }
}

const machine = { workspaceId: "ws_1", epoch: 2, driver: "boat", labels: { projectId: "prj_1", sandboxOrg: "org_1" } }

function phase(input: Partial<SandboxStartPhaseEvent>): SandboxStartPhaseEvent {
  return { ...machine, phase: "runtime_ready", durationMs: 1_500, sinceStartMs: 45_000, homeRegion: "us-east", bootMode: "cold-start", ...input }
}

describe("workspace start events", () => {
  test("the serving phase of a cold start is workspace_ready with the start's own duration, under the org", () => {
    const { captured, telemetry } = sink()
    sandboxStartPhaseSink(telemetry)(phase({}))
    expect(captured.map((entry) => entry.event)).toEqual(["sandbox.start_phase", "workspace_ready"])
    expect(captured[1]).toEqual({
      distinctId: "system",
      event: "workspace_ready",
      properties: { workspace_id: "ws_1", driver: "boat", project_id: "prj_1", org_id: "org_1", $groups: { org: "org_1" }, boot_mode: "cold-start", start_ms: 45_000, region: "us-east" },
    })
  })

  test("the serving phase of a resume is workspace_woken, and every other phase is an ops event only", () => {
    const { captured, telemetry } = sink()
    const emit = sandboxStartPhaseSink(telemetry)
    emit(phase({ phase: "image_ready", bootMode: "resume" }))
    emit(phase({ bootMode: "resume" }))
    expect(captured.map((entry) => entry.event)).toEqual(["sandbox.start_phase", "sandbox.start_phase", "workspace_woken"])
  })
})

describe("workspace lifecycle events", () => {
  const failed = (retrying: boolean, bootFailed = false): SandboxLifecycleEvent => ({ ...machine, kind: "failed", bootFailed, retrying })

  test("an epoch that failed while its start goes on sends nothing; the start's final failure is workspace_failed", () => {
    const { captured, telemetry } = sink()
    const emit = sandboxLifecycleSink(telemetry)
    emit(failed(true))
    expect(captured).toEqual([])
    emit(failed(false))
    emit(failed(false, true))
    expect(captured.map((entry) => [entry.event, entry.properties?.code])).toEqual([["workspace_failed", "provision_failed"], ["workspace_failed", "boot_failed"]])
  })

  test("a stop closes the metered interval with the boot's machine time", () => {
    const { captured, telemetry } = sink()
    const emit = sandboxLifecycleSink(telemetry)
    emit({ ...machine, kind: "stopped", idle: true, activeMs: 282_921 })
    emit({ ...machine, kind: "destroyed" })
    expect(captured).toEqual([{
      distinctId: "system",
      event: "workspace_stopped",
      properties: { workspace_id: "ws_1", driver: "boat", project_id: "prj_1", org_id: "org_1", $groups: { org: "org_1" }, cause: "idle", active_ms: 282_921 },
    }])
  })
})
