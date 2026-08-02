
export type CatalogCategoryId =
  | "featured"
  | "skills"
  | "mcp-servers"
  | "infrastructure"
  | "data-and-analytics"
  | "productivity"
  | "agent-orchestration"

export type CatalogTarget = "claude" | "codex" | "cursor" | "opencode"

export type CatalogEntry = {
  id: string
  name: string
  description: string
  source: string
  kind: "skill" | "plugin" | "mcp" | "package"
  icon?: string
  categories: CatalogCategoryId[]
  recommendedScope: "machine" | "project" | "workspace"
  recommendedTargets: CatalogTarget[]
  featured?: boolean
  firstParty?: "claxedo"
}

export type Catalog = {
  version: 1
  categories: Array<{ id: CatalogCategoryId; label: string }>
  entries: CatalogEntry[]
}

export type InstalledRecord = {
  id: string
  package_name?: string
  scope: "machine" | "project"
  directory?: string
  enabled?: boolean
}

export type EnablementStatus = "idle" | "toggling"

// The server's discovery-state mutation endpoints: adopt persists the
// discovered config as owned, ignore records it as intentionally skipped.
// Both take `{ directory, path }` where `path` is the relative candidate
// path the scan itself reported (`scanExistingAgentExtensionConfig` ->
// `row.item.path`), so the value round-trips unchanged.
export type DiscoveredExtensionAction = "adopt" | "ignore"

export type DiscoveredExtension = {
  path: string
  kind: "harness-config-dir" | "skills-dir" | "instruction-file" | "mcp-config" | "opencode-config"
  state: "discovered" | "adopted" | "generated" | "drifted" | "ignored"
}

export type MachineHarness = "opencode" | "claude" | "codex" | "cursor" | "agents"

export type MachineDiscoveredItem = {
  id: string
  harness: MachineHarness
  name: string
  kind: "skill" | "native-plugin" | "mcp"
  path: string
}

export type InstallStatus = "idle" | "installing" | "installed" | "uninstalling" | "error"

export const KIND_LABEL: Record<CatalogEntry["kind"], string> = {
  skill: "Skill",
  plugin: "Plugin",
  mcp: "MCP",
  package: "Package",
}

export const DISCOVERY_LABEL: Record<DiscoveredExtension["kind"], string> = {
  "harness-config-dir": "Harness config",
  "skills-dir": "Skills folder",
  "instruction-file": "Instructions",
  "mcp-config": "MCP config",
  "opencode-config": "OpenCode config",
}

export const HARNESS_LABEL: Record<MachineHarness, string> = {
  opencode: "OpenCode",
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  agents: "Agents",
}

export function categoryEntries(entries: CatalogEntry[], category: CatalogCategoryId | "all") {
  if (category === "all") return entries
  return entries.filter((entry) => entry.categories.includes(category))
}

export async function responseJson(response: Response): Promise<unknown> {
  return await response.json().catch(() => undefined)
}

export function responseErrorMessage(body: unknown) {
  if (!body || typeof body !== "object" || !("error" in body)) return undefined
  if (typeof body.error === "string") return body.error
  if (body.error && typeof body.error === "object" && "message" in body.error) {
    return String(body.error.message)
  }
  return undefined
}

export async function jsonOrError(response: Response): Promise<unknown> {
  const body = await responseJson(response)
  if (response.ok) return body
  throw new Error(responseErrorMessage(body) ?? `Request failed: ${response.status}`)
}

export function catalogCategoryId(input: unknown): CatalogCategoryId | undefined {
  if (
    input === "featured" ||
    input === "skills" ||
    input === "mcp-servers" ||
    input === "infrastructure" ||
    input === "data-and-analytics" ||
    input === "productivity" ||
    input === "agent-orchestration"
  ) return input
  return undefined
}

export function catalogTarget(input: unknown): CatalogTarget | undefined {
  if (input === "claude" || input === "codex" || input === "cursor" || input === "opencode") return input
  return undefined
}

export function catalogKind(input: unknown): CatalogEntry["kind"] | undefined {
  if (input === "skill" || input === "plugin" || input === "mcp" || input === "package") return input
  return undefined
}

export function catalogScope(input: unknown): CatalogEntry["recommendedScope"] | undefined {
  if (input === "machine" || input === "project" || input === "workspace") return input
  return undefined
}

