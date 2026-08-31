export const AGENT_PLUGIN_HARNESSES = ["opencode", "claude", "codex", "cursor"] as const
export type AgentPluginHarness = (typeof AGENT_PLUGIN_HARNESSES)[number]

export type HarnessActivation = {
  explicit?: boolean | null
  projectOverride?: boolean | null
  userDefault?: boolean | null
  organizationDefault?: boolean
  claxedoDefault?: boolean
  effective: {
    status: "ready" | "artifact-unavailable"
    effective: boolean
    winner: string
    artifactDigest?: string
  }
}

export type PluginCandidate = {
  pluginInstanceId: string
  sourceId: string | null
  sourceKind: "claxedo" | "personal" | "organization" | null
  sourceLabel: string | null
  sourceRevision: string | null
  relativePath: string | null
  candidateDigest: string | null
  sourceAvailable: boolean
  retainedDigest: string | null
  artifactAvailable?: boolean
  artifactError?: string
  updateAvailable: boolean
  manifest: {
    name: string
    version?: string
    description?: string
  } | null
  componentDiagnostics: Array<{ code: string; path: string; message: string }>
  mcpServers: Array<{
    name: string
    type: "stdio" | "streamable-http" | "sse"
    authentication:
      | { state: "local" | "harness" | "public" }
      | { state: "oauth"; integrationId: string; issuers?: readonly string[] }
      | { state: "unavailable"; reason: string }
  }>
  harnesses: Record<AgentPluginHarness, HarnessActivation>
}

export type PluginCatalog = {
  revision: number
  supportedHarnesses: AgentPluginHarness[]
  projects?: Array<{ id: string; label: string }>
  selectedProjectId?: string | null
  canManageOrganizationDefaults?: boolean
  canManageOrganizationConnections?: boolean
  candidates: PluginCandidate[]
  errors: Array<{ sourceId: string; relativePath: string; code: string; message: string }>
}

type RequestFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type MutationReceipt = { revision: number; reconciliation: { state: string; message?: string } }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function optionalString(value: unknown) {
  return value === undefined || value === null || typeof value === "string"
}

function harness(value: unknown): value is AgentPluginHarness {
  return typeof value === "string" && AGENT_PLUGIN_HARNESSES.some((candidate) => candidate === value)
}

function harnessActivation(value: unknown): value is HarnessActivation {
  if (!record(value) || !record(value.effective)) return false
  const effective = value.effective
  return (value.explicit === undefined || value.explicit === null || typeof value.explicit === "boolean")
    && (value.projectOverride === undefined || value.projectOverride === null || typeof value.projectOverride === "boolean")
    && (value.userDefault === undefined || value.userDefault === null || typeof value.userDefault === "boolean")
    && (value.organizationDefault === undefined || typeof value.organizationDefault === "boolean")
    && (value.claxedoDefault === undefined || typeof value.claxedoDefault === "boolean")
    && (effective.status === "ready" || effective.status === "artifact-unavailable")
    && typeof effective.effective === "boolean"
    && typeof effective.winner === "string"
    && optionalString(effective.artifactDigest)
}

function pluginCandidate(value: unknown): value is PluginCandidate {
  if (!record(value)
    || typeof value.pluginInstanceId !== "string"
    || !optionalString(value.sourceId)
    || !(value.sourceKind === null || value.sourceKind === "claxedo" || value.sourceKind === "personal" || value.sourceKind === "organization")
    || !optionalString(value.sourceLabel)
    || !optionalString(value.sourceRevision)
    || !optionalString(value.relativePath)
    || !optionalString(value.candidateDigest)
    || typeof value.sourceAvailable !== "boolean"
    || !optionalString(value.retainedDigest)
    || !(value.artifactAvailable === undefined || typeof value.artifactAvailable === "boolean")
    || !optionalString(value.artifactError)
    || typeof value.updateAvailable !== "boolean"
    || !Array.isArray(value.componentDiagnostics)
    || !Array.isArray(value.mcpServers)
    || !record(value.harnesses)) return false
  const harnesses = value.harnesses
  if (!(value.manifest === null || (record(value.manifest)
    && typeof value.manifest.name === "string"
    && optionalString(value.manifest.version)
    && optionalString(value.manifest.description)))) return false
  if (!value.componentDiagnostics.every((diagnostic) => record(diagnostic)
    && typeof diagnostic.code === "string"
    && typeof diagnostic.path === "string"
    && typeof diagnostic.message === "string")) return false
  if (!value.mcpServers.every((server) => record(server)
    && typeof server.name === "string"
    && (server.type === "stdio" || server.type === "streamable-http" || server.type === "sse")
    && record(server.authentication)
    && (server.authentication.state === "local"
      || server.authentication.state === "harness"
      || server.authentication.state === "public"
      || (server.authentication.state === "oauth"
        && typeof server.authentication.integrationId === "string"
        && (server.authentication.issuers === undefined
          || (Array.isArray(server.authentication.issuers)
            && server.authentication.issuers.every((issuer) => typeof issuer === "string"))))
      || (server.authentication.state === "unavailable" && typeof server.authentication.reason === "string")))) return false
  return AGENT_PLUGIN_HARNESSES.every((harnessId) => harnessActivation(harnesses[harnessId]))
}

