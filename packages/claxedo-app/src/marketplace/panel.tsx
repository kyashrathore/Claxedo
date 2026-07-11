/* target-layer: surfaces (marketplace) */ import { Component, createMemo, createResource, createSignal, For, onMount, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { useSDK } from "@/context/sdk"
import { mcpExtensionUrl } from "../components/dialog-select-mcp-logic"
import { getClaxedoServerUrl } from "../utils/api"
import { centralTransportForServer, unsignedLocalFetch } from "@claxedo/shell/data/transport/transport"
import { usePlatform } from "@claxedo/context/platform"
type CatalogCategoryId =
  | "featured"
  | "skills"
  | "mcp-servers"
  | "infrastructure"
  | "data-and-analytics"
  | "productivity"
  | "agent-orchestration"

type CatalogTarget = "claude" | "codex" | "cursor" | "opencode"

type CatalogEntry = {
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

type Catalog = {
  version: 1
  categories: Array<{ id: CatalogCategoryId; label: string }>
  entries: CatalogEntry[]
}

type InstalledRecord = {
  id: string
  package_name?: string
  scope: "machine" | "project"
  directory?: string
}

type DiscoveredExtension = {
  path: string
  kind: "harness-config-dir" | "skills-dir" | "instruction-file" | "mcp-config" | "opencode-config"
  state: "discovered" | "adopted" | "generated" | "drifted" | "ignored"
}

type MachineHarness = "opencode" | "claude" | "codex" | "cursor" | "agents"

type MachineDiscoveredItem = {
  id: string
  harness: MachineHarness
  name: string
  kind: "skill" | "native-plugin" | "mcp"
  path: string
}

type InstallStatus = "idle" | "installing" | "installed" | "uninstalling" | "error"

const KIND_LABEL: Record<CatalogEntry["kind"], string> = {
  skill: "Skill",
  plugin: "Plugin",
  mcp: "MCP",
  package: "Package",
}

const DISCOVERY_LABEL: Record<DiscoveredExtension["kind"], string> = {
  "harness-config-dir": "Harness config",
  "skills-dir": "Skills folder",
  "instruction-file": "Instructions",
  "mcp-config": "MCP config",
  "opencode-config": "OpenCode config",
}

function categoryEntries(entries: CatalogEntry[], category: CatalogCategoryId | "all") {
  if (category === "all") return entries
  return entries.filter((entry) => entry.categories.includes(category))
}

async function responseJson(response: Response): Promise<unknown> {
  return await response.json().catch(() => undefined)
}

function responseErrorMessage(body: unknown) {
  if (!body || typeof body !== "object" || !("error" in body)) return undefined
  if (typeof body.error === "string") return body.error
  if (body.error && typeof body.error === "object" && "message" in body.error) {
    return String(body.error.message)
  }
  return undefined
}

async function jsonOrError(response: Response): Promise<unknown> {
  const body = await responseJson(response)
  if (response.ok) return body
  throw new Error(responseErrorMessage(body) ?? `Request failed: ${response.status}`)
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

function catalogKind(input: unknown): CatalogEntry["kind"] | undefined {
  if (input === "skill" || input === "plugin" || input === "mcp" || input === "package") return input
  return undefined
}

function catalogScope(input: unknown): CatalogEntry["recommendedScope"] | undefined {
  if (input === "machine" || input === "project" || input === "workspace") return input
  return undefined
}

function catalogCategoryFromJson(input: unknown) {
  if (!input || typeof input !== "object") return []
  if (!("id" in input) || !("label" in input)) return []
  const id = catalogCategoryId(input.id)
  if (!id || typeof input.label !== "string") return []
  return [{ id, label: input.label }]
}

function catalogEntryFromJson(input: unknown): CatalogEntry[] {
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

function catalogFromJson(input: unknown): Catalog {
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

function installedRecordsFromJson(input: unknown, scope: "machine" | "project", directory: string | undefined) {
  if (!input || typeof input !== "object" || !("desired" in input)) return undefined
  const desired = input.desired
  if (!desired || typeof desired !== "object" || !("installs" in desired) || !Array.isArray(desired.installs)) return undefined
  return desired.installs.flatMap((install): InstalledRecord[] => {
    if (!install || typeof install !== "object" || !("id" in install) || typeof install.id !== "string") return []
    return [{
      id: install.id,
      ...("package_name" in install && typeof install.package_name === "string" ? { package_name: install.package_name } : {}),
      scope,
      directory,
    }]
  })
}

function discoveryKind(input: unknown): DiscoveredExtension["kind"] | undefined {
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

function discoveryState(input: unknown): DiscoveredExtension["state"] | undefined {
  if (
    input === "discovered" ||
    input === "adopted" ||
    input === "generated" ||
    input === "drifted" ||
    input === "ignored"
  ) return input
  return undefined
}

function discoveredExtensionFromJson(input: unknown): DiscoveredExtension[] {
  if (!input || typeof input !== "object") return []
  if (!("path" in input) || typeof input.path !== "string" || !("kind" in input) || !("state" in input)) return []
  const kind = discoveryKind(input.kind)
  const state = discoveryState(input.state)
  if (!kind || !state) return []
  return [{ path: input.path, kind, state }]
}

function discoveredExtensionsFromJson(input: unknown) {
  if (!Array.isArray(input)) throw new Error("Invalid scan response")
  return input.flatMap(discoveredExtensionFromJson)
}

function machineHarness(input: unknown): MachineHarness | undefined {
  if (input === "opencode" || input === "claude" || input === "codex" || input === "cursor" || input === "agents") return input
  return undefined
}

function machineKind(input: unknown): MachineDiscoveredItem["kind"] | undefined {
  if (input === "skill" || input === "native-plugin" || input === "mcp") return input
  return undefined
}

function machineItemFromJson(input: unknown): MachineDiscoveredItem[] {
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

function machineItemsFromJson(input: unknown) {
  if (!Array.isArray(input)) return undefined
  return input.flatMap(machineItemFromJson)
}

export const MarketplacePanel: Component = () => {
  const platform = usePlatform()
  let sdkRef: ReturnType<typeof useSDK> | undefined
  try {
    sdkRef = useSDK()
  } catch {
    /* Marketplace can render without an active workspace. */
  }

  // Agent-config / extensions routes live on claxedo-server,
  // NOT on workspace-runtime. The previous `useGlobalSDK().url` is
  // normalized to the workspace-runtime port (4096) by
  // `normalizeServerUrl`, so building catalog URLs against it produced
  // 404s for every marketplace request. Use the dedicated claxedo-server
  // URL helper instead, which respects VITE_CLAXEDO_SERVER_URL and
  // falls back to 127.0.0.1:3001.
  const apiBase = () => getClaxedoServerUrl()
  const fetchFn = platform.fetch ?? globalThis.fetch
  // Rubric Q4: replace the URL-shape-inferred `claxedoServerFetch` with an
  // explicit branch on loopback. Loopback Claxedo server bypasses the bearer
  // (`unsignedLocalFetch`); remote control plane uses the signed fetch.
  const localRequest = (): typeof fetch =>
    centralTransportForServer(apiBase()) === "loopback"
      ? unsignedLocalFetch
      : fetchFn
  const extensionUrl = (
    path = "",
    input?: {
      scope?: "machine" | "project" | "workspace"
      directory?: string
      workspaceId?: string
    },
  ) => mcpExtensionUrl(apiBase(), path, input)

  const [activeCategory, setActiveCategory] = createSignal<CatalogCategoryId | "all" | "installed" | "on-machine">("featured")
  const [search, setSearch] = createSignal("")
  const [installState, setInstallState] = createSignal<Record<string, InstallStatus>>({})
  const [installedRecords, setInstalledRecords] = createSignal<InstalledRecord[]>([])
  const [discovered, setDiscovered] = createSignal<DiscoveredExtension[]>([])
  const [machineItems, setMachineItems] = createSignal<MachineDiscoveredItem[]>([])
  const [scanLoading, setScanLoading] = createSignal(false)
  const [machineDeleting, setMachineDeleting] = createSignal<Record<string, boolean>>({})

  const installedIds = createMemo(() => {
    const set = new Set<string>()
    for (const record of installedRecords()) {
      set.add(record.id)
      if (record.package_name) set.add(record.package_name)
    }
    for (const item of machineItems()) set.add(item.name)
    return set
  })

  const findInstalledRecord = (entry: CatalogEntry): InstalledRecord | undefined => {
    const records = installedRecords()
    const pkg = packageNameFromSource(entry.source)
    return records.find((r) => r.id === entry.id || r.id === pkg || r.package_name === pkg)
  }

  const setStatus = (id: string, status: InstallStatus) =>
    setInstallState((prev) => ({ ...prev, [id]: status }))

  const [catalog] = createResource(async () => {
    const url = extensionUrl("/catalog")
    const res = await localRequest()(url.toString(), { headers: { Accept: "application/json" } })
    return catalogFromJson(await jsonOrError(res))
  })

  const loadInstalled = async (scope: "machine" | "project") => {
    try {
      let directory: string | undefined
      if (scope === "project") {
        directory = sdkRef?.directory
        if (!directory) return
      }
      const url = extensionUrl("", { scope, directory })
      const res = await localRequest()(url.toString(), { headers: { Accept: "application/json" } })
      if (!res.ok) return
      const added = installedRecordsFromJson(await responseJson(res), scope, directory)
      if (!added) return
      setInstalledRecords((prev) => {
        const filtered = prev.filter((r) =>
          scope === "machine" ? r.scope !== "machine" : r.scope !== "project" || r.directory !== directory,
        )
        return [...filtered, ...added]
      })
    } catch {
      /* non-fatal */
    }
  }

  function packageNameFromSource(source: string): string {
    const trimmed = source.trim().replace(/\/+$/, "")
    const last = trimmed.split("/").pop() ?? ""
    return last.toLowerCase()
  }

  function isEntryInstalled(entry: CatalogEntry, installed: Set<string>): boolean {
    if (installed.has(entry.id)) return true
    const pkgName = packageNameFromSource(entry.source)
    return pkgName.length > 0 && installed.has(pkgName)
  }

  const scanLocal = async () => {
    const dir = sdkRef?.directory
    if (!dir) {
      showToast({ title: "Open a project to scan for existing config", variant: "default", duration: 4000 })
      return
    }
    setScanLoading(true)
    try {
      const url = extensionUrl("/scan", { directory: dir })
      const res = await localRequest()(url.toString(), { headers: { Accept: "application/json" } })
      const result = discoveredExtensionsFromJson(await jsonOrError(res))
      setDiscovered(result)
      if (result.length === 0) {
        showToast({ title: "No existing agent config found in this project.", variant: "default", duration: 3000 })
      } else {
        showToast({ title: `Detected ${result.length} existing item${result.length === 1 ? "" : "s"} in this project.`, variant: "success", duration: 3000 })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: "Failed to scan", description: message, variant: "error", duration: 5000 })
    } finally {
      setScanLoading(false)
    }
  }

  const loadMachineItems = async () => {
    try {
      const url = extensionUrl("/machine-scan")
      const res = await localRequest()(url.toString(), { headers: { Accept: "application/json" } })
      if (!res.ok) return
      const items = machineItemsFromJson(await responseJson(res))
      if (!items) return
      setMachineItems(items)
    } catch {
      /* non-fatal */
    }
  }

  onMount(async () => {
    await loadInstalled("machine")
    await loadInstalled("project")
    await loadMachineItems()
  })

  const visibleEntries = createMemo(() => {
    const list = catalog()?.entries ?? []
    const cat = activeCategory()
    let filtered: CatalogEntry[]
    if (cat === "installed") {
      const ids = installedIds()
      filtered = list.filter((entry) => isEntryInstalled(entry, ids))
    } else if (cat === "on-machine") {
      filtered = []
    } else {
      filtered = categoryEntries(list, cat)
    }
    const query = search().trim().toLowerCase()
    if (!query) return filtered
    return filtered.filter((entry) =>
      entry.name.toLowerCase().includes(query)
      || entry.description.toLowerCase().includes(query)
      || entry.kind.toLowerCase().includes(query),
    )
  })

  const featuredEntries = createMemo(() =>
    (catalog()?.entries ?? []).filter((entry) => entry.featured),
  )

  const filteredMachineItems = createMemo(() => {
    const list = machineItems()
    const query = search().trim().toLowerCase()
    if (!query) return list
    return list.filter((item) =>
      item.name.toLowerCase().includes(query)
      || item.harness.toLowerCase().includes(query)
      || item.path.toLowerCase().includes(query),
    )
  })

  const showFeaturedRow = createMemo(() => activeCategory() === "featured" && !search().trim())

  const install = async (entry: CatalogEntry) => {
    if (installState()[entry.id] === "installing") return
    setStatus(entry.id, "installing")
    try {
      let directory: string | undefined
      if (entry.recommendedScope === "project") {
        directory = sdkRef?.directory
        if (!directory) throw new Error("Open a project directory to install at project scope")
      }
      const url = extensionUrl("", {
        scope: entry.recommendedScope,
        directory,
      })
      const res = await localRequest()(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          source: entry.source,
          scope: entry.recommendedScope,
          targets: entry.recommendedTargets,
        }),
      })
      await jsonOrError(res)
      setStatus(entry.id, "installed")
      const dir = entry.recommendedScope === "project" ? sdkRef?.directory : undefined
      setInstalledRecords((prev) => [
        ...prev,
        {
          id: entry.id,
          package_name: packageNameFromSource(entry.source) || undefined,
          scope: entry.recommendedScope === "workspace" ? "machine" : entry.recommendedScope,
          directory: dir,
        },
      ])
      showToast({ title: `${entry.name} installed`, variant: "success", duration: 3000 })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setStatus(entry.id, "error")
      showToast({ title: `Failed to install ${entry.name}`, description: message, variant: "error", duration: 5000 })
      setTimeout(() => setStatus(entry.id, "idle"), 2000)
    }
  }

  const uninstall = async (entry: CatalogEntry) => {
    const record = findInstalledRecord(entry)
    if (!record) {
      showToast({ title: `Not installed (no record found)`, variant: "default", duration: 3000 })
      return
    }
    if (!confirm(`Uninstall ${entry.name}? This removes its config and materialized files.`)) return
    setStatus(entry.id, "uninstalling")
    try {
      const url = extensionUrl(`/${encodeURIComponent(record.id)}`, {
        scope: record.scope,
        directory: record.directory,
      })
      const res = await localRequest()(url.toString(), {
        method: "DELETE",
        headers: { Accept: "application/json" },
      })
      await jsonOrError(res)
      setInstalledRecords((prev) => prev.filter((r) => r !== record))
      setStatus(entry.id, "idle")
      showToast({ title: `${entry.name} uninstalled`, variant: "success", duration: 3000 })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setStatus(entry.id, "error")
      showToast({ title: `Failed to uninstall ${entry.name}`, description: message, variant: "error", duration: 5000 })
      setTimeout(() => setStatus(entry.id, "idle"), 2000)
    }
  }

  const deleteMachineItem = async (item: MachineDiscoveredItem) => {
    const key = `${item.harness}/${item.kind}/${item.name}`
    if (machineDeleting()[key]) return
    if (!confirm(`Delete ${item.path}?\n\nThis permanently removes the folder from disk.`)) return
    setMachineDeleting((prev) => ({ ...prev, [key]: true }))
    try {
      const url = extensionUrl(
        `/machine-scan/${encodeURIComponent(item.harness)}/${encodeURIComponent(item.kind)}/${encodeURIComponent(item.name)}`,
      )
      const res = await localRequest()(url.toString(), {
        method: "DELETE",
        headers: { Accept: "application/json" },
      })
      await jsonOrError(res)
      setMachineItems((prev) => prev.filter((i) => !(i.harness === item.harness && i.kind === item.kind && i.name === item.name)))
      showToast({ title: `Deleted ${item.name}`, variant: "success", duration: 3000 })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: `Failed to delete ${item.name}`, description: message, variant: "error", duration: 5000 })
    } finally {
      setMachineDeleting((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
    }
  }

  return (
    <div class="flex h-full min-h-0 bg-background-base">
      <div class="mx-auto flex min-h-0 w-full max-w-[1080px] gap-10 px-8 lg:px-12">
        <aside class="sticky top-0 hidden h-full w-[180px] shrink-0 flex-col gap-0.5 self-start overflow-y-auto pt-12 pb-12 md:flex">
          <div class="mb-3 px-2 text-[12px] font-medium text-text-weak">Marketplace</div>
          <CategoryButton
            label="Featured"
            active={activeCategory() === "featured"}
            onClick={() => setActiveCategory("featured")}
          />
          <CategoryButton
            label="All Extensions"
            active={activeCategory() === "all"}
            onClick={() => setActiveCategory("all")}
          />
          <CategoryButton
            label="Installed"
            active={activeCategory() === "installed"}
            count={(catalog()?.entries ?? []).filter((entry) => isEntryInstalled(entry, installedIds())).length}
            onClick={() => setActiveCategory("installed")}
          />
          <CategoryButton
            label="On this machine"
            active={activeCategory() === "on-machine"}
            count={machineItems().length}
            onClick={() => setActiveCategory("on-machine")}
          />
          <div class="my-3 h-px bg-border-weak-base/20" />
          <For each={(catalog()?.categories ?? []).filter((c) => c.id !== "featured")}>
            {(cat) => (
              <CategoryButton
                label={cat.label}
                active={activeCategory() === cat.id}
                onClick={() => setActiveCategory(cat.id)}
              />
            )}
          </For>
          <div class="my-3 h-px bg-border-weak-base/20" />
          <button
            type="button"
            class="group flex h-7 items-center gap-1.5 rounded px-2 text-left text-[12px] text-text-weak transition-colors hover:text-text-base disabled:opacity-50"
            onClick={scanLocal}
            disabled={scanLoading()}
            title={sdkRef?.directory ? `Scan ${sdkRef.directory} for existing config` : "Open a project to enable scan"}
          >
            <Icon name={scanLoading() ? "dot-grid" : "magnifying-glass"} size="small" class={scanLoading() ? "animate-spin" : ""} />
            <span>{scanLoading() ? "Scanning…" : "Detect existing"}</span>
          </button>
        </aside>

        <main class="flex min-h-0 min-w-0 flex-1 flex-col gap-6 overflow-y-auto pt-12 pb-16">
          <label class="flex min-h-11 items-center gap-2.5 rounded-lg border border-border-weak-base/40 bg-surface-raised-base/20 px-3.5 transition-colors focus-within:border-border-weak-base/80">
            <Icon name="magnifying-glass" size="small" class="text-icon-weak-base" />
            <input
              class="min-w-0 flex-1 bg-transparent text-[13px] text-text-base outline-none placeholder:text-text-weaker"
              placeholder="Search skills, plugins, MCPs…"
              value={search()}
              onInput={(event) => setSearch(event.currentTarget.value)}
            />
            <Show when={search()}>
              <button
                type="button"
                class="flex size-5 items-center justify-center rounded text-icon-weak-base transition-colors hover:text-icon-base"
                onClick={() => setSearch("")}
                aria-label="Clear search"
              >
                <Icon name="close-small" size="small" />
              </button>
            </Show>
          </label>

          <div class="flex flex-col gap-8">
            <Show when={discovered().length > 0}>
              <DiscoveredSection items={discovered()} onDismiss={() => setDiscovered([])} />
            </Show>

            <Show when={catalog.loading}>
              <div class="grid place-items-center py-24 text-text-weak">
                <span class="text-[12px]">Loading marketplace…</span>
              </div>
            </Show>
            <Show when={catalog.error}>
              <div class="grid place-items-center py-24 text-text-weak">
                <span class="text-[12px]">Failed to load catalog. {String(catalog.error)}</span>
              </div>
            </Show>

            <Show when={catalog() && !catalog.loading}>
              <Show when={showFeaturedRow()}>
                <section class="flex flex-col gap-2.5">
                  <div class="flex items-baseline justify-between">
                    <h2 class="text-[13px] font-semibold tracking-tight text-text-strong">Featured</h2>
                    <span class="text-[11px] text-text-weaker">Hand-picked to start with.</span>
                  </div>
                  <div class="grid grid-cols-1 gap-2 lg:grid-cols-2">
                    <For each={featuredEntries()}>
                      {(entry) => (
                        <ExtensionCard
                          entry={entry}
                          installed={isEntryInstalled(entry, installedIds())}
                          status={installState()[entry.id] ?? "idle"}
                          onInstall={() => install(entry)}
                          onUninstall={() => uninstall(entry)}
                        />
                      )}
                    </For>
                  </div>
                </section>
              </Show>

              <Show when={!showFeaturedRow() && activeCategory() !== "on-machine"}>
                <section class="flex flex-col gap-2.5">
                  <div class="flex items-baseline justify-between">
                    <h2 class="text-[13px] font-semibold tracking-tight text-text-strong">
                      {sectionTitle(activeCategory(), catalog()?.categories ?? [])}
                    </h2>
                    <span class="text-[11px] text-text-weaker">
                      {visibleEntries().length} {visibleEntries().length === 1 ? "extension" : "extensions"}
                    </span>
                  </div>
                  <Show
                    when={visibleEntries().length > 0}
                    fallback={
                      <div class="grid place-items-center rounded-md border border-dashed border-border-weak-base/40 px-6 py-12 text-text-weak">
                        <span class="text-[12px]">
                          {activeCategory() === "installed"
                            ? "No extensions installed yet. Pick one above."
                            : "No extensions match this view."}
                        </span>
                      </div>
                    }
                  >
                    <div class="grid grid-cols-1 gap-2 lg:grid-cols-2">
                      <For each={visibleEntries()}>
                        {(entry) => (
                          <ExtensionCard
                            entry={entry}
                            installed={isEntryInstalled(entry, installedIds())}
                            status={installState()[entry.id] ?? "idle"}
                            onInstall={() => install(entry)}
                            onUninstall={() => uninstall(entry)}
                          />
                        )}
                      </For>
                    </div>
                  </Show>
                </section>
              </Show>

              <Show when={activeCategory() === "on-machine"}>
                <MachineSection
                  items={filteredMachineItems()}
                  totalCount={machineItems().length}
                  search={search()}
                  onDelete={deleteMachineItem}
                  deleting={machineDeleting()}
                />
              </Show>

              <Show when={showFeaturedRow()}>
                <section class="flex flex-col gap-2.5">
                  <div class="flex items-baseline justify-between">
                    <h2 class="text-[13px] font-semibold tracking-tight text-text-strong">More extensions</h2>
                    <button
                      type="button"
                      class="text-[11px] text-text-weak underline-offset-2 hover:text-text-base hover:underline"
                      onClick={() => setActiveCategory("all")}
                    >
                      Browse all →
                    </button>
                  </div>
                  <div class="grid grid-cols-1 gap-2 lg:grid-cols-2">
                    <For each={(catalog()?.entries ?? []).filter((entry) => !entry.featured).slice(0, 8)}>
                      {(entry) => (
                        <ExtensionCard
                          entry={entry}
                          installed={isEntryInstalled(entry, installedIds())}
                          status={installState()[entry.id] ?? "idle"}
                          onInstall={() => install(entry)}
                          onUninstall={() => uninstall(entry)}
                        />
                      )}
                    </For>
                  </div>
                </section>
              </Show>
            </Show>
          </div>
        </main>
      </div>
    </div>
  )
}

function sectionTitle(active: CatalogCategoryId | "all" | "installed" | "on-machine", categories: Catalog["categories"]) {
  if (active === "all") return "All Extensions"
  if (active === "installed") return "Installed"
  if (active === "on-machine") return "On this machine"
  return categories.find((c) => c.id === active)?.label ?? "Extensions"
}

const HARNESS_LABEL: Record<MachineHarness, string> = {
  opencode: "OpenCode",
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  agents: "Agents",
}

const MachineSection: Component<{
  items: MachineDiscoveredItem[]
  totalCount: number
  search: string
  onDelete: (item: MachineDiscoveredItem) => void
  deleting: Record<string, boolean>
}> = (props) => {
  const grouped = createMemo(() => {
    const buckets = new Map<MachineHarness, MachineDiscoveredItem[]>()
    for (const item of props.items) {
      const list = buckets.get(item.harness) ?? []
      list.push(item)
      buckets.set(item.harness, list)
    }
    return [...buckets.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
  })

  return (
    <section class="flex flex-col gap-4">
      <div class="flex items-baseline justify-between">
        <div class="flex flex-col">
          <h2 class="text-[13px] font-semibold tracking-tight text-text-strong">On this machine</h2>
          <p class="text-[11px] text-text-weaker">
            {props.search
              ? `${props.items.length} of ${props.totalCount} matching "${props.search}"`
              : `${props.totalCount} skill${props.totalCount === 1 ? "" : "s"} and plugins discovered across Claude, Codex, Cursor, and Agents.`}
          </p>
        </div>
      </div>
      <Show
        when={props.items.length > 0}
        fallback={
          <div class="grid place-items-center rounded-md border border-dashed border-border-weak-base/40 px-6 py-12 text-text-weak">
            <span class="text-[12px]">
              {props.search ? "No machine items match the search." : "No skills detected under ~/.claude, ~/.codex, ~/.cursor, or ~/.agents."}
            </span>
          </div>
        }
      >
        <For each={grouped()}>
          {([harness, items]) => (
            <div class="flex flex-col gap-2">
              <div class="flex items-baseline gap-2 px-1">
                <h3 class="text-[12px] font-medium text-text-base">{HARNESS_LABEL[harness]}</h3>
                <span class="text-[10px] text-text-weaker">{items.length}</span>
              </div>
              <div class="grid grid-cols-1 gap-1 lg:grid-cols-2">
                <For each={items}>
                  {(item) => (
                    <MachineCard
                      item={item}
                      onDelete={() => props.onDelete(item)}
                      deleting={props.deleting[`${item.harness}/${item.kind}/${item.name}`] ?? false}
                    />
                  )}
                </For>
              </div>
            </div>
          )}
        </For>
      </Show>
    </section>
  )
}

const MachineCard: Component<{
  item: MachineDiscoveredItem
  onDelete: () => void
  deleting: boolean
}> = (props) => {
  const shortPath = createMemo(() => {
    const home = props.item.path
    return home.replace(/^\/Users\/[^/]+/, "~")
  })
  return (
    <div class="group/machine relative flex items-center gap-3 rounded-md border border-border-weak-base/30 bg-surface-raised-base/20 px-3 py-2.5 transition-colors hover:border-border-weak-base/60 hover:bg-surface-raised-base/40">
      <div class="grid size-7 shrink-0 place-items-center rounded bg-surface-base text-[12px] text-text-weak">
        {props.item.kind === "skill" ? "📘" : props.item.kind === "mcp" ? "🔌" : "🧩"}
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-baseline gap-2">
          <span class="truncate text-[12px] font-medium text-text-strong">{props.item.name}</span>
          <span class="shrink-0 rounded bg-surface-base px-1.5 py-px text-[9px] uppercase tracking-wider text-text-weak">
            {props.item.kind === "native-plugin" ? "Plugin" : props.item.kind === "mcp" ? "MCP" : "Skill"}
          </span>
        </div>
        <div class="mt-0.5 truncate font-mono text-[10px] text-text-weaker">{shortPath()}</div>
      </div>
      <span class="flex h-6 shrink-0 items-center gap-1 rounded border border-border-weak-base/40 bg-surface-base px-1.5 text-[10px] font-medium text-text-weak group-hover/machine:hidden">
        <Icon name="check-small" size="small" class="text-icon-success-base" />
        Local
      </span>
      <button
        type="button"
        class="hidden h-6 shrink-0 items-center gap-1 rounded border border-border-weak-base/40 bg-surface-base px-1.5 text-[10px] font-medium text-text-weak transition-colors hover:border-border-critical-base hover:bg-surface-critical-base/10 hover:text-text-on-critical-base disabled:opacity-60 group-hover/machine:flex"
        onClick={(event) => {
          event.stopPropagation()
          props.onDelete()
        }}
        disabled={props.deleting}
        title={`Delete ${props.item.path} from disk`}
      >
        <Icon name={props.deleting ? "dot-grid" : "trash"} size="small" class={props.deleting ? "animate-spin" : ""} />
        {props.deleting ? "Deleting…" : "Delete"}
      </button>
    </div>
  )
}

const CategoryButton: Component<{
  label: string
  active: boolean
  count?: number
  onClick: () => void
}> = (props) => (
  <button
    type="button"
    class="flex h-7 items-center justify-between rounded px-2 text-left text-[12px] transition-colors"
    classList={{
      "text-text-strong font-medium": props.active,
      "text-text-weak hover:text-text-base": !props.active,
    }}
    onClick={props.onClick}
  >
    <span>{props.label}</span>
    <Show when={typeof props.count === "number" && props.count > 0}>
      <span class="text-[10px] tabular-nums text-text-weaker">{props.count}</span>
    </Show>
  </button>
)

const DiscoveredSection: Component<{
  items: DiscoveredExtension[]
  onDismiss: () => void
}> = (props) => (
  <section class="mb-6 flex flex-col gap-2 rounded-md border border-border-weak-base/40 bg-surface-raised-base/30 px-4 py-3">
    <div class="flex items-baseline justify-between">
      <div class="flex flex-col">
        <h2 class="text-[13px] font-semibold tracking-tight text-text-strong">Already on this machine</h2>
        <p class="text-[11px] text-text-weaker">{props.items.length} item{props.items.length === 1 ? "" : "s"} detected in the active project.</p>
      </div>
      <button
        type="button"
        class="text-[11px] text-text-weak hover:text-text-base"
        onClick={props.onDismiss}
      >
        Dismiss
      </button>
    </div>
    <ul class="flex flex-col gap-1 pt-1">
      <For each={props.items}>
        {(item) => (
          <li class="flex items-center justify-between gap-3 rounded px-2 py-1.5 text-[12px] hover:bg-surface-base-hover/40">
            <div class="min-w-0 truncate font-mono text-text-base">{item.path}</div>
            <div class="flex shrink-0 items-center gap-2 text-[10px] text-text-weak">
              <span class="rounded bg-surface-base px-1.5 py-0.5 uppercase tracking-wider">{DISCOVERY_LABEL[item.kind]}</span>
              <span>{item.state}</span>
            </div>
          </li>
        )}
      </For>
    </ul>
  </section>
)

const ExtensionCard: Component<{
  entry: CatalogEntry
  installed: boolean
  status: InstallStatus
  onInstall: () => void
  onUninstall: () => void
}> = (props) => {
  const scopeLabel = createMemo(() => {
    if (props.entry.recommendedScope === "machine") return "Machine"
    if (props.entry.recommendedScope === "project") return "Project"
    return "Cloud"
  })
  const sourceLabel = createMemo(() => {
    const value = props.entry.source
    if (value.startsWith("https://github.com/")) {
      return value.slice("https://github.com/".length)
    }
    return value
  })

  return (
    <div class="group flex items-start gap-3 rounded-md border border-border-weak-base/30 bg-surface-raised-base/20 px-3.5 py-3 transition-colors hover:border-border-weak-base/70 hover:bg-surface-raised-base/50">
      <div class="grid size-9 shrink-0 place-items-center rounded-md bg-surface-base text-[16px]">
        <Show
          when={props.entry.icon}
          fallback={
            // 4-square fallback icon for marketplace entries without package icons.
            // Matches the sidebar entry's grid-4 mark so the marketplace
            // brand is visually consistent across surfaces.
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="size-4 text-icon-weak-base"
              aria-hidden="true"
            >
              <rect x="3" y="3" width="7" height="7" rx="1.25" />
              <rect x="14" y="3" width="7" height="7" rx="1.25" />
              <rect x="3" y="14" width="7" height="7" rx="1.25" />
              <rect x="14" y="14" width="7" height="7" rx="1.25" />
            </svg>
          }
        >
          <span aria-hidden="true">{props.entry.icon}</span>
        </Show>
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-baseline justify-between gap-3">
          <div class="min-w-0 flex-1">
            <div class="flex items-baseline gap-2">
              <span class="truncate text-[13px] font-medium text-text-strong">{props.entry.name}</span>
              <span class="shrink-0 rounded bg-surface-base px-1.5 py-px text-[9px] uppercase tracking-wider text-text-weak">
                {KIND_LABEL[props.entry.kind]}
              </span>
            </div>
            <div class="mt-0.5 line-clamp-1 text-[12px] text-text-weak">{props.entry.description}</div>
          </div>
          <InstallButton
            installed={props.installed}
            status={props.status}
            onClick={props.onInstall}
            onUninstall={props.onUninstall}
          />
        </div>
        <div class="mt-1.5 flex items-center gap-1.5 text-[10px] text-text-weaker">
          <span>{scopeLabel()}</span>
          <span class="text-text-weaker/60">·</span>
          <span class="truncate font-mono">{sourceLabel()}</span>
        </div>
      </div>
    </div>
  )
}

const InstallButton: Component<{
  installed: boolean
  status: InstallStatus
  onClick: () => void
  onUninstall: () => void
}> = (props) => {
  const isInstalled = () => props.installed || props.status === "installed"
  const isInstalling = () => props.status === "installing"
  const isUninstalling = () => props.status === "uninstalling"

  return (
    <Show
      when={!isInstalled()}
      fallback={
        <div class="group/install relative flex shrink-0">
          <span class="flex h-7 items-center gap-1 rounded-md border border-border-weak-base/40 bg-surface-base px-2 text-[11px] font-medium text-text-base group-hover/install:hidden">
            <Icon name="check-small" size="small" class="text-icon-success-base" />
            {isUninstalling() ? "Removing…" : "Installed"}
          </span>
          <button
            type="button"
            class="hidden h-7 items-center gap-1 rounded-md border border-border-weak-base/40 bg-surface-base px-2 text-[11px] font-medium text-text-base transition-colors hover:border-border-critical-base hover:bg-surface-critical-base/10 hover:text-text-on-critical-base disabled:opacity-60 group-hover/install:flex"
            onClick={(event) => {
              event.stopPropagation()
              props.onUninstall()
            }}
            disabled={isUninstalling()}
            title="Uninstall this extension"
          >
            <Icon name={isUninstalling() ? "dot-grid" : "trash"} size="small" class={isUninstalling() ? "animate-spin" : ""} />
            {isUninstalling() ? "Removing…" : "Uninstall"}
          </button>
        </div>
      }
    >
      <button
        type="button"
        class="h-7 shrink-0 rounded-md border border-border-weak-base/40 bg-surface-base px-3 text-[11px] font-medium text-text-base outline-none transition-colors hover:border-border-weak-base/80 hover:bg-surface-base-hover focus:outline-none disabled:opacity-60"
        onClick={(event) => {
          event.stopPropagation()
          props.onClick()
        }}
        disabled={isInstalling()}
      >
        {isInstalling() ? "Installing…" : "Install"}
      </button>
    </Show>
  )
}
