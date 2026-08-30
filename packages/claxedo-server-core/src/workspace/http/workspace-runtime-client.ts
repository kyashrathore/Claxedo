import type { RelayTokenInput } from "../../adapters/relay/index"
import { normalizeClaxedoRegion, type ClaxedoRegion } from "../../platform/runtime/region/index"
import type { SandboxReadyTarget } from "../../sandbox/manager-port"
import type { Workspace } from "../store/index"
import { localWorkspaceRuntime } from "../local-runtime-port"

const TOKEN_REFRESH_SKEW_MS = 60_000
const ENSURE_TTL_MS = 30_000

export type WorkspaceRuntimeClientOptions = {
  sandboxManager?: import("../../sandbox/manager-port").SandboxManagerPort
  relayProvider?: import("../../adapters/relay/index").RelayProvider
  loopbackRelayUrl?: string
  defaultHomeRegion?: ClaxedoRegion
  subject?: string
  principalKind?: "user" | "service"
  actorId?: string
  actorKind?: "human" | "agent"
  orgId?: string
  role?: RelayTokenInput["role"]
  /** Inspect an already-ready runtime without waking or reprovisioning it. */
  resume?: boolean
}

export type RuntimeGeneration = Readonly<{
  hostId: string
  homeRegion: string
  leaseEpoch: number
  relayUrl: string
  accessToken: Readonly<{
    token: string
    expiresAt: number
    hostId: string
  }>
}>

export type WorkspaceRuntimeClient = {
  request(path: string, init?: RequestInit): Promise<Response>
  resolveGeneration(): Promise<RuntimeGeneration | undefined>
  requestGeneration(generation: RuntimeGeneration, path: string, init?: RequestInit): Promise<Response>
}

export class WorkspaceRuntimeRequestError extends Error {
  readonly status: number | undefined
  readonly code: string | undefined
  readonly operation: string
  readonly retriable: boolean

  constructor(input: {
    operation: string
    message: string
    status?: number
    code?: string
    retriable?: boolean
    cause?: unknown
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause })
    this.name = "WorkspaceRuntimeRequestError"
    this.operation = input.operation
    this.status = input.status
    this.code = input.code
    this.retriable = input.retriable ?? false
  }
}

export async function workspaceRuntimeRequestError(
  operation: string,
  response: Response,
): Promise<WorkspaceRuntimeRequestError> {
  const body: unknown = await response.json().catch(() => undefined)
  const error = record(body) && record(body.error) ? body.error : undefined
  const code = typeof error?.code === "string" ? error.code : undefined
  const detail = typeof error?.message === "string" ? error.message : undefined
  return new WorkspaceRuntimeRequestError({
    operation,
    status: response.status,
    ...(code ? { code } : {}),
    retriable: response.status >= 500,
    message: detail
      ? `workspace-runtime ${operation} failed: ${detail}`
      : `workspace-runtime ${operation} failed with status ${response.status}`,
  })
}

