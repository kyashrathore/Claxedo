import type { SandboxLifecycleEvent, SandboxStartPhaseEvent } from "@claxedo/sandbox-manager"
import type { ControlPlaneTelemetry } from "@claxedo/server-core/platform/telemetry/ports"
import { SANDBOX_KEY_LABEL, SANDBOX_ORG_LABEL, sandboxKeyOwner } from "./org-sandbox-manager"

function machineProperties(event: { workspaceId: string; driver: string; labels: Record<string, string> }) {
  const orgId = event.labels[SANDBOX_ORG_LABEL]
  return {
    workspace_id: event.workspaceId,
    driver: event.driver,
    key_owner: sandboxKeyOwner(event.labels[SANDBOX_KEY_LABEL]),
    ...(event.labels.projectId ? { project_id: event.labels.projectId } : {}),
    ...(orgId ? { org_id: orgId, $groups: { org: orgId } } : {}),
  }
}

/**
 * Each cloud start phase as an ops-plane fact, and the phase that makes a
 * machine serve as the moment its metered interval opens: `workspace_ready`
 * for a cold start, `workspace_woken` for a resume or restore. The repository
 * URL is tenant data and stays out; `key_owner` says only whose provider
 * account it was.
 */
export function sandboxStartPhaseSink(telemetry: ControlPlaneTelemetry) {
  return (event: SandboxStartPhaseEvent) => {
    const machine = machineProperties(event)
    telemetry.capture("system", "sandbox.start_phase", {
      ...machine,
      phase: event.phase,
      duration_ms: event.durationMs,
      epoch: event.epoch,
      region: event.homeRegion,
      boot_mode: event.bootMode,
      ...(event.repoSizeBytes === undefined ? {} : { repo_size_bytes: event.repoSizeBytes }),
    })
    if (event.phase !== "runtime_ready") return
    telemetry.capture("system", event.bootMode === "cold-start" ? "workspace_ready" : "workspace_woken", {
      ...machine,
      boot_mode: event.bootMode,
      start_ms: event.sinceStartMs,
      region: event.homeRegion,
    })
  }
}

/**
 * The close of a metered interval is `workspace_stopped` with the boot's
 * `active_ms`, whether the machine was stopped by hand, by idleness, or
 * destroyed while serving. Destroying a machine that was already stopped
 * closes nothing.
 */
export function sandboxLifecycleSink(telemetry: ControlPlaneTelemetry) {
  return (event: SandboxLifecycleEvent) => {
    const machine = machineProperties(event)
    if (event.kind === "failed") {
      telemetry.capture("system", "workspace_failed", { ...machine, code: event.bootFailed ? "boot_failed" : "provision_failed" })
      return
    }
    if (event.activeMs === undefined) return
    const cause = event.kind === "destroyed" ? "deleted" : event.idle ? "idle" : "explicit"
    telemetry.capture("system", "workspace_stopped", { ...machine, cause, active_ms: event.activeMs })
  }
}
