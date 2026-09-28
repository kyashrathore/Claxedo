import { isRecord, isString, isStringList } from "@claxedo/helpers/guards"
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

export const PLUGIN_HARNESSES: readonly PluginHarness[] = ["opencode", "claude", "codex", "cursor", "acp"]

const SOURCE_KINDS: readonly PluginSourceKind[] = ["claxedo", "personal", "organization"]

function isOptionalString(value: unknown) {
  return value === undefined || value === null || isString(value)
}

function isOptionalBoolean(value: unknown) {
  return value === undefined || typeof value === "boolean"
}

function isNullableBoolean(value: unknown) {
  return value === undefined || value === null || typeof value === "boolean"
}

function isHarness(value: unknown): value is PluginHarness {
  return PLUGIN_HARNESSES.some((candidate) => candidate === value)
}

export function isPluginSourceKind(value: unknown): value is PluginSourceKind {
  return SOURCE_KINDS.some((kind) => kind === value)
}

function isActivation(value: unknown): value is PluginActivation {
  if (!isRecord(value) || !isRecord(value.effective)) return false
  const effective = value.effective
  return (
    isNullableBoolean(value.explicit) &&
    isNullableBoolean(value.projectOverride) &&
    isNullableBoolean(value.userDefault) &&
    isOptionalBoolean(value.organizationDefault) &&
    isOptionalBoolean(value.claxedoDefault) &&
    (effective.status === "ready" || effective.status === "artifact-unavailable") &&
    typeof effective.effective === "boolean" &&
    isString(effective.winner) &&
    isOptionalString(effective.artifactDigest)
  )
}

function isIcon(value: unknown): value is PluginIcon | undefined {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  if (value.kind === "url") return isString(value.url)
  return value.kind === "monogram" && isString(value.text)
}

function isSource(value: unknown): value is PluginSource | null {
  if (value === null) return true
  return (
    isRecord(value) &&
    isString(value.id) &&
    isPluginSourceKind(value.kind) &&
    isString(value.label) &&
    isOptionalString(value.repository)
  )
}

function isToolGroups(value: unknown): value is PluginToolGroup[] | undefined {
  if (value === undefined) return true
  return (
    Array.isArray(value) &&
    value.every(
      (group) =>
        isRecord(group) &&
        isString(group.id) &&
        isString(group.pluginInstanceId) &&
        typeof group.enabled === "boolean" &&
        isStringList(group.tools),
    )
  )
}

function isSkills(value: unknown): value is PluginSkill[] {
  return (
    Array.isArray(value) &&
    value.every((skill) => isRecord(skill) && isString(skill.name) && isString(skill.description) && isString(skill.path))
  )
}

function isAuthentication(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.state === "local" || value.state === "harness" || value.state === "public") return true
  if (value.state === "unavailable") return isString(value.reason)
  return (
    value.state === "oauth" &&
    isString(value.integrationId) &&
    (value.issuers === undefined || isStringList(value.issuers))
  )
}

function isMcpServers(value: unknown): value is PluginMcpServer[] {
  return (
    Array.isArray(value) &&
    value.every(
      (server) =>
        isRecord(server) &&
        isString(server.name) &&
        (server.type === "stdio" || server.type === "streamable-http" || server.type === "sse") &&
        isAuthentication(server.authentication),
    )
  )
}

function isDiagnostics(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((item) => isRecord(item) && isString(item.code) && isString(item.path) && isString(item.message))
  )
}

function isManifest(value: unknown): boolean {
  if (value === null) return true
  return isRecord(value) && isString(value.name) && isOptionalString(value.version) && isOptionalString(value.description)
}

function candidateIdentity(value: Row): boolean {
  return (
    isString(value.pluginInstanceId) &&
    isOptionalBoolean(value.builtIn) &&
    isOptionalString(value.sourceId) &&
    (value.sourceKind === null || value.sourceKind === undefined || isPluginSourceKind(value.sourceKind)) &&
    isSource(value.source) &&
    isIcon(value.icon) &&
    (value.categories === undefined || isStringList(value.categories)) &&
    isOptionalBoolean(value.featured)
  )
}

function candidateArtifact(value: Row): boolean {
  return (
    isOptionalString(value.sourceRevision) &&
    isOptionalString(value.relativePath) &&
    isOptionalString(value.candidateDigest) &&
    typeof value.sourceAvailable === "boolean" &&
    isOptionalString(value.retainedDigest) &&
    isOptionalBoolean(value.artifactAvailable) &&
    isOptionalString(value.artifactError) &&
    typeof value.updateAvailable === "boolean"
  )
}

function isCandidate(value: unknown): value is PluginCandidate {
  if (!isRecord(value) || !candidateIdentity(value) || !candidateArtifact(value)) return false
  if (!isToolGroups(value.groups) || !isSkills(value.skills) || !isManifest(value.manifest)) return false
  if (!isDiagnostics(value.componentDiagnostics) || !isMcpServers(value.mcpServers)) return false
  const harnesses = value.harnesses
  return isRecord(harnesses) && PLUGIN_HARNESSES.every((id) => isActivation(harnesses[id]))
}

function isCatalogErrors(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (error) =>
        isRecord(error) &&
        isString(error.sourceId) &&
        isString(error.relativePath) &&
        isString(error.code) &&
        isString(error.message),
    )
  )
}

function isProjects(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every((project) => isRecord(project) && isString(project.id) && isString(project.label)))
  )
}

export function marketplaceCatalogFromWire(value: unknown): MarketplaceCatalog | undefined {
  if (!isRecord(value) || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision)) return undefined
  if (!Array.isArray(value.supportedHarnesses) || !value.supportedHarnesses.every(isHarness)) return undefined
  if (!isProjects(value.projects) || !isOptionalString(value.selectedProjectId)) return undefined
  if (!isOptionalBoolean(value.canManageOrganizationDefaults) || !isOptionalBoolean(value.canManageOrganizationConnections))
    return undefined
  if (!Array.isArray(value.candidates) || !value.candidates.every(isCandidate) || !isCatalogErrors(value.errors))
    return undefined
  return value as MarketplaceCatalog
}

export function pluginSkillFromWire(value: unknown): PluginSkillDocument | undefined {
  if (!isRecord(value) || !isString(value.name) || !isString(value.description) || !isString(value.markdown))
    return undefined
  return { name: value.name, description: value.description, markdown: value.markdown }
}
