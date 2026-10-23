import type { RelayProvider, RelayTokenInput } from "@claxedo/server-core/adapters/relay-port"
import type { ClaxedoRegion } from "@claxedo/server-core/platform/runtime/region/index"
import { RELAY_REGION_HEADER, type RelayRole } from "@claxedo/workspace-relay"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority, type WorkspaceRecord } from "@claxedo/server-core/platform/auth/authority"
import { CONTROL_PLANE_RUNTIME_ACTOR, resolveRuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"
import { asString } from "@claxedo/helpers/guards"
import type { ControlPlaneServices } from "../authority/services"
import { resolveWorkspaceRuntimeTarget } from "../authority/runtime-target"
import { relayRole } from "../authority/pulled-session"

export type RelayRuntimeCapability = RelayTokenInput & { homeRegion: ClaxedoRegion }
export type RelayRuntimeErrorFactory = (status: number, code: string, message: string) => Error

export async function decodeRelayRuntimeJson(response: Response, error: RelayRuntimeErrorFactory): Promise<unknown> {
  if (response.ok) return await response.json().catch(() => undefined)
  throw error(response.status, "workspace_runtime_pull_failed",
    (await response.text().catch(() => "")) || `Workspace runtime pull failed: ${response.status}`)
}

export function createRelayRuntimeClient(deps: {
  provider: Pick<RelayProvider, "mintRuntimeAccessToken" | "getRelayEndpoint">
  error: RelayRuntimeErrorFactory
  request?: (...args: Parameters<typeof globalThis.fetch>) => ReturnType<typeof globalThis.fetch>
}) {
  const connect = (capability: RelayRuntimeCapability) => {
    const { homeRegion, ...claims } = capability
    const minted = (async () => {
      const token = await deps.provider.mintRuntimeAccessToken(claims)
      return { token, endpoint: await deps.provider.getRelayEndpoint(claims.workspaceId, homeRegion) }
    })()
    const request = async (path: string, init?: RequestInit) => {
      const { token, endpoint } = await minted
      const headers = new Headers(init?.headers)
      headers.set("authorization", `Bearer ${token.token}`)
      headers.set("x-claxedo-directory", `workspace:${claims.workspaceId}`)
      // A cold boot's delivery is the first request a new workspace's room ever
      // sees, and the relay places the room by it for good.
      headers.set(RELAY_REGION_HEADER, homeRegion)
      return await (deps.request ?? globalThis.fetch)(
        `${endpoint.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(claims.workspaceId)}${path}`,
        { ...init, headers },
      )
    }
    return {
      fetch: request,
      async json(path: string, init?: RequestInit) {
        const headers = new Headers(init?.headers)
        headers.set("accept", "application/json")
        return await decodeRelayRuntimeJson(await request(path, { ...init, headers }), deps.error)
      },
    }
  }
  return {
    connect,
    fetch: (capability: RelayRuntimeCapability, path: string, init?: RequestInit) => connect(capability).fetch(path, init),
    json: (capability: RelayRuntimeCapability, path: string, init?: RequestInit) => connect(capability).json(path, init),
  }
}

/**
 * A request from this control plane to one of a ready cloud sandbox's own
 * routes, over the relay as the control plane's service actor: the channel a
 * running runtime is reached by after it booted, whatever env it booted with.
 */
export function createHostedRuntimeFetch(services: ControlPlaneServices) {
  return async (workspaceId: string, orgId: string, requestPath: string, init: RequestInit) => {
    const manager = services.sandbox.sandboxManager
    if (!manager) throw new Error("hosted sandbox manager is unavailable")
    const target = await manager.target(workspaceId)
    if (target.status !== "ready") throw new Error(`hosted sandbox ${workspaceId} is unavailable`)
    const provider = services.relay.provider
    if (!provider) throw new Error("hosted runtime token issuer is unavailable")
    return await createRelayRuntimeClient({ provider, error: (_status, _code, message) => new Error(message) }).fetch({
      workspaceId,
      hostId: target.hostId,
      routingId: target.routingId,
      orgId,
      ...CONTROL_PLANE_RUNTIME_ACTOR,
      role: "owner",
      ttlMs: 10 * 60_000,
      homeRegion: target.homeRegion,
    }, requestPath, init)
  }
}

export type CallerRuntimeTarget = {
  readonly workspaceId: string
  readonly orgId: string | undefined
  readonly workspace: WorkspaceRecord | undefined
  readonly role: RelayRole
}

/** The workspace the caller may open, with the role the relay grants them, or nothing when the authority refuses it. */
export async function openCallerRuntimeTarget(services: ControlPlaneServices, auth: SignedControlPlaneAuth, workspaceId: string): Promise<CallerRuntimeTarget | undefined> {
  const authority = requireAuthority(services)
  const opened = await authority.openWorkspace(auth, { workspaceId }).catch((err) => {
    if (err instanceof ControlPlaneAuthError) return undefined
    throw err
  })
  const role = relayRole(opened?.role)
  if (!opened || !role) return undefined
  const orgId = asString(opened.workspace?.org_id) ?? asString(await authority.resolveOrgId(auth))
  return { workspaceId, orgId, workspace: opened.workspace, role }
}

/**
 * The workspace's runtime over the relay as the caller: its target and actor
 * are resolved once and one token is minted for every request made through
 * it. `hostId` is the host the relay routes it to.
 */
export async function connectCallerRuntime(services: ControlPlaneServices, auth: SignedControlPlaneAuth, target: CallerRuntimeTarget, error: RelayRuntimeErrorFactory) {
  const [targetRead, actorRead] = await Promise.allSettled([
    resolveWorkspaceRuntimeTarget(services, auth, { workspaceId: target.workspaceId, ...(target.workspace ? { workspace: target.workspace } : {}) }),
    resolveRuntimeActor(requireAuthority(services), auth),
  ])
  if (targetRead.status === "rejected") throw targetRead.reason
  if (actorRead.status === "rejected") throw actorRead.reason
  const runtime = targetRead.value
  const provider = services.relay.provider
  if (!provider) throw new Error("Workspace runtime pull transport is not configured")
  if (!target.orgId) throw new Error("Workspace is missing org identity for runtime token minting")
  const connection = createRelayRuntimeClient({ provider, error }).connect({
    workspaceId: target.workspaceId,
    hostId: runtime.hostId,
    routingId: runtime.routingId,
    principalKind: "user",
    auth,
    ...actorRead.value,
    orgId: target.orgId,
    role: target.role,
    ttlMs: 10 * 60_000,
    homeRegion: runtime.homeRegion,
  })
  return { ...connection, hostId: runtime.hostId }
}
