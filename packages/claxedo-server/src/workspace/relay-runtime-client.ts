import type { RelayProvider, RelayTokenInput } from "@claxedo/server-core/adapters/relay-port"
import type { ClaxedoRegion } from "@claxedo/server-core/platform/runtime/region/index"
import { CONTROL_PLANE_RUNTIME_ACTOR } from "@claxedo/server-core/platform/auth/runtime-actor"
import type { ControlPlaneServices } from "../authority/services"

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
  const request = async (capability: RelayRuntimeCapability, path: string, init?: RequestInit) => {
    const { homeRegion, ...claims } = capability
    const token = await deps.provider.mintRuntimeAccessToken(claims)
    const endpoint = await deps.provider.getRelayEndpoint(claims.workspaceId, homeRegion)
    const headers = new Headers(init?.headers)
    headers.set("authorization", `Bearer ${token.token}`)
    headers.set("x-claxedo-directory", `workspace:${claims.workspaceId}`)
    return await (deps.request ?? globalThis.fetch)(
      `${endpoint.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(claims.workspaceId)}${path}`,
      { ...init, headers },
    )
  }
  return {
    fetch: request,
    async json(capability: RelayRuntimeCapability, path: string, init?: RequestInit) {
      const headers = new Headers(init?.headers)
      headers.set("accept", "application/json")
      return await decodeRelayRuntimeJson(await request(capability, path, { ...init, headers }), deps.error)
    },
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
