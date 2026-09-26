import type {
  MarketplaceCatalog,
  PluginActivation,
  PluginCandidate,
  PluginHarness,
  PluginIcon,
  PluginMcpServer,
  PluginSkill,
  PluginSkillDocument,
  PluginSource,
  PluginSourceKind,
  PluginToolGroup,
} from "../marketplace-types"

type Row = Record<string, unknown>

export const PLUGIN_HARNESSES: readonly PluginHarness[] = ["opencode", "claude", "codex", "cursor"]

const SOURCE_KINDS: readonly PluginSourceKind[] = ["claxedo", "personal", "organization"]

function record(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function optionalString(value: unknown) {
  return value === undefined || value === null || isString(value)
}

function optionalBoolean(value: unknown) {
  return value === undefined || typeof value === "boolean"
}

function nullableBoolean(value: unknown) {
  return value === undefined || value === null || typeof value === "boolean"
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString)
}

function harness(value: unknown): value is PluginHarness {
  return PLUGIN_HARNESSES.some((candidate) => candidate === value)
}

export function isPluginSourceKind(value: unknown): value is PluginSourceKind {
  return SOURCE_KINDS.some((kind) => kind === value)
}

function activation(value: unknown): value is PluginActivation {
  if (!record(value) || !record(value.effective)) return false
  const effective = value.effective
  return (
    nullableBoolean(value.explicit) &&
    nullableBoolean(value.projectOverride) &&
    nullableBoolean(value.userDefault) &&
    optionalBoolean(value.organizationDefault) &&
    optionalBoolean(value.claxedoDefault) &&
    (effective.status === "ready" || effective.status === "artifact-unavailable") &&
    typeof effective.effective === "boolean" &&
    isString(effective.winner) &&
    optionalString(effective.artifactDigest)
  )
}

function icon(value: unknown): value is PluginIcon | undefined {
  if (value === undefined) return true
  if (!record(value)) return false
  if (value.kind === "url") return isString(value.url)
  return value.kind === "monogram" && isString(value.text)
}

function source(value: unknown): value is PluginSource | null {
  if (value === null) return true
  return (
    record(value) &&
    isString(value.id) &&
    isPluginSourceKind(value.kind) &&
    isString(value.label) &&
    optionalString(value.repository)
  )
}

function toolGroups(value: unknown): value is PluginToolGroup[] | undefined {
  if (value === undefined) return true
  return (
    Array.isArray(value) &&
    value.every(
      (group) =>
        record(group) &&
        isString(group.id) &&
        isString(group.pluginInstanceId) &&
        typeof group.enabled === "boolean" &&
        stringList(group.tools),
    )
  )
}

function skills(value: unknown): value is PluginSkill[] {
  return (
    Array.isArray(value) &&
    value.every((skill) => record(skill) && isString(skill.name) && isString(skill.description) && isString(skill.path))
  )
}

function authentication(value: unknown): boolean {
  if (!record(value)) return false
  if (value.state === "local" || value.state === "harness" || value.state === "public") return true
  if (value.state === "unavailable") return isString(value.reason)
  return (
    value.state === "oauth" &&
    isString(value.integrationId) &&
    (value.issuers === undefined || stringList(value.issuers))
  )
}

function mcpServers(value: unknown): value is PluginMcpServer[] {
  return (
    Array.isArray(value) &&
    value.every(
      (server) =>
        record(server) &&
        isString(server.name) &&
        (server.type === "stdio" || server.type === "streamable-http" || server.type === "sse") &&
        authentication(server.authentication),
    )
  )
}

function diagnostics(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((item) => record(item) && isString(item.code) && isString(item.path) && isString(item.message))
  )
}

function manifest(value: unknown): boolean {
  if (value === null) return true
  return record(value) && isString(value.name) && optionalString(value.version) && optionalString(value.description)
}

function candidateIdentity(value: Row): boolean {
  return (
    isString(value.pluginInstanceId) &&
    optionalBoolean(value.builtIn) &&
    optionalString(value.sourceId) &&
    (value.sourceKind === null || value.sourceKind === undefined || isPluginSourceKind(value.sourceKind)) &&
    source(value.source) &&
    icon(value.icon) &&
    (value.categories === undefined || stringList(value.categories)) &&
    optionalBoolean(value.featured)
  )
}

function candidateArtifact(value: Row): boolean {
  return (
    optionalString(value.sourceRevision) &&
    optionalString(value.relativePath) &&
    optionalString(value.candidateDigest) &&
    typeof value.sourceAvailable === "boolean" &&
    optionalString(value.retainedDigest) &&
    optionalBoolean(value.artifactAvailable) &&
    optionalString(value.artifactError) &&
    typeof value.updateAvailable === "boolean"
  )
}

function candidate(value: unknown): value is PluginCandidate {
  if (!record(value) || !candidateIdentity(value) || !candidateArtifact(value)) return false
  if (!toolGroups(value.groups) || !skills(value.skills) || !manifest(value.manifest)) return false
  if (!diagnostics(value.componentDiagnostics) || !mcpServers(value.mcpServers)) return false
  const harnesses = value.harnesses
  return record(harnesses) && PLUGIN_HARNESSES.every((id) => activation(harnesses[id]))
}

function catalogErrors(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (error) =>
        record(error) &&
        isString(error.sourceId) &&
        isString(error.relativePath) &&
        isString(error.code) &&
        isString(error.message),
    )
  )
}

function projects(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every((project) => record(project) && isString(project.id) && isString(project.label)))
  )
}

export function marketplaceCatalogFromWire(value: unknown): MarketplaceCatalog | undefined {
  if (!record(value) || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision)) return undefined
  if (!Array.isArray(value.supportedHarnesses) || !value.supportedHarnesses.every(harness)) return undefined
  if (!projects(value.projects) || !optionalString(value.selectedProjectId)) return undefined
  if (!optionalBoolean(value.canManageOrganizationDefaults) || !optionalBoolean(value.canManageOrganizationConnections))
    return undefined
  if (!Array.isArray(value.candidates) || !value.candidates.every(candidate) || !catalogErrors(value.errors))
    return undefined
  return value as MarketplaceCatalog
}

export function pluginSkillFromWire(value: unknown): PluginSkillDocument | undefined {
  if (!record(value) || !isString(value.name) || !isString(value.description) || !isString(value.markdown))
    return undefined
  return { name: value.name, description: value.description, markdown: value.markdown }
}
