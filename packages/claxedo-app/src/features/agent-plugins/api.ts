import { isRecord, readField, readString } from "@/lib/record"
import { isString } from "@claxedo/helpers/guards"

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

export type AgentPluginSourceKind = "claxedo" | "personal" | "organization"

/**
 * The first-party server's tool groups, in the order the pane lists them.
 *
 * A group is the unit of consent: enabling it registers its tools on the
 * session's MCP mount and, for Tasks, mints the capability the tools act on.
 * The catalog derives its entries by running each registration, so it emits
 * them in registration order; reading order is this table's to decide.
 */
export const BUILT_IN_TOOL_GROUPS = [
  "sessions",
  "subagents",
  "attention",
  "processes",
  "documents",
  "tasks",
  "review",
  "workspaces",
] as const
export type BuiltInToolGroupId = (typeof BUILT_IN_TOOL_GROUPS)[number]

export type PluginToolGroup = {
  id: BuiltInToolGroupId
  /** What `activation` names to turn this group on or off; the group is the activation subject. */
  pluginInstanceId: string
  enabled: boolean
  tools: string[]
}

export type PluginIcon =
  | { kind: "url"; url: string }
  | { kind: "monogram"; text: string }

export type PluginSkill = {
  name: string
  description: string
  path: string
}

/** The collection a candidate came from; `null` once no source serves it any more. */
export type PluginSource = {
  id: string
  kind: AgentPluginSourceKind
  label: string
  repository?: string
}

export type PluginCandidate = {
  pluginInstanceId: string
  /** The first-party server: always in the catalog, never installed or removed. */
  builtIn?: boolean
  /** Present only on the built-in, where a group rather than the plugin is what a user turns on. */
  groups?: PluginToolGroup[]
  sourceId: string | null
  sourceKind: AgentPluginSourceKind | null
  source: PluginSource | null
  icon?: PluginIcon
  /** Browse category ids the plugin's manifest declares; the Directory labels the ones it knows. */
  categories?: string[]
  featured?: boolean
  skills: PluginSkill[]
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

/** One skill's SKILL.md, read from the plugin's retained artifact. */
export type SkillDocument = { name: string; description: string; markdown: string }

function optionalString(value: unknown) {
  return value === undefined || value === null || isString(value)
}

function harness(value: unknown): value is AgentPluginHarness {
  return typeof value === "string" && AGENT_PLUGIN_HARNESSES.some((candidate) => candidate === value)
}

function harnessActivation(value: unknown): value is HarnessActivation {
  if (!isRecord(value) || !isRecord(value.effective)) return false
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

/** Exported because the Directory's DTO reader narrows the same field. */
export function isAgentPluginSourceKind(value: unknown): value is AgentPluginSourceKind {
  return value === "claxedo" || value === "personal" || value === "organization"
}

function pluginIcon(value: unknown): value is PluginIcon | undefined {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  if (value.kind === "url") return typeof value.url === "string"
  return value.kind === "monogram" && typeof value.text === "string"
}

function pluginSource(value: unknown): value is PluginSource | null {
  if (value === null) return true
  return isRecord(value)
    && typeof value.id === "string"
    && isAgentPluginSourceKind(value.kind)
    && typeof value.label === "string"
    && optionalString(value.repository)
}

function pluginCategories(value: unknown): value is string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every(isString))
}

function toolGroupId(value: unknown): value is BuiltInToolGroupId {
  return BUILT_IN_TOOL_GROUPS.some((group) => group === value)
}

function pluginToolGroups(value: unknown): value is PluginToolGroup[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every((group) => isRecord(group)
    && toolGroupId(group.id)
    && typeof group.pluginInstanceId === "string"
    && typeof group.enabled === "boolean"
    && Array.isArray(group.tools)
    && group.tools.every(isString)))
}

function pluginSkills(value: unknown): value is PluginSkill[] {
  return Array.isArray(value) && value.every((skill) => isRecord(skill)
    && typeof skill.name === "string"
    && typeof skill.description === "string"
    && typeof skill.path === "string")
}

