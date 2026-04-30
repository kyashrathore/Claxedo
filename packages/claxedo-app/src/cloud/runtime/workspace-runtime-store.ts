import type { CloudLog } from "../../overrides/components/session/cloud-startup-view"
import type { ClaxedoEvent, useClaxedoEventsOptional } from "../../providers/claxedo-events"
import { queryClient } from "../../shared/query/query-client"
import { type WorkspaceRuntimeSnapshot, workspaceResolveQuery } from "../../shared/query/runtime"
import { createHttpWorkspaceRuntimeBackend } from "../../shared/data/http-backend"

type EventsApi = ReturnType<typeof useClaxedoEventsOptional>
type ProvisionEvent = Extract<ClaxedoEvent, { type: "provision" }>

export type WorkspaceRuntimePhase = "unknown" | "resolving" | "stopped" | "ensuring" | "ready" | "failed"

function normalized(url: string | undefined) {
  const trimmed = url?.trim()
  if (!trimmed) return
  return trimmed.replace(/\/+$/, "")
}

function errorText(error: unknown) {
  if (typeof error === "string") return error
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message
  }
  return "Request failed"
}

export function workspaceRuntimePhase(input?: WorkspaceRuntimeSnapshot | null): WorkspaceRuntimePhase {
  if (!input) return "unknown"
  if (input.kind !== "cloud") return "ready"
  if (input.status === "ready") return "ready"
  if (input.status === "failed") return "failed"
  if (input.status) return "stopped"
  return "unknown"
}

export function workspaceRuntimeBlocksBootstrap(input?: WorkspaceRuntimeSnapshot | null) {
  return input?.kind === "cloud" && !!input.status && input.status !== "ready" && input.status !== "failed"
}

export function appendWorkspaceRuntimeLog(
  logs: CloudLog[],
  step: string,
  message?: string,
  totalMs?: number,
  now = Date.now(),
) {
  const prev = logs.at(-1)
  if (prev?.step === step && prev?.message === message) return logs
  return [...logs, { step, message, ts: now, totalMs }]
}

export async function resolveWorkspaceRuntime(input: {
  baseUrl?: string
  request?: typeof fetch
  directory?: string
  workspaceId?: string
  create?: boolean
}) {
  return await queryClient.fetchQuery(workspaceResolveQuery(input))
}

async function ensureWorkspaceRuntime(input: {
  baseUrl?: string
  request?: typeof fetch
  workspaceId?: string
  directory?: string
}) {
  const backend = createHttpWorkspaceRuntimeBackend({
    baseUrl: input.baseUrl,
    request: input.request,
  })
  return await backend.ensureWorkspace({
    workspaceId: input.workspaceId,
    directory: input.directory,
  })
}

export async function prepareWorkspaceRuntime(input: {
  directory: string
  baseUrl?: string
  request?: typeof fetch
  events?: EventsApi
  cancelled?: () => boolean
  onResolved?: (workspace: WorkspaceRuntimeSnapshot | null) => void
  onStatus?: (status: string) => void
  onLog?: (next: CloudLog) => void
}) {
  const workspace = await resolveWorkspaceRuntime({
    baseUrl: input.baseUrl,
    request: input.request,
    directory: input.directory,
  })
  if (input.cancelled?.()) return { ok: false, cancelled: true, workspace }
  input.onResolved?.(workspace)
  if (!workspaceRuntimeBlocksBootstrap(workspace)) {
    return { ok: true, startup: false, workspace }
  }
  const pendingWorkspace = workspace as WorkspaceRuntimeSnapshot & { kind: "cloud"; status: string }

  if (pendingWorkspace.status) {
    input.onStatus?.(pendingWorkspace.status ?? "pending_sandbox")
    input.onLog?.({
      step: pendingWorkspace.status,
      message: pendingWorkspace.status === "stopped" ? "Waking workspace runtime..." : undefined,
      ts: Date.now(),
    })
  }

  const off = input.events?.on("provision", (event: ProvisionEvent) => {
    if (event.workspaceId !== pendingWorkspace.workspaceId) return
    input.onStatus?.(event.step)
    input.onLog?.({
      step: event.step,
      message: event.message,
      ts: event.ts,
      totalMs: event.totalMs,
    })
  })

  try {
    await ensureWorkspaceRuntime({
      baseUrl: input.baseUrl,
      request: input.request,
      workspaceId: pendingWorkspace.workspaceId,
      directory: input.directory,
    })
    if (input.cancelled?.()) return { ok: false, cancelled: true, workspace }
    input.onStatus?.("ready")
    input.onLog?.({
      step: "ready",
      ts: Date.now(),
    })
    return { ok: true, startup: true, workspace }
  } catch (error) {
    if (input.cancelled?.()) return { ok: false, cancelled: true, workspace }
    input.onStatus?.("error")
    input.onLog?.({
      step: "error",
      message: errorText(error),
      ts: Date.now(),
    })
    return {
      ok: false,
      startup: true,
      workspace,
      error,
      message: errorText(error),
    }
  } finally {
    off?.()
  }
}