export function catalogCategoryFromJson(input: unknown) {
  if (!input || typeof input !== "object") return []
  if (!("id" in input) || !("label" in input)) return []
  const id = catalogCategoryId(input.id)
  if (!id || typeof input.label !== "string") return []
  return [{ id, label: input.label }]
}

export function catalogEntryFromJson(input: unknown): CatalogEntry[] {
  if (!input || typeof input !== "object") return []
  if (
    !("id" in input) ||
    !("name" in input) ||
    !("description" in input) ||
    !("source" in input) ||
    !("kind" in input) ||
    !("categories" in input) ||
    !("recommendedScope" in input) ||
    !("recommendedTargets" in input)
  ) return []
  if (
    typeof input.id !== "string" ||
    typeof input.name !== "string" ||
    typeof input.description !== "string" ||
    typeof input.source !== "string" ||
    !Array.isArray(input.categories) ||
    !Array.isArray(input.recommendedTargets)
  ) return []

  const kind = catalogKind(input.kind)
  const recommendedScope = catalogScope(input.recommendedScope)
  if (!kind || !recommendedScope) return []

  const entry: CatalogEntry = {
    id: input.id,
    name: input.name,
    description: input.description,
    source: input.source,
    kind,
    categories: input.categories.flatMap((item) => {
      const id = catalogCategoryId(item)
      return id ? [id] : []
    }),
    recommendedScope,
    recommendedTargets: input.recommendedTargets.flatMap((item) => {
      const target = catalogTarget(item)
      return target ? [target] : []
    }),
  }
  if ("icon" in input && typeof input.icon === "string") entry.icon = input.icon
  if ("featured" in input && input.featured === true) entry.featured = true
  if ("firstParty" in input && input.firstParty === "claxedo") entry.firstParty = "claxedo"
  return [entry]
}

export function catalogFromJson(input: unknown): Catalog {
  if (!input || typeof input !== "object") throw new Error("Invalid catalog response")
  if (
    !("version" in input) ||
    input.version !== 1 ||
    !("categories" in input) ||
    !Array.isArray(input.categories) ||
    !("entries" in input) ||
    !Array.isArray(input.entries)
  ) throw new Error("Invalid catalog response")
  return {
    version: 1,
    categories: input.categories.flatMap(catalogCategoryFromJson),
    entries: input.entries.flatMap(catalogEntryFromJson),
  }
}

export function installedRecordsFromJson(input: unknown, scope: "machine" | "project", directory: string | undefined) {
  if (!input || typeof input !== "object" || !("desired" in input)) return undefined
  const desired = input.desired
  if (!desired || typeof desired !== "object" || !("installs" in desired) || !Array.isArray(desired.installs)) return undefined
  return desired.installs.flatMap((install): InstalledRecord[] => {
    if (!install || typeof install !== "object" || !("id" in install) || typeof install.id !== "string") return []
    return [{
      id: install.id,
      ...("package_name" in install && typeof install.package_name === "string" ? { package_name: install.package_name } : {}),
      ...("enabled" in install && typeof install.enabled === "boolean" ? { enabled: install.enabled } : {}),
      scope,
      directory,
    }]
  })
}

export function discoveryKind(input: unknown): DiscoveredExtension["kind"] | undefined {
  if (input === "runner-config-dir") return "harness-config-dir"
  if (
    input === "harness-config-dir" ||
    input === "skills-dir" ||
    input === "instruction-file" ||
    input === "mcp-config" ||
    input === "opencode-config"
  ) return input
  return undefined
}

export function discoveryState(input: unknown): DiscoveredExtension["state"] | undefined {
  if (
    input === "discovered" ||
    input === "adopted" ||
    input === "generated" ||
    input === "drifted" ||
    input === "ignored"
  ) return input
  return undefined
}

export function discoveredExtensionFromJson(input: unknown): DiscoveredExtension[] {
  if (!input || typeof input !== "object") return []
  if (!("path" in input) || typeof input.path !== "string" || !("kind" in input) || !("state" in input)) return []
  const kind = discoveryKind(input.kind)
  const state = discoveryState(input.state)
  if (!kind || !state) return []
  return [{ path: input.path, kind, state }]
}

export function discoveredExtensionsFromJson(input: unknown) {
  if (!Array.isArray(input)) throw new Error("Invalid scan response")
  return input.flatMap(discoveredExtensionFromJson)
}

export function machineHarness(input: unknown): MachineHarness | undefined {
  if (input === "opencode" || input === "claude" || input === "codex" || input === "cursor" || input === "agents") return input
  return undefined
}

