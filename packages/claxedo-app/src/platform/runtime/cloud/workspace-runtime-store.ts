import { queryClient } from "@/platform/query/query-client"
import { createHttpWorkspaceRuntimeBackend } from "@/platform/runtime/http-backend"
import { pendingCloudRuntime, resolveWorkspaceRuntime, runtimeScope } from "@/platform/runtime/workspace-runtime-record"
import { centralTransportForServer, createTransport } from "@/platform/runtime/transport"
import { authFetch } from "@/platform/api/api"
import { bypassFetchThrottle } from "@/lib/fetch-throttle"
import type {
  PrepareUserHostedRuntimeInput,
  PrepareWorkspaceRuntimeInput,
  PrepareWorkspaceRuntimeResult,
  PrepareWorkspaceSessionWorktreeInput,
  UserHostedRuntimeResult,
  WorkspaceSessionWorktree,
  WorkspaceStartupPort,
} from "@/platform/runtime/workspace-startup-port"

/**
 * The hosted implementation of `WorkspaceStartupPort`.
 *
 * Everything here needs the account-bearing transport and the Relay: waking a
 * central sandbox, connecting to a user-hosted machine, admitting a worktree on
 * a remote host. Local code never imports this module — it names the operation
 * through `platform/runtime/workspace-startup.ts`, and `app/entry/main.tsx`
 * binds this implementation for the hosted build. That indirection is what lets
 * the whole `platform/runtime/cloud` root move to `@claxedo/cloud-app`.
 *
 * Reading the runtime RECORD used to live here too and does not any more; see
 * `platform/runtime/workspace-runtime-record.ts` for why.
 */

const ENSURE_RUNTIME_FRESH_MS = 30_000

function normalizedBaseUrl(url: string | undefined) {
  const trimmed = url?.trim()
  if (!trimmed) return "default"
  return trimmed.replace(/\/+$/, "")
}

export function workspaceRuntimeEnsureQueryKey(input: { baseUrl?: string; workspaceId?: string; directory?: string }) {
  const scope = runtimeScope(input)
  return [
    "shell",
    "workspace-runtime-ensure",
    normalizedBaseUrl(input.baseUrl),
    scope.workspaceId ?? "",
    scope.directory ?? "",
  ] as const
}

function errorText(error: unknown) {
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error) {
    const message = error.message
    if (typeof message === "string") return message
  }
  return "Request failed"
}

async function ensureWorkspaceRuntime(input: {
  baseUrl?: string
  request?: typeof fetch
  workspaceId?: string
  directory?: string
}) {
  return await queryClient.fetchQuery({
    queryKey: workspaceRuntimeEnsureQueryKey(input),
    queryFn: async () =>
      await createHttpWorkspaceRuntimeBackend({
        baseUrl: input.baseUrl,
        request: input.request,
      }).ensureWorkspace(runtimeScope(input)),
    staleTime: ENSURE_RUNTIME_FRESH_MS,
  })
}

export function resetWorkspaceRuntimeEnsureCache() {
  queryClient.removeQueries({ queryKey: ["shell", "workspace-runtime-ensure"] })
  queryClient.removeQueries({ queryKey: ["shell", "workspace-connection"] })
}

function isHostOfflineBody(text: string) {
  if (!text) return false
  if (text.includes("user_hosted_app_offline")) return true
  try {
    const body = JSON.parse(text) as { error?: { code?: string } | string; code?: string }
    const code = typeof body.error === "object" ? body.error?.code : (body.code ?? (typeof body.error === "string" ? body.error : undefined))
    return code === "user_hosted_app_offline"
  } catch {
    return false
  }
}

/**
 * Drive the user-hosted connecting sequence. Resolves the workspace's relay
 * connection (mint) and probes the runtime health endpoint THROUGH the relay,
 * surfacing each phase via `onLog`/`onStatus`. When the host is offline the
 * relay answers `503 user_hosted_app_offline` (or the connection mint fails) —
 * we report `offline: true` so the caller can render the dedicated offline
 * error state instead of a generic failure.
 */