function pluginCatalog(value: unknown): value is PluginCatalog {
  return record(value)
    && typeof value.revision === "number"
    && Number.isSafeInteger(value.revision)
    && Array.isArray(value.supportedHarnesses)
    && value.supportedHarnesses.every(harness)
    && (value.projects === undefined || (Array.isArray(value.projects)
      && value.projects.every((project) => record(project)
        && typeof project.id === "string"
        && typeof project.label === "string")))
    && optionalString(value.selectedProjectId)
    && (value.canManageOrganizationDefaults === undefined || typeof value.canManageOrganizationDefaults === "boolean")
    && (value.canManageOrganizationConnections === undefined || typeof value.canManageOrganizationConnections === "boolean")
    && Array.isArray(value.candidates)
    && value.candidates.every(pluginCandidate)
    && Array.isArray(value.errors)
    && value.errors.every((error) => record(error)
      && typeof error.sourceId === "string"
      && typeof error.relativePath === "string"
      && typeof error.code === "string"
      && typeof error.message === "string")
}

function mutationReceipt(value: unknown): value is MutationReceipt {
  return record(value)
    && typeof value.revision === "number"
    && Number.isSafeInteger(value.revision)
    && record(value.reconciliation)
    && typeof value.reconciliation.state === "string"
    && optionalString(value.reconciliation.message)
}

async function responseJson<T>(response: Response, validate: (value: unknown) => value is T): Promise<T> {
  const body: unknown = await response.json().catch(() => undefined)
  return resultJson({ status: response.status, body }, validate)
}

export type AgentPluginStatusResult = { status: number; body?: unknown }

function resultJson<T>(result: AgentPluginStatusResult, validate: (value: unknown) => value is T): T {
  if (result.status < 200 || result.status >= 300) {
    const body = result.body
    const message = record(body) && record(body.error) && typeof body.error.message === "string"
      ? body.error.message
      : undefined
    throw new Error(message ?? `Agent Plugins request failed (${result.status})`)
  }
  const body = result.body
  if (!validate(body)) throw new Error("Agent Plugins response did not match its API contract")
  return body
}

export const agentPluginCatalogResult = (result: AgentPluginStatusResult) => resultJson(result, pluginCatalog)
export const agentPluginMutationResult = (result: AgentPluginStatusResult) => resultJson(result, mutationReceipt)

export function agentPluginApi(input: { baseUrl: string; request: RequestFn }) {
  const url = (path = "", options: { refresh?: boolean; projectId?: string } = {}) => {
    const project = options.projectId
      ? `/projects/${encodeURIComponent(options.projectId)}`
      : ""
    const refresh = options.refresh ? "/refresh" : ""
    return new URL(`/api/claxedo/plugins${project}${refresh}${path}`, input.baseUrl)
  }

  return {
    catalog(options: { refresh?: boolean; projectId?: string } = {}) {
      return input.request(url("", options)).then((response) => responseJson(response, pluginCatalog))
    },
    activation(body: {
      pluginInstanceId: string
      harnessIds: AgentPluginHarness[]
      choice: boolean | null
      expectedRevision: number
      target?: { scope: "all-projects" } | { scope: "projects"; projectIds: string[] }
    }) {
      return input.request(url("/activation"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then((response) => responseJson(response, mutationReceipt))
    },
    organizationDefault(body: {
      pluginInstanceId: string
      harnessIds: AgentPluginHarness[]
      choice: true | null
      expectedRevision: number
    }) {
      return input.request(url("/organization-default"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then((response) => responseJson(response, mutationReceipt))
    },
    update(body: { pluginInstanceId: string; expectedRevision: number; authority?: "user" | "organization" }) {
      return input.request(url("/update"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then((response) => responseJson(response, mutationReceipt))
    },
  }
}

export type AgentPluginApi = ReturnType<typeof agentPluginApi>