export function createWorkspaceRuntimeClient(input: {
  workspace: Workspace
  options?: WorkspaceRuntimeClientOptions
  directory?: string
  headers?: () => HeadersInit | undefined
}): WorkspaceRuntimeClient {
  const options = input.options ?? {}
  const ws = input.workspace
  const directory = input.directory ?? `workspace:${ws.id}`

  if (ws.kind !== "cloud") return createEmbeddedClient(ws, directory, input.headers)
  if (options.loopbackRelayUrl && !options.relayProvider) {
    return createLoopbackClient(ws, options.loopbackRelayUrl, directory, input.headers)
  }

  const sandboxManager = options.sandboxManager
  const relayProvider = options.relayProvider
  if (!sandboxManager) throw new Error(`sandbox manager unavailable: ${ws.id}`)
  if (!relayProvider) throw new Error(`workspace relay provider unavailable: ${ws.id}`)
  const orgId = options.orgId ?? ws.org_id
  if (!orgId) throw new Error(`workspace org required for runtime token minting: ${ws.id}`)
  if (!options.principalKind) throw new Error(`runtime principal kind required for runtime token minting: ${ws.id}`)
  if (!options.subject || !options.actorId || !options.actorKind || !options.role) {
    throw new Error(`complete runtime principal required for runtime token minting: ${ws.id}`)
  }
  const principal = {
    subject: options.subject,
    principalKind: options.principalKind,
    actorId: options.actorId,
    actorKind: options.actorKind,
    role: options.role,
    orgId,
  }
  const defaultHomeRegion = options.defaultHomeRegion ?? "us-east"
  let generation: RuntimeGeneration | undefined
  let refresh: Promise<RuntimeGeneration> | undefined
  let retriedEnsureAt = 0

  const target = async (): Promise<SandboxReadyTarget> => {
    const result =
      options.resume === false
        ? await sandboxManager.target(ws.id)
        : await sandboxManager.ensure(ws.id, { homeRegion: defaultHomeRegion })
    if (result.status === "ready") return result
    if (result.status === "provisioning") {
      throw new WorkspaceRuntimeRequestError({
        operation: "resolve",
        status: 503,
        code: "sandbox_provisioning",
        retriable: true,
        message: `sandbox provisioning; retry after ${result.retryAfterMs}ms`,
      })
    }
    const reason = "reason" in result ? result.reason : result.error
    throw new WorkspaceRuntimeRequestError({
      operation: "resolve",
      status: 503,
      code: "sandbox_unavailable",
      retriable: true,
      message: reason ?? `sandbox unavailable: ${ws.id}`,
    })
  }

  const buildGeneration = async (forceTarget: boolean): Promise<RuntimeGeneration> => {
    const previous = generation
    const active =
      forceTarget || !previous
        ? await target()
        : {
            hostId: previous.hostId,
            homeRegion: previous.homeRegion,
            epoch: previous.leaseEpoch,
          }
    const homeRegion = normalizeClaxedoRegion(active.homeRegion, defaultHomeRegion)
    const sameTarget =
      previous &&
      previous.hostId === active.hostId &&
      previous.homeRegion === homeRegion &&
      previous.leaseEpoch === active.epoch
    const [relayUrl, minted] = await Promise.all([
      sameTarget ? previous.relayUrl : relayProvider.getRelayEndpoint(ws.id, homeRegion),
      relayProvider.mintRuntimeAccessToken({
        workspaceId: ws.id,
        hostId: active.hostId,
        subject: principal.subject,
        principalKind: principal.principalKind,
        actorId: principal.actorId,
        actorKind: principal.actorKind,
        orgId: principal.orgId,
        role: principal.role,
        ttlMs: 10 * 60_000,
      }),
    ])
    const next = Object.freeze({
      hostId: active.hostId,
      homeRegion,
      leaseEpoch: active.epoch,
      relayUrl,
      accessToken: Object.freeze({
        token: minted.token,
        expiresAt: minted.expiresAt,
        hostId: active.hostId,
      }),
    })
    generation = next
    return next
  }

  const startRefresh = (forceTarget: boolean) => {
    const pending = buildGeneration(forceTarget)
    refresh = pending
    pending
      .finally(() => {
        if (refresh === pending) refresh = undefined
      })
      .catch(() => {})
    return pending
  }

  const currentGeneration = async (): Promise<RuntimeGeneration> => {
    if (generation && Date.now() < generation.accessToken.expiresAt - TOKEN_REFRESH_SKEW_MS) return generation
    return refresh ?? startRefresh(false)
  }

  const forceGeneration = async (): Promise<RuntimeGeneration> => {
    if (refresh) await refresh
    return startRefresh(true)
  }

  const dispatch = async (active: RuntimeGeneration, requestPath: string, init?: RequestInit) => {
    const headers = requestHeaders(init, directory, input.headers)
    headers.set("authorization", `Bearer ${active.accessToken.token}`)
    return globalThis.fetch(runtimeUrl(active.relayUrl, ws.id, requestPath), { ...init, headers })
  }

  const request = async (requestPath: string, init?: RequestInit): Promise<Response> => {
    const active = await currentGeneration()
    const retrySafe = isSafeMethod(init?.method)
    let response: Response
    try {
      response = await dispatch(active, requestPath, init)
    } catch (cause) {
      if (!retrySafe || !isConnectivityError(cause) || Date.now() - retriedEnsureAt < ENSURE_TTL_MS) throw cause
      retriedEnsureAt = Date.now()
      return dispatch(await forceGeneration(), requestPath, init)
    }
    if (retrySafe && response.status >= 500 && Date.now() - retriedEnsureAt >= ENSURE_TTL_MS) {
      retriedEnsureAt = Date.now()
      await response.body?.cancel().catch(() => {})
      return dispatch(await forceGeneration(), requestPath, init)
    }
    return response
  }

  return {
    request,
    resolveGeneration: currentGeneration,
    requestGeneration: dispatch,
  }
}

function createEmbeddedClient(
  workspace: Workspace,
  directory: string,
  extraHeaders?: () => HeadersInit | undefined,
): WorkspaceRuntimeClient {
  return {
    async request(path, init) {
      const headers = requestHeaders(init, directory, extraHeaders)
      return localWorkspaceRuntime().fetch(
        workspace,
        new Request(new URL(path, "http://embedded-workspace-runtime.local"), { ...init, headers }),
      )
    },
    async resolveGeneration() {
      return undefined
    },
    async requestGeneration(_generation, path, init) {
      return this.request(path, init)
    },
  }
}

function createLoopbackClient(
  workspace: Workspace,
  relayUrl: string,
  directory: string,
  extraHeaders?: () => HeadersInit | undefined,
): WorkspaceRuntimeClient {
  const request = async (path: string, init?: RequestInit) => {
    const headers = requestHeaders(init, directory, extraHeaders)
    return globalThis.fetch(runtimeUrl(relayUrl, workspace.id, path), { ...init, headers })
  }
  return {
    request,
    async resolveGeneration() {
      return undefined
    },
    async requestGeneration(_generation, path, init) {
      return request(path, init)
    },
  }
}

function requestHeaders(
  init: RequestInit | undefined,
  directory: string,
  extraHeaders?: () => HeadersInit | undefined,
) {
  const headers = new Headers(init?.headers)
  const extra = new Headers(extraHeaders?.())
  extra.forEach((value, key) => headers.set(key, value))
  headers.set("x-opencode-directory", directory)
  headers.set("accept-encoding", "identity")
  return headers
}

function isSafeMethod(method: string | undefined) {
  return ["GET", "HEAD", "OPTIONS"].includes((method ?? "GET").toUpperCase())
}

function isConnectivityError(error: unknown) {
  return error instanceof TypeError
}

function runtimeUrl(relayUrl: string, workspaceId: string, requestPath: string) {
  return `${relayUrl.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(workspaceId)}${sandboxPath(requestPath)}`
}

function sandboxPath(requestPath: string) {
  const url = new URL(requestPath, "http://sandbox-manager.local")
  return `${url.pathname}${url.search}`
}

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}
