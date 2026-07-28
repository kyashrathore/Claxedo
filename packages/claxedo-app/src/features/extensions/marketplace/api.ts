export type CatalogCategoryId =
  | "featured"
  | "skills"
  | "mcp-servers"
  | "infrastructure"
  | "data-and-analytics"
  | "productivity"
  | "agent-orchestration"

export type CatalogTarget = "claude" | "codex" | "cursor" | "opencode"
export type ExtensionScope = "machine" | "project" | "workspace"

export type CatalogEntry = {
  id: string
  name: string
  description: string
  source: string
  kind: "skill" | "plugin" | "mcp" | "package"
  icon?: string
  categories: CatalogCategoryId[]
  recommendedScope: ExtensionScope
  recommendedTargets: CatalogTarget[]
}

export type InstalledRecord = {
  id: string
  package_name?: string
  scope: "machine" | "project"
  directory?: string
}

export type RequestFn = (input: string, init?: RequestInit) => Promise<Response>

type Catalog = {
  version: 1
  entries: CatalogEntry[]
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function catalogCategoryId(input: unknown): CatalogCategoryId | undefined {
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

function catalogTarget(input: unknown): CatalogTarget | undefined {
  if (input === "claude" || input === "codex" || input === "cursor" || input === "opencode") return input
  return undefined
}

function catalogScope(input: unknown): ExtensionScope | undefined {
  if (input === "machine" || input === "project" || input === "workspace") return input
  return undefined
}

function catalogKind(input: unknown): CatalogEntry["kind"] | undefined {
  if (input === "skill" || input === "plugin" || input === "mcp" || input === "package") return input
  return undefined
}

function catalogEntryFromJson(input: unknown): CatalogEntry[] {
  if (!isRecord(input)) return []
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

  return [{
    id: input.id,
    name: input.name,
    description: input.description,
    source: input.source,
    kind,
    ...(typeof input.icon === "string" ? { icon: input.icon } : {}),
    categories: input.categories.flatMap((item) => {
      const category = catalogCategoryId(item)
      return category ? [category] : []
    }),
    recommendedScope,
    recommendedTargets: input.recommendedTargets.flatMap((item) => {
      const target = catalogTarget(item)
      return target ? [target] : []
    }),
  }]
}

function catalogFromJson(input: unknown): Catalog {
  if (!isRecord(input) || input.version !== 1 || !Array.isArray(input.entries)) {
    throw new Error("Invalid catalog response")
  }
  return {
    version: 1,
    entries: input.entries.flatMap(catalogEntryFromJson),
  }
}

function installedRecordsFromJson(input: unknown, scope: "machine" | "project", directory?: string) {
  if (!isRecord(input) || !isRecord(input.desired) || !Array.isArray(input.desired.installs)) return []
  return input.desired.installs.flatMap((install): InstalledRecord[] => {
    if (!isRecord(install) || typeof install.id !== "string") return []
    return [{
      id: install.id,
      ...(typeof install.package_name === "string" ? { package_name: install.package_name } : {}),
      scope,
      directory,
    }]
  })
}

async function responseJson(response: Response): Promise<unknown> {
  return await response.json().catch(() => undefined)
}

function responseErrorMessage(body: unknown) {
  if (!isRecord(body) || !("error" in body)) return undefined
  if (typeof body.error === "string") return body.error
  if (isRecord(body.error) && typeof body.error.message === "string") return body.error.message
  return undefined
}

async function jsonOrError(response: Response): Promise<unknown> {
  const body = await responseJson(response)
  if (response.ok) return body
  throw new Error(responseErrorMessage(body) ?? `Request failed: ${response.status}`)
}

function packageNameFromSource(source: string) {
  const trimmed = source.trim().replace(/\/+$/, "")
  return (trimmed.split("/").at(-1) ?? "").toLowerCase()
}

export function isMcpCatalogEntry(entry: CatalogEntry) {
  return entry.kind === "mcp" || entry.categories.includes("mcp-servers")
}

export function filterMcpCatalogEntries(entries: CatalogEntry[], query: string) {
  const value = query.trim().toLowerCase()
  return entries
    .filter(isMcpCatalogEntry)
    .filter((entry) =>
      !value ||
      entry.name.toLowerCase().includes(value) ||
      entry.description.toLowerCase().includes(value) ||
      sourceLabel(entry.source).toLowerCase().includes(value)
    )
}

export function isEntryInstalled(entry: CatalogEntry, installed: InstalledRecord[]) {
  const packageName = packageNameFromSource(entry.source)
  return installed.some((record) =>
    record.id === entry.id ||
    record.id === packageName ||
    record.package_name === packageName
  )
}

export function installedRecordFor(entry: CatalogEntry, installed: InstalledRecord[]) {
  const packageName = packageNameFromSource(entry.source)
  return installed.find((record) =>
    record.id === entry.id ||
    record.id === packageName ||
    record.package_name === packageName
  )
}

export function sourceLabel(source: string) {
  try {
    const url = new URL(source)
    return url.pathname.replace(/^\/+/, "").replace(/\/tree\//, "@")
  } catch {
    return source
  }
}

export function targetLabel(targets: CatalogTarget[]) {
  if (targets.length === 0) return "No targets"
  return targets.map((item) => {
    if (item === "opencode") return "OpenCode"
    if (item === "claude") return "Claude"
    if (item === "codex") return "Codex"
    return "Cursor"
  }).join(", ")
}

export function installDisabledReasonForEntry(entry: CatalogEntry, directory?: string) {
  if (entry.recommendedScope === "project" && !directory) return "Open a project to install"
  if (entry.recommendedScope === "workspace") return "Use Marketplace for workspace installs"
  return undefined
}

export function mcpPrimaryAction(entry: CatalogEntry, installed: InstalledRecord[], directory?: string) {
  if (isEntryInstalled(entry, installed)) return { label: "Uninstall", disabled: false, kind: "uninstall" as const }
  const disabledReason = installDisabledReasonForEntry(entry, directory)
  return {
    label: disabledReason ?? "Install",
    disabled: !!disabledReason,
    kind: "install" as const,
  }
}

export function mcpExtensionUrl(apiBase: string, path = "", input?: {
  scope?: ExtensionScope
  directory?: string
  workspaceId?: string
}) {
  const suffix = path ? path.startsWith("/") ? path : `/${path}` : ""
  const url = new URL(`/api/claxedo/agent-config/extensions${suffix}`, apiBase)
  if (input?.scope) url.searchParams.set("scope", input.scope)
  if ((!input?.scope || input.scope === "project") && input?.directory) url.searchParams.set("directory", input.directory)
  if (input?.scope === "workspace" && input.workspaceId) url.searchParams.set("workspaceId", input.workspaceId)
  return url
}

export function buildMcpInstallRequest(entry: CatalogEntry, directory?: string) {
  const disabledReason = installDisabledReasonForEntry(entry, directory)
  if (disabledReason) return { disabledReason }
  return {
    scope: entry.recommendedScope,
    directory: entry.recommendedScope === "project" ? directory : undefined,
    body: {
      source: entry.source,
      scope: entry.recommendedScope,
      ...(entry.recommendedScope === "project" && directory ? { directory } : {}),
      targets: entry.recommendedTargets,
      // Pin the record to the catalog id, exactly as the marketplace panel
      // does. Omitting it lets the server fall back to a name derived from the
      // fetched package's own manifest/directory basename, so the MCP picker
      // and the marketplace panel would file the *same* catalog entry under
      // two different ids (`mcp-filesystem` here vs `filesystem` there) —
      // and `installedRecordFor`, which builds the DELETE path, would then
      // resolve whichever landed first.
      id: entry.id,
    },
  }
}

async function loadInstalledRecords(fetcher: RequestFn, apiBase: string, scope: "machine" | "project", directory?: string) {
  if (scope === "project" && !directory) return []
  const url = mcpExtensionUrl(apiBase)
  url.searchParams.set("scope", scope)
  if (scope === "project" && directory) url.searchParams.set("directory", directory)
  const response = await fetcher(url.toString(), { headers: { Accept: "application/json" } })
  if (!response.ok) return []
  return installedRecordsFromJson(await responseJson(response), scope, directory)
}

export async function loadMcpDialogData(fetcher: RequestFn, apiBase: string, directory?: string) {
  const catalog = catalogFromJson(await jsonOrError(await fetcher(mcpExtensionUrl(apiBase, "/catalog").toString(), {
    headers: { Accept: "application/json" },
  })))
  const [machine, project] = await Promise.all([
    loadInstalledRecords(fetcher, apiBase, "machine"),
    loadInstalledRecords(fetcher, apiBase, "project", directory),
  ])
  return {
    entries: filterMcpCatalogEntries(catalog.entries, ""),
    installed: [...machine, ...project],
  }
}

export async function installMcpDialogEntry(fetcher: RequestFn, apiBase: string, entry: CatalogEntry, directory?: string) {
  const installRequest = buildMcpInstallRequest(entry, directory)
  if ("disabledReason" in installRequest) return installRequest

  const url = mcpExtensionUrl(apiBase)
  url.searchParams.set("scope", installRequest.scope)
  if (installRequest.directory) url.searchParams.set("directory", installRequest.directory)
  await jsonOrError(await fetcher(url.toString(), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(installRequest.body),
  }))
  return installRequest
}

export async function uninstallMcpDialogEntry(
  fetcher: RequestFn,
  apiBase: string,
  entry: CatalogEntry,
  installed: InstalledRecord[],
) {
  const record = installedRecordFor(entry, installed)
  if (!record) return undefined

  const url = mcpExtensionUrl(apiBase, `/${encodeURIComponent(record.id)}`)
  url.searchParams.set("scope", record.scope)
  if (record.scope === "project" && record.directory) url.searchParams.set("directory", record.directory)
  await jsonOrError(await fetcher(url.toString(), { method: "DELETE", headers: { Accept: "application/json" } }))
  return record
}
