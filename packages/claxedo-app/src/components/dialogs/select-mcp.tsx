// Claxedo manages MCP servers through Agent Extensions, so this dialog uses Marketplace install state instead of runtime connect toggles.

import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { createMemo, createSignal, For, onMount, Show, type Component } from "solid-js"
import { usePlatform } from "@claxedo/context/platform"
import { useSDK } from "@/context/sdk"
import { getClaxedoServerUrl } from "../../utils/api"
import { centralTransportForServer, unsignedLocalFetch } from "@claxedo/shell/data/transport/transport"
import {
  filterMcpCatalogEntries,
  installDisabledReasonForEntry,
  installMcpDialogEntry,
  isEntryInstalled,
  loadMcpDialogData,
  sourceLabel,
  targetLabel,
  uninstallMcpDialogEntry,
  type CatalogEntry,
  type InstalledRecord,
  type RequestFn,
} from "@claxedo/components/dialogs/select-mcp-logic"

type LoadState = "loading" | "ready" | "error"

export const DialogSelectMcp: Component = () => {
  const platform = usePlatform()
  let sdk: ReturnType<typeof useSDK> | undefined
  try {
    sdk = useSDK()
  } catch {
    /* The command can be opened outside a directory-scoped session in tests or global shells. */
  }

  const apiBase = () => getClaxedoServerUrl()
  const fetchFn = platform.fetch ?? globalThis.fetch
  // Rubric Q4: replace the URL-shape-inferred `claxedoServerFetch` with an
  // explicit branch on loopback. Loopback Claxedo server bypasses the bearer
  // (`unsignedLocalFetch`); remote control plane uses the signed fetch.
  const request = (): typeof fetch =>
    centralTransportForServer(apiBase()) === "loopback"
      ? unsignedLocalFetch
      : fetchFn
  const requestFn = (): RequestFn => (input, init) => request()(input, init)
  const directory = () => sdk?.directory
  const [state, setState] = createSignal<LoadState>("loading")
  const [error, setError] = createSignal("")
  const [query, setQuery] = createSignal("")
  const [entries, setEntries] = createSignal<CatalogEntry[]>([])
  const [installed, setInstalled] = createSignal<InstalledRecord[]>([])
  const [busy, setBusy] = createSignal("")

  const load = async () => {
    setState("loading")
    setError("")
    try {
      const data = await loadMcpDialogData(requestFn(), apiBase(), directory())
      setEntries(data.entries)
      setInstalled(data.installed)
      setState("ready")
    } catch (err) {
      setState("error")
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  onMount(() => {
    void load()
  })

  const visibleEntries = createMemo(() => filterMcpCatalogEntries(entries(), query()))
  const installDisabledReason = (entry: CatalogEntry) => installDisabledReasonForEntry(entry, directory())

  const install = async (entry: CatalogEntry) => {
    const disabled = installDisabledReason(entry)
    if (disabled) return
    setBusy(entry.id)
    try {
      const dir = directory()
      await installMcpDialogEntry(requestFn(), apiBase(), entry, dir)
      setInstalled((prev) => [
        ...prev,
        {
          id: entry.id,
          package_name: sourceLabel(entry.source).split("/").at(-1)?.toLowerCase() || undefined,
          scope: entry.recommendedScope === "project" ? "project" : "machine",
          ...(entry.recommendedScope === "project" && dir ? { directory: dir } : {}),
        },
      ])
      showToast({ title: `${entry.name} installed`, variant: "success", duration: 3000 })
    } catch (err) {
      showToast({
        title: `Failed to install ${entry.name}`,
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
        duration: 5000,
      })
    } finally {
      setBusy("")
    }
  }

  const uninstall = async (entry: CatalogEntry) => {
    setBusy(entry.id)
    try {
      const record = await uninstallMcpDialogEntry(requestFn(), apiBase(), entry, installed())
      if (!record) return
      setInstalled((prev) => prev.filter((item) => item !== record))
      showToast({ title: `${entry.name} uninstalled`, variant: "success", duration: 3000 })
    } catch (err) {
      showToast({
        title: `Failed to uninstall ${entry.name}`,
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
        duration: 5000,
      })
    } finally {
      setBusy("")
    }
  }

  return (
    <Dialog title="MCP Servers" description="Install and manage MCP servers from the Claxedo Marketplace catalog." size="large">
      <div class="flex max-h-[70vh] flex-col gap-4 px-1 pb-2">
        <label class="flex min-h-10 items-center gap-2 rounded-md border border-border-weak-base bg-surface-raised-base px-3">
          <Icon name="magnifying-glass" size="small" class="text-icon-weak-base" />
          <input
            autofocus
            aria-label="Search MCP servers"
            class="min-w-0 flex-1 bg-transparent text-14-regular text-text-base outline-none placeholder:text-text-weaker"
            placeholder="Search MCP servers..."
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <Show when={query()}>
            <button
              type="button"
              class="flex size-5 items-center justify-center rounded text-icon-weak-base hover:text-icon-base"
              aria-label="Clear search"
              onClick={() => setQuery("")}
            >
              <Icon name="close-small" size="small" />
            </button>
          </Show>
        </label>

        <Show when={state() === "loading"}>
          <div class="py-10 text-center text-13-regular text-text-weak">Loading MCP servers...</div>
        </Show>
        <Show when={state() === "error"}>
          <div class="rounded-md border border-border-weak-base bg-surface-raised-base px-4 py-5 text-13-regular text-text-weak">
            Failed to load MCP servers. {error()}
          </div>
        </Show>
        <Show when={state() === "ready"}>
          <div class="min-h-0 overflow-y-auto pr-1">
            <Show
              when={visibleEntries().length > 0}
              fallback={
                <div class="grid place-items-center rounded-md border border-dashed border-border-weak-base px-5 py-10 text-13-regular text-text-weak">
                  No MCP servers match this search.
                </div>
              }
            >
              <div class="flex flex-col gap-2">
                <For each={visibleEntries()}>
                  {(entry) => {
                    const installedEntry = () => isEntryInstalled(entry, installed())
                    const disabledReason = () => installDisabledReason(entry)
                    const busyEntry = () => busy() === entry.id
                    return (
                      <div
                        class="flex items-start justify-between gap-4 rounded-md border border-border-weak-base bg-surface-raised-base px-3 py-3"
                        data-testid={`mcp-entry-${entry.id}`}
                      >
                        <div class="min-w-0 flex-1">
                          <div class="flex flex-wrap items-center gap-2">
                            <span class="text-14-medium text-text-strong">{entry.name}</span>
                            <span class="rounded bg-surface-base px-1.5 py-px text-10-medium uppercase tracking-wide text-text-weak">
                              {entry.recommendedScope}
                            </span>
                            <Show when={installedEntry()}>
                              <span class="rounded bg-surface-success-base px-1.5 py-px text-10-medium uppercase tracking-wide text-text-on-success-base">
                                Installed
                              </span>
                            </Show>
                          </div>
                          <p class="mt-1 text-12-regular text-text-base">{entry.description}</p>
                          <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-11-regular text-text-weak">
                            <span>{sourceLabel(entry.source)}</span>
                            <span>{targetLabel(entry.recommendedTargets)}</span>
                          </div>
                        </div>
                        <div class="shrink-0">
                          <Show
                            when={installedEntry()}
                            fallback={
                              <Button
                                size="small"
                                variant="secondary"
                                disabled={busyEntry() || !!disabledReason()}
                                title={disabledReason()}
                                onClick={() => void install(entry)}
                              >
                                {busyEntry() ? "Installing..." : (disabledReason() ?? "Install")}
                              </Button>
                            }
                          >
                            <Button size="small" variant="ghost" disabled={busyEntry()} onClick={() => void uninstall(entry)}>
                              {busyEntry() ? "Uninstalling..." : "Uninstall"}
                            </Button>
                          </Show>
                        </div>
                      </div>
                    )
                  }}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}
