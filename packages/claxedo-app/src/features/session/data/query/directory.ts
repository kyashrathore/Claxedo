import type { AgentAgent } from "@claxedo/agent-runtime-contract"
import type { ClaxedoPath as Path, ClaxedoProject as Project } from "@/platform/api/claxedo-api-types"
import { queryKeys, workspaceQueryKey } from "@/platform/query/keys"
import { cachedSignedWorkspace } from "@/platform/runtime/agent/cached-signed-workspace"
import { workspaceRuntimeRoutingRecord, type WorkspaceRuntimeSnapshot } from "@/platform/runtime/workspace-runtime-record"
import { normalizeUrl } from "@/platform/api/api"
import { workspaceScopedResourceList } from "@/platform/runtime/agent-config-routes"

type ProjectClient = {
  project: {
    ensure: () => Promise<{ data?: Project }>
  }
}

type PathClient = {
  path: {
    get: () => Promise<{ data?: Path }>
  }
}

/**
 * `GET /agent` answers `AgentAgent`: `name` is the only guaranteed member, and
 * `mode` is absent whenever the harness does not classify the agent. The three
 * extra members are what the session selector reads off a row; the OpenCode and
 * ACP adapters send none of them, so those reads answer undefined today.
 */
export type Agent = AgentAgent & {
  hidden?: boolean
  model?: { providerID: string; modelID: string }
  variant?: string
}

function agentModelRef(value: unknown) {
  if (typeof value !== "object" || value === null) return undefined
  const providerID = "providerID" in value ? value.providerID : undefined
  const modelID = "modelID" in value ? value.modelID : undefined
  return typeof providerID === "string" && typeof modelID === "string" ? { providerID, modelID } : undefined
}

function agentRow(value: unknown): Agent | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const name = "name" in value ? value.name : undefined
  if (typeof name !== "string") return undefined
  const id = "id" in value ? value.id : undefined
  const description = "description" in value ? value.description : undefined
  const mode = "mode" in value ? value.mode : undefined
  const model = "model" in value ? agentModelRef(value.model) : undefined
  const variant = "variant" in value ? value.variant : undefined
  const hidden = "hidden" in value ? value.hidden : undefined
  return {
    name,
    ...(typeof id === "string" && id ? { id } : {}),
    ...(typeof description === "string" ? { description } : {}),
    ...(typeof mode === "string" ? { mode } : {}),
    ...(model === undefined ? {} : { model }),
    ...(typeof variant === "string" ? { variant } : {}),
    ...(typeof hidden === "boolean" ? { hidden } : {}),
  }
}

function agentListFromUnknown(data: unknown): Agent[] {
  return Array.isArray(data) ? data.flatMap((item) => agentRow(item) ?? []) : []
}

/**
 * The current project for a directory, registered first when it has none.
 * Registration is a write, so the query asks the POST form of
 * `/project/current` (`project.ensure`): the read verb on that route resolves
 * only and would 404 an unregistered directory.
 */
export function projectCurrentQuery(input: {
  baseUrl?: string
  directory: string
  client: ProjectClient
}) {
  return {
    queryKey: queryKeys.directory.project(input.baseUrl, input.directory),
    staleTime: 60 * 1000,
    queryFn: async () => (await input.client.project.ensure()).data!.id,
  }
}

export function agentListQuery(input: {
  baseUrl: string
  directory: string
  harnessType?: string
  request: typeof fetch
  workspace?: WorkspaceRuntimeSnapshot | null
}) {
  return {
    queryKey: queryKeys.directory.agents(
      input.baseUrl,
      input.directory,
      input.harnessType,
      workspaceQueryKey(input.workspace),
    ),
    staleTime: 30 * 1000,
    queryFn: async () => {
      const baseUrl = normalizeUrl(input.baseUrl) ?? input.baseUrl
      const signedWorkspace = cachedSignedWorkspace(input.baseUrl, input.directory)
      const workspace = input.workspace ?? signedWorkspace ?? (
        input.workspace !== undefined
          ? input.workspace
          : await workspaceRuntimeRoutingRecord({ baseUrl: input.baseUrl, request: input.request, directory: input.directory })
      )
      return workspaceScopedResourceList({
        baseUrl,
        directory: input.directory,
        harnessType: input.harnessType,
        request: input.request,
        workspace,
        resource: { plural: "agents", singular: "agent", scopeCentralUrl: true },
        parse: agentListFromUnknown,
      })
    },
  }
}

export function pathQuery(input: {
  baseUrl?: string
  directory: string
  client: PathClient
}) {
  return {
    queryKey: queryKeys.directory.path(input.baseUrl, input.directory),
    staleTime: 5 * 60 * 1000,
    queryFn: async () => (await input.client.path.get()).data!,
  }
}
