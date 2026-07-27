import { Component, createMemo, createResource, createSignal, For, onMount, Show } from "solid-js"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { showToast } from "@opencode-ai/ui/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { requestMarketplaceConfirm } from "./confirm-dialog"
import { mcpExtensionUrl } from "./api"
import { getClaxedoServerUrl } from "@/platform/api/api"
import { centralTransportForServer, unsignedLocalFetch } from "@/platform/runtime/transport"
import {
  applyDiscoveredState,
  categoryEntries,
  catalogFromJson,
  discoveredExtensionsFromJson,
  discoveredStateForAction,
  discoveredStateFromResponse,
  enablementToggle,
  installedRecordsFromJson,
  isEntryInstalled,
  isRecordEnabled,
  jsonOrError,
  machineItemsFromJson,
  packageNameFromSource,
  responseJson,
  type CatalogCategoryId,
  type CatalogEntry,
  type DiscoveredExtension,
  type DiscoveredExtensionAction,
  type EnablementStatus,
  type InstalledRecord,
  type InstallStatus,
  type MachineDiscoveredItem,
} from "./install-flow"
import { CategoryButton, sectionTitle } from "./filters"
import { DiscoveredSection, ExtensionCard, MachineSection } from "./cards"
import "./marketplace.css"

export const MarketplacePanel: Component<{ directory?: string; request?: typeof fetch }> = (props) => {
  const dialog = useDialog()

  // Agent-config / extensions routes live on claxedo-server,
  // NOT on workspace-runtime. The previous `useGlobalSDK().url` is
  // normalized to the workspace-runtime port (4096) by
  // `normalizeServerUrl`, so building catalog URLs against it produced
  // 404s for every marketplace request. Use the dedicated claxedo-server
  // URL helper instead, which respects VITE_CLAXEDO_SERVER_URL and
  // falls back to 127.0.0.1:3001.
  const apiBase = () => getClaxedoServerUrl()
  const fetchFn = props.request ?? globalThis.fetch
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
  const [enablementState, setEnablementState] = createSignal<Record<string, EnablementStatus>>({})
  const [discoveredPending, setDiscoveredPending] = createSignal<Record<string, DiscoveredExtensionAction>>({})

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

  // Effective enabled state for a card: a disabled install carries
  // `enabled: false`; everything else (including not-yet-loaded records) is
  // treated as enabled.
  const entryEnabled = (entry: CatalogEntry): boolean => {
    const record = findInstalledRecord(entry)
    return record ? isRecordEnabled(record) : true
  }

  const [catalog] = createResource(async () => {
    const url = extensionUrl("/catalog")
    const res = await localRequest()(url.toString(), { headers: { Accept: "application/json" } })
    return catalogFromJson(await jsonOrError(res))
  })

  const loadInstalled = async (scope: "machine" | "project") => {
    try {
      let directory: string | undefined
      if (scope === "project") {
        directory = props.directory
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

  const scanLocal = async () => {
    const dir = props.directory
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
        directory = props.directory
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
      const dir = entry.recommendedScope === "project" ? props.directory : undefined
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
    const confirmed = await requestMarketplaceConfirm(dialog, {
      title: `Uninstall ${entry.name}?`,
      body: "This removes its config and materialized files.",
      confirmLabel: "Uninstall",
    })
    if (!confirmed) return
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

  const toggleEnablement = async (entry: CatalogEntry) => {
    const record = findInstalledRecord(entry)
    if (!record) {
      showToast({ title: `Not installed (no record found)`, variant: "default", duration: 3000 })
      return
    }
    if (enablementState()[entry.id] === "toggling") return
    const { path, nextEnabled } = enablementToggle(record)
    setEnablementState((prev) => ({ ...prev, [entry.id]: "toggling" }))
    try {
      const url = extensionUrl(`/${encodeURIComponent(record.id)}/${path}`, {
        scope: record.scope,
        directory: record.directory,
      })
      const res = await localRequest()(url.toString(), {
        method: "POST",
        headers: { Accept: "application/json" },
      })
      await jsonOrError(res)
      setInstalledRecords((prev) => prev.map((r) => (r === record ? { ...r, enabled: nextEnabled } : r)))
      showToast({
        title: `${entry.name} ${nextEnabled ? "enabled" : "disabled"}`,
        variant: "success",
        duration: 3000,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: `Failed to ${path} ${entry.name}`, description: message, variant: "error", duration: 5000 })
    } finally {
      setEnablementState((prev) => {
        const next = { ...prev }
        delete next[entry.id]
        return next
      })
    }
  }

  const setDiscoveredState = async (item: DiscoveredExtension, action: DiscoveredExtensionAction) => {
    const dir = props.directory
    if (!dir) {
      showToast({ title: "Open a project to manage discovered config", variant: "default", duration: 4000 })
      return
    }
    if (discoveredPending()[item.path]) return
    setDiscoveredPending((prev) => ({ ...prev, [item.path]: action }))
    try {
      const url = extensionUrl(`/${action}`, { directory: dir })
      const res = await localRequest()(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ directory: dir, path: item.path }),
      })
      const body = await jsonOrError(res)
      const state = discoveredStateFromResponse(body) ?? discoveredStateForAction(action)
      setDiscovered((prev) => applyDiscoveredState(prev, item.path, state))
      showToast({
        title: action === "adopt" ? `Adopted ${item.path}` : `Ignored ${item.path}`,
        variant: "success",
        duration: 3000,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: `Failed to ${action} ${item.path}`, description: message, variant: "error", duration: 5000 })
    } finally {
      setDiscoveredPending((prev) => {
        const next = { ...prev }
        delete next[item.path]
        return next
      })
    }
  }

  const deleteMachineItem = async (item: MachineDiscoveredItem) => {
    const key = `${item.harness}/${item.kind}/${item.name}`
    if (machineDeleting()[key]) return
    const confirmed = await requestMarketplaceConfirm(dialog, {
      title: `Delete ${item.name}?`,
      body: `This permanently removes ${item.path} from disk.`,
      confirmLabel: "Delete",
    })
    if (!confirmed) return
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
    <div class="marketplace-page flex h-full min-h-0 bg-background-base">
      <div class="marketplace-layout mx-auto flex min-h-0 w-full max-w-[1080px]">
        {/* The one and only category list. Narrow panes reflow it into a
            horizontal chip strip above the content (marketplace.css); they do
            not render a second copy. */}
        <aside class="marketplace-sidebar" aria-label="Marketplace categories">
          <div class="marketplace-sidebar-heading mb-3 px-2 text-[12px] font-medium text-text-weak">Marketplace</div>
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
          <div class="marketplace-sidebar-rule bg-border-weak-base/20" />
          <For each={(catalog()?.categories ?? []).filter((c) => c.id !== "featured")}>
            {(cat) => (
              <CategoryButton
                label={cat.label}
                active={activeCategory() === cat.id}
                onClick={() => setActiveCategory(cat.id)}
              />
            )}
          </For>
          <div class="marketplace-sidebar-rule bg-border-weak-base/20" />
          <button
            type="button"
            class="group flex h-7 items-center gap-1.5 rounded px-2 text-left text-[12px] text-text-weak transition-colors hover:text-text-base disabled:opacity-50"
            onClick={scanLocal}
            disabled={scanLoading()}
            title={props.directory ? `Scan ${props.directory} for existing config` : "Open a project to enable scan"}
          >
            <Icon name={scanLoading() ? "dot-grid" : "magnifying-glass"} size="small" class={scanLoading() ? "animate-spin" : ""} />
            <span>{scanLoading() ? "Scanning…" : "Detect existing"}</span>
          </button>
        </aside>

        <main class="marketplace-main flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
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
              <DiscoveredSection
                items={discovered()}
                pending={discoveredPending()}
                onDismiss={() => setDiscovered([])}
                onAdopt={(item) => setDiscoveredState(item, "adopt")}
                onIgnore={(item) => setDiscoveredState(item, "ignore")}
              />
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
                    <span class="marketplace-section-detail text-[11px] text-text-weaker">Hand-picked to start with.</span>
                  </div>
                  <div class="marketplace-grid grid gap-2">
                    <For each={featuredEntries()}>
                      {(entry) => (
                        <ExtensionCard
                          entry={entry}
                          installed={isEntryInstalled(entry, installedIds())}
                          status={installState()[entry.id] ?? "idle"}
                          enabled={entryEnabled(entry)}
                          toggling={enablementState()[entry.id] === "toggling"}
                          onInstall={() => install(entry)}
                          onUninstall={() => uninstall(entry)}
                          onToggleEnablement={() => toggleEnablement(entry)}
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
                    <span class="marketplace-section-detail text-[11px] text-text-weaker">
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
                    <div class="marketplace-grid grid gap-2">
                      <For each={visibleEntries()}>
                        {(entry) => (
                          <ExtensionCard
                            entry={entry}
                            installed={isEntryInstalled(entry, installedIds())}
                            status={installState()[entry.id] ?? "idle"}
                            enabled={entryEnabled(entry)}
                            toggling={enablementState()[entry.id] === "toggling"}
                            onInstall={() => install(entry)}
                            onUninstall={() => uninstall(entry)}
                            onToggleEnablement={() => toggleEnablement(entry)}
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

            </Show>
          </div>
        </main>
      </div>
    </div>
  )
}
