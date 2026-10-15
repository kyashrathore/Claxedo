import { describe, expect, test } from "vitest"
import { vi } from "vitest"
import type { SandboxLifecycleEvent, SandboxStartPhaseEvent } from "@claxedo/sandbox-manager"
import { sandboxEgressUnenforcedSink, sandboxLifecycleSink, sandboxStartPhaseSink } from "./sandbox-telemetry"

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
  test("a stop says why the machine ended: a host the provider lost is host_gone, a destroyed workspace machine is deleted", () => {
    const { captured, telemetry } = sink()
    const emit = sandboxLifecycleSink(telemetry)
    emit({ ...machine, kind: "destroyed", hostGone: true, activeMs: 7_000 })
    emit({ ...machine, kind: "destroyed", hostGone: false, activeMs: 5_700 })
    expect(captured.map((entry) => [entry.event, entry.properties?.cause, entry.properties?.active_ms])).toEqual([
      ["workspace_stopped", "host_gone", 7_000],
      ["workspace_stopped", "deleted", 5_700],
    ])
  })

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
    emit({ ...machine, kind: "stopped", cause: "idle", activeMs: 282_921 })
    emit({ ...machine, kind: "stopped", cause: "provider", activeMs: 61_000 })
    emit({ ...machine, kind: "destroyed", hostGone: false })
    const properties = { workspace_id: "ws_1", driver: "boat", project_id: "prj_1", org_id: "org_1", $groups: { org: "org_1" } }
    expect(captured).toEqual([
      { distinctId: "system", event: "workspace_stopped", properties: { ...properties, cause: "idle", active_ms: 282_921 } },
      { distinctId: "system", event: "workspace_stopped", properties: { ...properties, cause: "host_stopped", active_ms: 61_000 } },
    ])
  })
})

describe("sandbox egress events", () => {
  test("a start whose allowlist the driver withheld names its workspace and org as every workspace event does; the composition warning is the deployment's", () => {
    const { captured, telemetry } = sink()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const emit = sandboxEgressUnenforcedSink(telemetry)
    const base = { reason: "sandbox_egress_uncontained", driver: "boat", egressControl: "none", message: "egress is unrestricted" } as const
    emit({ ...base, phase: "composition" })
    emit({ ...base, phase: "ensure", workspaceId: "ws_1", labels: machine.labels, requested: { mode: "restricted", hosts: ["api.github.com"] } })
    warn.mockRestore()
    expect(captured).toEqual([
      { distinctId: "system", event: "sandbox.egress_unenforced", properties: { phase: "composition", reason: "sandbox_egress_uncontained", driver: "boat", egress_control: "none" } },
      {
        distinctId: "system",
        event: "sandbox.egress_unenforced",
        properties: {
          phase: "ensure", reason: "sandbox_egress_uncontained", driver: "boat", egress_control: "none",
          workspace_id: "ws_1", org_id: "org_1", $groups: { org: "org_1" }, withheld_host_count: 1, withheld_cidr_count: 0,
        },
      },
    ])
  })
})