export function machineKind(input: unknown): MachineDiscoveredItem["kind"] | undefined {
  if (input === "skill" || input === "native-plugin" || input === "mcp") return input
  return undefined
}

export function machineItemFromJson(input: unknown): MachineDiscoveredItem[] {
  if (!input || typeof input !== "object") return []
  if (
    !("id" in input) ||
    typeof input.id !== "string" ||
    !("harness" in input) && !("runner" in input) ||
    !("name" in input) ||
    typeof input.name !== "string" ||
    !("kind" in input) ||
    !("path" in input) ||
    typeof input.path !== "string"
  ) return []
  const harness = machineHarness("harness" in input ? input.harness : input.runner)
  const kind = machineKind(input.kind)
  if (!harness || !kind) return []
  return [{ id: input.id, harness, name: input.name, kind, path: input.path }]
}

export function machineItemsFromJson(input: unknown) {
  if (!Array.isArray(input)) return undefined
  return input.flatMap(machineItemFromJson)
}

export function packageNameFromSource(source: string): string {
  const trimmed = source.trim().replace(/\/+$/, "")
  const last = trimmed.split("/").pop() ?? ""
  return last.toLowerCase()
}

export function isEntryInstalled(entry: CatalogEntry, installed: Set<string>): boolean {
  if (installed.has(entry.id)) return true
  const pkgName = packageNameFromSource(entry.source)
  return pkgName.length > 0 && installed.has(pkgName)
}

// One catalog entry can be addressed by two ids. Installs are pinned to the
// catalog id now, but the server used to key them by the fetched package's own
// manifest name / directory basename, so records persisted before the pin sit
// under the upstream name (`anthropic-skill-pdf` -> `pdf`, `mcp-filesystem` ->
// `filesystem`, `mcp-fetch` -> `fetch`). Both ids denote the same install --
// the server absorbs the legacy record on the next install/update of the same
// source -- so the client must treat them as one row, not two.
export function recordMatchesEntry(record: InstalledRecord, entry: CatalogEntry): boolean {
  if (record.id === entry.id) return true
  const pkgName = packageNameFromSource(entry.source)
  return pkgName.length > 0 && (record.id === pkgName || record.package_name === pkgName)
}

// Records live in per-scope state files, so a machine-scope install and a
// project-scope install of one entry are genuinely two installs. Only rows in
// the same scope (and, for project scope, the same directory) may be collapsed
// into each other.
export function sameInstallLocation(
  record: Pick<InstalledRecord, "scope" | "directory">,
  location: Pick<InstalledRecord, "scope" | "directory">,
): boolean {
  return record.scope === location.scope && record.directory === location.directory
}

// A record with no explicit `enabled` field is treated as enabled — the
// server only writes `enabled: false` for a deliberately-disabled install,
// and older list payloads omit the field entirely.
export function isRecordEnabled(record: Pick<InstalledRecord, "enabled">): boolean {
  return record.enabled !== false
}

// The disable/enable lifecycle is a single toggle: an enabled install's
// action is to disable it (`POST /extensions/:id/disable`) and vice versa.
// `nextEnabled` is the optimistic local state to apply once the request
// resolves.
export function enablementToggle(record: Pick<InstalledRecord, "enabled">): {
  path: "enable" | "disable"
  nextEnabled: boolean
} {
  return isRecordEnabled(record)
    ? { path: "disable", nextEnabled: false }
    : { path: "enable", nextEnabled: true }
}

// adopt -> "adopted", ignore -> "ignored". Used to optimistically project the
// discovered row's new state when the server response omits it.
export function discoveredStateForAction(action: DiscoveredExtensionAction): DiscoveredExtension["state"] {
  return action === "adopt" ? "adopted" : "ignored"
}

// Parse the discovery-state mutation response (`setDiscoveredAgentExtension
// ConfigState` returns `{ path, kind, state }`); fall back to the caller's
// intended state when the body is malformed.
export function discoveredStateFromResponse(input: unknown): DiscoveredExtension["state"] | undefined {
  if (!input || typeof input !== "object" || !("state" in input)) return undefined
  return discoveryState((input as { state: unknown }).state)
}

// Immutably project the new state onto the matching discovered row, keyed by
// the candidate path (the scan's stable identity for a row).
export function applyDiscoveredState(
  items: DiscoveredExtension[],
  path: string,
  state: DiscoveredExtension["state"],
): DiscoveredExtension[] {
  return items.map((item) => (item.path === path ? { ...item, state } : item))
}