function pluginCandidate(value: unknown): value is PluginCandidate {
  if (!isRecord(value)
    || typeof value.pluginInstanceId !== "string"
    || !(value.builtIn === undefined || typeof value.builtIn === "boolean")
    || !pluginToolGroups(value.groups)
    || !optionalString(value.sourceId)
    || !(value.sourceKind === null || isAgentPluginSourceKind(value.sourceKind))
    || !pluginSource(value.source)
    || !pluginIcon(value.icon)
    || !pluginCategories(value.categories)
    || !(value.featured === undefined || typeof value.featured === "boolean")
    || !pluginSkills(value.skills)
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
    || !isRecord(value.harnesses)) return false
  const harnesses = value.harnesses
  if (!(value.manifest === null || (isRecord(value.manifest)
    && typeof value.manifest.name === "string"
    && optionalString(value.manifest.version)
    && optionalString(value.manifest.description)))) return false
  if (!value.componentDiagnostics.every((diagnostic) => isRecord(diagnostic)
    && typeof diagnostic.code === "string"
    && typeof diagnostic.path === "string"
    && typeof diagnostic.message === "string")) return false
  if (!value.mcpServers.every((server) => isRecord(server)
    && typeof server.name === "string"
    && (server.type === "stdio" || server.type === "streamable-http" || server.type === "sse")
    && isRecord(server.authentication)
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
  return isRecord(value)
    && typeof value.revision === "number"
    && Number.isSafeInteger(value.revision)
    && Array.isArray(value.supportedHarnesses)
    && value.supportedHarnesses.every(harness)
    && (value.projects === undefined || (Array.isArray(value.projects)
      && value.projects.every((project) => isRecord(project)
        && typeof project.id === "string"
        && typeof project.label === "string")))
    && optionalString(value.selectedProjectId)
    && (value.canManageOrganizationDefaults === undefined || typeof value.canManageOrganizationDefaults === "boolean")
    && (value.canManageOrganizationConnections === undefined || typeof value.canManageOrganizationConnections === "boolean")
    && Array.isArray(value.candidates)
    && value.candidates.every(pluginCandidate)
    && Array.isArray(value.errors)
    && value.errors.every((error) => isRecord(error)
      && typeof error.sourceId === "string"
      && typeof error.relativePath === "string"
      && typeof error.code === "string"
      && typeof error.message === "string")
}

function skillDocument(value: unknown): value is SkillDocument {
  return isRecord(value)
    && typeof value.name === "string"
    && typeof value.description === "string"
    && typeof value.markdown === "string"
}

function mutationReceipt(value: unknown): value is MutationReceipt {
  return isRecord(value)
    && typeof value.revision === "number"
    && Number.isSafeInteger(value.revision)
    && isRecord(value.reconciliation)
    && typeof value.reconciliation.state === "string"
    && optionalString(value.reconciliation.message)
}

async function responseJson<T>(response: Response, validate: (value: unknown) => value is T): Promise<T> {
  const body: unknown = await response.json().catch(() => undefined)
  return resultJson({ status: response.status, body }, validate)
}

export type AgentPluginStatusResult = { status: number; body?: unknown }

/** A non-2xx Agent Plugins answer, keeping the status and error code the server named. */
export class AgentPluginRequestError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string) {
    super(message)
    this.name = "AgentPluginRequestError"
  }
}

/**
 * The server refused a mutation because the catalog revision it was decided
 * on has moved (another client, device, or runtime apply changed activation
 * state since this catalog was read). The decision itself is still valid on
 * the newer state, so callers re-read and retry once instead of failing.
 */
export function isAgentPluginRevisionConflict(error: unknown): boolean {
  return error instanceof AgentPluginRequestError && error.status === 409
}

/**
 * Runs a revision-guarded mutation against the current catalog revision and,
 * on a revision conflict, re-reads the catalog and retries exactly once with
 * the fresh revision. A second conflict is reported as-is.
 */
export async function withCurrentRevision<T>(input: {
  revision: () => number | undefined
  reread: () => Promise<void>
  run: (expectedRevision: number) => Promise<T>
}): Promise<T> {
  const first = input.revision()
  if (first === undefined) throw new Error("The plugin catalog is not loaded")
  try {
    return await input.run(first)
  } catch (error) {
    if (!isAgentPluginRevisionConflict(error)) throw error
    await input.reread()
    const next = input.revision()
    if (next === undefined || next === first) throw error
    return await input.run(next)
  }
}

function resultJson<T>(result: AgentPluginStatusResult, validate: (value: unknown) => value is T): T {
  if (result.status < 200 || result.status >= 300) {
    const failure = readField(result.body, "error")
    const message = readString(failure, "message")
    const code = readString(failure, "code")
    throw new AgentPluginRequestError(result.status, code, message ?? `Agent Plugins request failed (${result.status})`)
  }
  const body = result.body
  if (!validate(body)) throw new Error("Agent Plugins response did not match its API contract")
  return body
}

export const agentPluginCatalogResult = (result: AgentPluginStatusResult) => resultJson(result, pluginCatalog)
export const agentPluginMutationResult = (result: AgentPluginStatusResult) => resultJson(result, mutationReceipt)
export const agentPluginSkillResult = (result: AgentPluginStatusResult) => resultJson(result, skillDocument)

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
    /** One skill's SKILL.md from the retained artifact, or the cached catalog tree. */
    skill(options: { pluginInstanceId: string; skill: string; projectId?: string }) {
      const path = `/${encodeURIComponent(options.pluginInstanceId)}/skills/${encodeURIComponent(options.skill)}`
      return input.request(url(path, options.projectId ? { projectId: options.projectId } : {}))
        .then((response) => responseJson(response, skillDocument))
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
