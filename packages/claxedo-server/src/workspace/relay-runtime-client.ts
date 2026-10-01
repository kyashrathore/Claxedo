import type { RelayProvider, RelayTokenInput } from "@claxedo/server-core/adapters/relay-port"
import type { ClaxedoRegion } from "@claxedo/server-core/platform/runtime/region/index"

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
