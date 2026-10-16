import type { SandboxEgressUnenforcedEvent, SandboxLifecycleEvent, SandboxStartPhaseEvent, SandboxStopCause } from "@claxedo/sandbox-manager"
import type { ControlPlaneTelemetry } from "@claxedo/server-core/platform/telemetry/ports"
import { SANDBOX_ORG_LABEL } from "./org-sandbox-manager"

/** How every event about a workspace machine names it: the workspace and, from the placement's labels, its org. */
export function sandboxWorkspaceKeys(workspaceId: string, labels: Record<string, string> | undefined) {
  const orgId = labels?.[SANDBOX_ORG_LABEL]
  return { workspace_id: workspaceId, ...(orgId ? { org_id: orgId, $groups: { org: orgId } } : {}) }
}

function machineProperties(event: { workspaceId: string; driver: string; labels: Record<string, string> }) {
  return {
    ...sandboxWorkspaceKeys(event.workspaceId, event.labels),
    driver: event.driver,
    ...(event.labels.projectId ? { project_id: event.labels.projectId } : {}),
  }
}

/**
 * Each cloud start phase as an ops-plane fact, and the phase that makes a
 * machine serve as the moment its metered interval opens: `workspace_ready`
 * for a cold start, `workspace_woken` for a resume or restore. `start_ms` and
 * the boot mode are the start the person asked for, across every epoch it
 * took. The repository URL and the key id are tenant data and stay out.
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

const STOP_CAUSES: Record<SandboxStopCause, string> = { explicit: "explicit", idle: "idle", provider: "host_stopped" }

/**
 * The close of a metered interval is `workspace_stopped` with the boot's
 * `active_ms`, whether the machine was stopped by hand, by idleness,
 * destroyed while serving, or stopped or lost by its provider, `unsaved` when
 * it ended without a capture. Destroying a machine that was already stopped
 * closes nothing. An epoch that failed while its start goes on in the next
 * one is not a failure the person saw; `workspace_failed` is the start's end.
 * A person's Start fresh is `workspace_started_fresh`, with the cause of the
 * unusable checkpoint it dropped when the last start was refused for one.
 */
export function sandboxLifecycleSink(telemetry: ControlPlaneTelemetry) {
  return (event: SandboxLifecycleEvent) => {
    const machine = machineProperties(event)
    if (event.kind === "startedFresh") {
      telemetry.capture("system", "workspace_started_fresh", { ...machine, ...(event.checkpointUnusable ? { cause: event.checkpointUnusable } : {}) })
      return
    }
    if (event.kind === "failed") {
      if (event.retrying) return
      const code = event.checkpointUnusable ? "checkpoint_unusable" : event.bootFailed ? "boot_failed" : event.startLimit ? "provider_rate_limited" : "provision_failed"
      telemetry.capture("system", "workspace_failed", {
        ...machine,
        code,
        ...(event.checkpointUnusable ? { cause: event.checkpointUnusable } : {}),
        ...(event.startLimit ? { window: event.startLimit } : {}),
        ...(event.hostLeftRunning ? { host_left_running: true } : {}),
      })
      return
    }
    if (event.activeMs === undefined) return
    const cause = event.kind === "destroyed" ? (event.hostGone ? "host_gone" : "deleted") : STOP_CAUSES[event.cause]
    const unsaved = event.kind === "stopped" && event.unsaved ? { unsaved: true } : {}
    telemetry.capture("system", "workspace_stopped", { ...machine, cause, active_ms: event.activeMs, ...unsaved })
  }
}

/**
 * The manager's warning that its driver runs sandboxes with unrestricted
 * egress, as an ops fact as well as the console line
 * `public-docs/sandbox-egress.md` tells operators to look for at boot; a sink
 * replaces the manager's own console default. The composition half is the
 * deployment's and names no workspace; the start half names the workspace
 * whose allowlist was withheld, and only the allowlist's counts, since the
 * allowlist itself is deployment topology.
 */
export function sandboxEgressUnenforcedSink(telemetry: ControlPlaneTelemetry) {
  return (event: SandboxEgressUnenforcedEvent) => {
    console.warn(event.message)
    telemetry.capture("system", "sandbox.egress_unenforced", {
      phase: event.phase,
      reason: event.reason,
      driver: event.driver,
      egress_control: event.egressControl,
      ...(event.workspaceId ? sandboxWorkspaceKeys(event.workspaceId, event.labels) : {}),
      ...(event.requested
        ? { withheld_host_count: event.requested.hosts?.length ?? 0, withheld_cidr_count: event.requested.cidrs?.length ?? 0 }
        : {}),
    })
  }
}