// The Durable Object relay holds host presence in memory, so right after a room
// is (re)instantiated there is a short window — until the host's next ping
// re-registers presence — where target resolution answers 409
// (relay_resolver_workspace_target_unavailable) or 503 (user_hosted_app_offline)
// for a host that is in fact connected. We therefore retry the health probe for
// a bounded window before declaring the host offline, so a transient
// presence-registration gap does not strand a healthy workspace.
//
// The budget must comfortably exceed the host tunnel ping interval (15s in the
// production tunnel) so a DO eviction — which drops in-memory presence until the
// host's next ping — does not surface a false "host offline". 20 × 1.5s = 30s.
const USER_HOSTED_HEALTH_MAX_ATTEMPTS = 15
const USER_HOSTED_HEALTH_RETRY_MS = 1_500
// A single relay health probe must not hang the whole gate. If the relay
// connection (mint → relay fetch) stalls, abort the attempt and retry, so a
// stuck probe surfaces as a retryable transient rather than freezing forever.
// Fast-failing probes (relay says 409/503 during the presence gap) retry every
// ~1.5s, giving ~22s of coverage over the host's 15s ping interval.
const USER_HOSTED_HEALTH_TIMEOUT_MS = 6_000

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export async function prepareUserHostedRuntime(
  input: PrepareUserHostedRuntimeInput,
): Promise<UserHostedRuntimeResult> {
  const emit = (step: string, message?: string) => {
    input.onStatus?.(step)
    input.onLog?.({ step, message, ts: Date.now() })
  }
  const maxAttempts = input.maxHealthAttempts ?? USER_HOSTED_HEALTH_MAX_ATTEMPTS
  const retryDelayMs = input.retryDelayMs ?? USER_HOSTED_HEALTH_RETRY_MS
  const healthTimeoutMs = input.healthTimeoutMs ?? USER_HOSTED_HEALTH_TIMEOUT_MS
  const wait = input.delay ?? sleep
  emit("connecting_workspace", "Connecting to your workspace...")
  const request = input.request ?? authFetch
  const transport = createTransport({
    placement: {
      workspaceId: input.workspaceId,
      hosting: "workspace",
      transport: centralTransportForServer(input.baseUrl) === "loopback" ? "loopback" : "workspace-relay",
    },
    serverUrl: input.baseUrl,
    directory: input.directory,
    request,
    ...(input.relayRequest ?? input.request ? { relayRequest: input.relayRequest ?? input.request } : {}),
  })
  emit("establishing_relay", "Establishing the relay tunnel...")
  let lastOffline = false
  let lastMessage: string | undefined
  let offlineSignalled = false
  const signalOffline = (message?: string) => {
    if (offlineSignalled) return
    offlineSignalled = true
    input.onOffline?.({
      message: message ?? "Workspace host is offline. Start it by running `claxedo up` on the machine that serves this workspace.",
    })
  }
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (input.cancelled?.()) return { ok: false }
    if (attempt > 0) emit("checking_health", "Waiting for the workspace host to come online...")
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), healthTimeoutMs)
    try {
      const res = await transport.fetch("/api/wr/health", bypassFetchThrottle({
        signal: controller.signal,
        headers: { Accept: "application/json" },
      }))
      clearTimeout(timer)
      if (input.cancelled?.()) return { ok: false }
      const text = await res.text().catch(() => "")
      if (res.ok) {
        emit("checking_health", "Checking runtime health...")
        emit("ready")
        return { ok: true, status: "ready" }
      }
      // Transient during the presence-registration window: 503 (host offline),
      // 409 (target not resolvable yet), and 502 (the relay connection itself
      // failed — also what an aborted/timed-out probe surfaces as, since the
      // runtime-request layer maps a rejected relay fetch to a 502). Keep
      // retrying; a genuine runtime error (400/401/404/500) fails fast below.
      lastOffline = res.status === 502 || res.status === 503 || res.status === 409 || isHostOfflineBody(text)
      lastMessage = lastOffline
        ? undefined
        : errorText(text || `Runtime health check failed: ${res.status}`)
      if (!lastOffline) {
        emit("error", `Runtime health check failed (${res.status}).`)
        return { ok: false, status: "error", message: lastMessage }
      }
      signalOffline(lastMessage)
    } catch (error) {
      clearTimeout(timer)
      if (input.cancelled?.()) return { ok: false }
      // An aborted (timed-out) or network-failed probe is transient — retry.
      lastOffline = true
      lastMessage = controller.signal.aborted ? undefined : errorText(error)
      signalOffline(lastMessage)
    }
    if (attempt < maxAttempts - 1) await wait(retryDelayMs)
  }
  emit("error", "Workspace host is offline.")
  return {
    ok: false,
    offline: true,
    status: "error",
    message: lastMessage
      ?? "Workspace host is offline. Start it by running `claxedo up` on the machine that serves this workspace.",
  }
}

export async function prepareWorkspaceRuntime(
  input: PrepareWorkspaceRuntimeInput,
): Promise<PrepareWorkspaceRuntimeResult> {
  const workspace = await resolveWorkspaceRuntime({
    baseUrl: input.baseUrl,
    request: input.request,
    ...runtimeScope(input),
  })
  if (input.cancelled?.()) return { ok: false, cancelled: true, workspace }
  input.onResolved?.(workspace)
  if (!pendingCloudRuntime(workspace)) {
    return { ok: true, startup: false, workspace }
  }

  input.onStatus?.(workspace.status)
  input.onLog?.({
    step: workspace.status,
    message: workspace.status === "stopped" ? "Waking workspace runtime..." : undefined,
    ts: Date.now(),
  })

  const off = input.events?.on("provision", (event) => {
    if (event.workspaceId !== workspace.workspaceId) return
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
      workspaceId: workspace.workspaceId,
      directory: runtimeScope(input).directory,
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

export async function prepareWorkspaceSessionWorktree(
  input: PrepareWorkspaceSessionWorktreeInput,
): Promise<WorkspaceSessionWorktree> {
  const transport = createTransport({
    placement: {
      workspaceId: input.workspaceId,
      hosting: "workspace",
      transport: centralTransportForServer(input.baseUrl) === "loopback" ? "loopback" : "workspace-relay",
    },
    serverUrl: input.baseUrl,
    directory: input.directory ?? `workspace:${input.workspaceId}`,
    request: input.request ?? authFetch,
  })
  const response = await transport.fetch("/api/wr/worktrees", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: input.sessionId,
      ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
    }),
  })
  if (!response.ok) throw new Error((await response.text()) || `Worktree admission failed: ${response.status}`)
  const body = await response.json() as {
    worktree?: { path?: string; branch?: string; baseCommit?: string }
  }
  if (!body.worktree?.path || !body.worktree.branch || !body.worktree.baseCommit) {
    throw new Error("Worktree admission returned an invalid record")
  }
  return body.worktree
}

/**
 * The hosted binding, as one object.
 *
 * Composition installs this — see `app/entry/main.tsx`. Assembled here rather
 * than at the entry so that adding an operation to the port is a type error in
 * THIS file, next to the implementation, instead of in a file whose job is to
 * start the app.
 */
export const cloudWorkspaceStartup: WorkspaceStartupPort = {
  prepareWorkspaceRuntime,
  prepareUserHostedRuntime,
  prepareWorkspaceSessionWorktree,
}
