import { authFetch, normalizeUrl } from "../../utils/api"
import { centralTransportForServer, unsignedLocalFetch } from "@claxedo/shell/data/transport/transport"
import { createTransport } from "../../shell/data/transport/transport"
import type { WorkspaceRuntimeSnapshot } from "./runtime"

export type AgentConfigResource = "agents" | "commands"
export type WorkspaceRuntimeAgentConfigResource = "agent" | "command"

export function agentConfigRequest(input: { baseUrl: string; request?: typeof fetch }) {
  return centralTransportForServer(input.baseUrl) === "loopback"
    ? unsignedLocalFetch
    : input.request ?? authFetch
}

export function workspaceTransportForBaseUrl(baseUrl: string) {
  return centralTransportForServer(baseUrl) === "loopback" ? "loopback" : "workspace-relay"
}

export function agentConfigUrl(input: {
  baseUrl: string
  resource: AgentConfigResource
  scope?: string
  harnessType?: string
}) {
  const url = new URL(`/api/claxedo/agent-config/${input.resource}`, input.baseUrl)
  if (input.scope) url.searchParams.set("directory", input.scope)
  if (input.harnessType) url.searchParams.set("type", input.harnessType)
  return url
}

export function workspaceRuntimeAgentConfigPath(input: {
  resource: WorkspaceRuntimeAgentConfigResource
  scope: string
  harnessType?: string
}) {
  const url = new URL(`/${input.resource}`, "http://claxedo.local")
  url.searchParams.set("directory", input.scope)
  if (input.harnessType) url.searchParams.set("harness", input.harnessType)
  return `${url.pathname}${url.search}`
}

export type WorkspaceScopedResource = {
  /** Plural resource name used by the central `/api/claxedo/agent-config/*` route. */
  plural: AgentConfigResource
  /** Singular resource name used by the workspace-runtime route. */
  singular: WorkspaceRuntimeAgentConfigResource
  /**
   * Whether the central (non-workspace) request should carry `directory`/`type`
   * query params. Agents are directory- and harness-scoped at the central route;
   * commands are not (the central commands route ignores scope).
   */
  scopeCentralUrl: boolean
}

/**
 * Shared 3-way transport branch used by both `agentListQuery` (directory.ts)
 * and `commandListQuery` (shell.ts): resolve where the resource list should
 * come from given an already-resolved `workspace`, then fetch and parse it.
 * A single owner here keeps the two call sites from drifting apart.
 */
export async function workspaceScopedResourceList<T>(input: {
  baseUrl: string
  directory: string
  harnessType?: string
  request?: typeof fetch
  workspace: WorkspaceRuntimeSnapshot | null | undefined
  resource: WorkspaceScopedResource
  parse: (data: unknown) => T[]
}): Promise<T[]> {
  const baseUrl = normalizeUrl(input.baseUrl) ?? input.baseUrl
  if (input.workspace?.kind !== "cloud" && input.workspace?.kind !== "user-hosted") {
    // Rubric Q4: declare auth intent at the call site. Loopback Claxedo
    // server bypasses the bearer (`unsignedLocalFetch`); cloud /
    // user-hosted control plane uses the signed fetch.
    const claxedoFetch = agentConfigRequest({ baseUrl, request: input.request })
    const res = await claxedoFetch(
      agentConfigUrl({
        baseUrl,
        resource: input.resource.plural,
        ...(input.resource.scopeCentralUrl
          ? { scope: input.directory, harnessType: input.harnessType }
          : {}),
      }),
    )
    if (!res.ok) return []
    return input.parse(await res.json().catch(() => []))
  }
  if (!input.workspace.workspaceId) return []
  const res = await createTransport({
    placement: {
      workspaceId: input.workspace.workspaceId,
      hosting: "workspace",
      transport: workspaceTransportForBaseUrl(baseUrl),
    },
    serverUrl: baseUrl,
    directory: input.directory,
    request: input.request,
  }).fetch(workspaceRuntimeAgentConfigPath({
    resource: input.resource.singular,
    scope: input.directory,
    ...(input.harnessType ? { harnessType: input.harnessType } : {}),
  })).catch(() => undefined)
  if (!res) return []
  if (!res.ok) return []
  return input.parse(await res.json().catch(() => []))
}
