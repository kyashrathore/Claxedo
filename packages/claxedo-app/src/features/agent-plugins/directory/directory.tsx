import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@opencode-ai/ui/toast"
import type { AgentPluginApi, AgentPluginHarness, PluginCandidate, PluginCatalog } from "../api"
import type { AgentPluginConnectionPort, AgentPluginConnectionSummary } from "../connections"
import { AddSourceForm } from "./add-source"
import { DirectoryCard, PersonalCard } from "./card"
import type { DirectoryApi, DirectorySourceRegistration } from "./data"
import { PluginDetailPane } from "./detail-pane"
import {
  directorySections,
  isInstalled,
  matchesQuery,
  personalEntries,
  sourcesFromCandidates,
  stateChip,
  type DirectorySourceView,
} from "./view"

const ALL = "all"
const PERSONAL = "personal"

/**
 * The Agent Plugins Directory: the one browse surface for plugins.
 *
 * It owns the catalog read and every mutation against it, because activation,
 * update and organization defaults are all guarded by the same `revision` and
 * all end in the same refetch. The detail pane renders one candidate and calls
 * back; the install sheet is a composition concern reached through `onAdd`.
 */
export function AgentPluginDirectory(props: {
  mode: "signed" | "unsigned"
  api: AgentPluginApi
  directory: DirectoryApi
  connections?: AgentPluginConnectionPort
  /**
   * Opens the install sheet. It receives the catalog the plugin was read from
   * because the sheet's project, harness and organization choices are all
   * bounded by that same read. Resolving refetches the catalog.
   */
  onAdd: (plugin: PluginCandidate, catalog: PluginCatalog) => void | Promise<unknown>
}) {
  const signed = () => props.mode === "signed"
  const [fresh, setFresh] = createSignal(false)
  const [projectId, setProjectId] = createSignal<string>()
  const [query, setQuery] = createSignal("")
  const [filter, setFilter] = createSignal<string>(ALL)
  const [selectedId, setSelectedId] = createSignal<string>()
  const [pending, setPending] = createSignal<string>()
  const [adding, setAdding] = createSignal(false)

  const [catalog, { refetch }] = createResource(
    () => ({ mode: props.mode, refresh: fresh(), projectId: signed() ? projectId() : undefined }),
    (options) => props.api.catalog(options),
  )
  const [connections, { refetch: refetchConnections }] = createResource(
    () => signed() && props.connections ? "signed" : undefined,
    () => props.connections!.load(),
  )
  const [sources, { refetch: refetchSources }] = createResource(
    () => ({ mode: props.mode }),
    () => props.directory.sources.list(),
  )
  const [machine] = createResource(() => "machine", () => props.directory.machineInstalled())

  const candidates = () => catalog()?.candidates ?? []
  const connectionRows = (): AgentPluginConnectionSummary[] => connections()?.connections ?? []
  const harnesses = createMemo<AgentPluginHarness[]>(() => catalog()?.supportedHarnesses ?? [])

  const sourceViews = createMemo<DirectorySourceView[]>(() => {
    const listed = sources()?.sources ?? []
    return listed.length > 0 ? listed : sourcesFromCandidates(candidates())
  })

  const sections = createMemo(() => directorySections({
    candidates: candidates(),
    sources: sourceViews(),
    connections: connectionRows(),
    query: query(),
    filter: filter(),
  }))
  const personal = createMemo(() => personalEntries({ machine: machine(), query: query(), filter: filter() }))

  const sourceCount = (id: string) => candidates()
    .filter((plugin) => plugin.source?.id === id && matchesQuery(plugin, query().trim().toLowerCase())).length
  const personalCount = () => personalEntries({ machine: machine(), query: query(), filter: ALL }).length

  const selected = createMemo(() => candidates().find((plugin) => plugin.pluginInstanceId === selectedId()))

  // ── Mutations, ported from the catalog article they replaced ──────────────
  const chosenHarnesses = () => harnesses()

  const mutate = async (plugin: PluginCandidate, choice: boolean | null) => {
    const current = catalog()
    if (!current) return
    setPending(plugin.pluginInstanceId)
    try {
      const targetSelection = signed()
        ? { scope: "projects" as const, projectIds: (current.projects ?? []).map((project) => project.id) }
        : undefined
      if (signed() && targetSelection && targetSelection.projectIds.length === 0) {
        throw new Error("Select at least one project")
      }
      const result = await props.api.activation({
        pluginInstanceId: plugin.pluginInstanceId,
        harnessIds: chosenHarnesses(),
        choice,
        expectedRevision: current.revision,
        ...(targetSelection ? { target: targetSelection } : {}),
      })
      if (result.reconciliation.state === "failed") {
        showToast({
          title: "Activation saved",
          description: result.reconciliation.message ?? "Runtime reconciliation will be retried.",
        })
      }
      setFresh(false)
      await refetch()
      if (signed() && props.connections) await refetchConnections()
    } catch (error) {
      showToast({ title: "Could not change plugin", description: error instanceof Error ? error.message : String(error) })
    } finally {
      setPending(undefined)
    }
  }

  const update = async (plugin: PluginCandidate) => {
    const current = catalog()
    if (!current) return
    setPending(plugin.pluginInstanceId)
    try {
      await props.api.update({
        pluginInstanceId: plugin.pluginInstanceId,
        expectedRevision: current.revision,
        ...(signed() ? { authority: "user" as const } : {}),
      })
      setFresh(false)
      await refetch()
      if (signed() && props.connections) await refetchConnections()
    } catch (error) {
      showToast({ title: "Could not update plugin", description: error instanceof Error ? error.message : String(error) })
    } finally {
      setPending(undefined)
    }
  }

  const organizationDefault = async (plugin: PluginCandidate, choice: true | null) => {
    const current = catalog()
    if (!current) return
    setPending(plugin.pluginInstanceId)
    try {
      await props.api.organizationDefault({
        pluginInstanceId: plugin.pluginInstanceId,
        harnessIds: chosenHarnesses(),
        choice,
        expectedRevision: current.revision,
      })
      setFresh(false)
      await refetch()
    } catch (error) {
      showToast({
        title: "Could not change organization default",
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setPending(undefined)
    }
  }

  const openConnection = (input: {
    serverName: string
    integrationId: string
    scope: AgentPluginConnectionSummary["scope"]
    issuer?: string
  }) => {
    props.connections?.open({
      integrationId: input.integrationId,
      name: `${input.serverName} MCP`,
      scope: input.scope,
      ...(input.issuer ? { issuer: input.issuer } : {}),
      teamScopeEnabled: catalog()?.canManageOrganizationConnections === true,
      onConnected: async () => { await refetchConnections() },
    })
  }

  const disconnect = async (connection: AgentPluginConnectionSummary) => {
    try {
      await props.connections?.disconnect(connection.id)
      await refetchConnections()
      showToast({ variant: "success", icon: "circle-check", title: "MCP connection disconnected" })
    } catch (error) {
      showToast({
        variant: "error",
        title: "Could not disconnect MCP",
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const add = async (plugin: PluginCandidate) => {
    const current = catalog()
    if (!current) return
    await props.onAdd(plugin, current)
    setFresh(false)
    await refetch()
    if (signed() && props.connections) await refetchConnections()
  }

  const removableSource = () => (sources()?.sources ?? []).find((source) => source.id === filter() && source.canRemove)

  const removeSource = async (id: string) => {
    try {
      await props.directory.sources.remove(id)
      setFilter(ALL)
      await refetchSources()
      setFresh(true)
      await refetch()
    } catch (error) {
      showToast({ title: "Could not remove source", description: error instanceof Error ? error.message : String(error) })
    }
  }

  const addSource = async (registration: DirectorySourceRegistration) => {
    await props.directory.sources.add(registration)
    setAdding(false)
    await refetchSources()
    setFresh(true)
    await refetch()
  }

  const refresh = async () => {
    setFresh(true)
    await refetch()
  }

  // ── Keyboard: Esc closes the pane, arrows walk the cards ──────────────────
  let grid: HTMLDivElement | undefined
  const moveFocus = (step: number) => {
    if (!grid) return
    const cards = [...grid.querySelectorAll<HTMLButtonElement>("[data-directory-card-open]")]
    if (cards.length === 0) return
    const active = document.activeElement
    const index = cards.findIndex((card) => card === active)
    const next = cards[index === -1 ? 0 : Math.min(cards.length - 1, Math.max(0, index + step))]
    next?.focus()
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && selectedId()) {
      event.preventDefault()
      setSelectedId(undefined)
      return
    }
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault()
      moveFocus(1)
      return
    }
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault()
      moveFocus(-1)
    }
  }

  const cardAction = (plugin: PluginCandidate) => {
    if (isInstalled(plugin)) return undefined
    const disabled = pending() === plugin.pluginInstanceId || (!plugin.sourceAvailable && !plugin.retainedDigest)
    return plugin.retainedDigest
      ? { label: "Enable", disabled, run: () => void mutate(plugin, true) }
      : { label: "Add", disabled, run: () => void add(plugin) }
  }

  return (
    <main
      data-agent-plugins-directory
      class="grid h-full min-h-0 grid-cols-[1fr_auto] bg-background-base"
      onKeyDown={onKeyDown}
    >
      <div class="min-w-0 overflow-y-auto px-6 py-5">
        <div class="mx-auto flex max-w-5xl flex-col gap-4">
          <header class="flex flex-wrap items-center gap-2">
            <input
              type="search"
              aria-label="Search plugins"
              placeholder="Search plugins, skills, MCP servers…"
              class="min-w-56 flex-1 rounded-lg border border-border-weak-base bg-surface-base px-3 py-2 text-13-regular text-text-base"
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
            <Show when={signed()}>
              <select
                aria-label="Inspect effective state for"
                class="rounded-lg border border-border-weak-base bg-surface-base px-2 py-2 text-13-regular text-text-base"
                value={projectId() ?? ""}
                onChange={(event) => setProjectId(event.currentTarget.value || undefined)}
              >
                <option value="">Cross-project defaults</option>
                <For each={catalog()?.projects ?? []}>{(project) => <option value={project.id}>{project.label}</option>}</For>
              </select>
            </Show>
            <Button size="normal" variant="secondary" disabled={catalog.loading} onClick={() => void refresh()}>
              {catalog.loading ? "Refreshing…" : "Refresh catalog"}
            </Button>
          </header>

          <div role="tablist" aria-label="Sources" class="flex flex-wrap items-center gap-2">
            <SourceChip id={ALL} label="All" active={filter() === ALL} onSelect={setFilter} />
            <For each={sourceViews()}>
              {(source) => (
                <SourceChip
                  id={source.id}
                  label={source.label}
                  count={sourceCount(source.id)}
                  active={filter() === source.id}
                  onSelect={setFilter}
                />
              )}
            </For>
            <SourceChip id={PERSONAL} label="Personal" count={personalCount()} active={filter() === PERSONAL} onSelect={setFilter} />
            <Button size="small" variant="ghost" onClick={() => setAdding((value) => !value)}>+ Add source</Button>
            <Show when={removableSource()}>
              {(source) => (
                <Button size="small" variant="ghost" onClick={() => void removeSource(source().id)}>
                  Remove {source().label}
                </Button>
              )}
            </Show>
          </div>

          <Show when={adding()}>
            <AddSourceForm
              organizationAllowed={signed() && catalog()?.canManageOrganizationDefaults === true}
              onAdd={addSource}
              onCancel={() => setAdding(false)}
            />
          </Show>

          <Show when={catalog.error}>
            <div role="alert" class="rounded-lg border border-border-critical-base p-3 text-13-regular text-icon-critical-base">
              {String(catalog.error)}
            </div>
          </Show>
          <Show when={sources.error}>
            <div role="alert" class="rounded-lg border border-border-weak-base p-3 text-12-regular text-text-weak">
              Sources unavailable: {String(sources.error)}
            </div>
          </Show>
          <Show when={catalog()?.errors.length}>
            <section class="rounded-lg border border-border-weak-base p-3">
              <h2 class="text-13-medium text-text-strong">Invalid catalog entries</h2>
              <For each={catalog()?.errors}>
                {(error) => <p class="mt-1 text-12-regular text-text-weak">{error.sourceId}/{error.relativePath}: {error.message}</p>}
              </For>
            </section>
          </Show>

          <div ref={grid} class="flex flex-col gap-6">
            <For each={sections()}>
              {(section) => (
                <section aria-label={section.title}>
                  <h2 class="mb-2 flex items-baseline gap-2 text-14-medium text-text-strong">
                    {section.title}
                    <span class="text-13-regular text-text-weaker">{section.plugins.length}</span>
                    <Show when={section.subtitle}>
                      {(subtitle) => <span class="text-12-regular text-text-weak">{subtitle()}</span>}
                    </Show>
                  </h2>
                  <div class="grid gap-2 md:grid-cols-2">
                    <For each={section.plugins}>
                      {(plugin) => (
                        <DirectoryCard
                          plugin={plugin}
                          chip={stateChip({ plugin, connections: connectionRows() })}
                          selected={selectedId() === plugin.pluginInstanceId}
                          action={cardAction(plugin)}
                          onOpen={() => setSelectedId(plugin.pluginInstanceId)}
                        />
                      )}
                    </For>
                  </div>
                </section>
              )}
            </For>

            <Show when={personal().length > 0 || machine.error}>
              <section aria-label="Personal">
                <h2 class="mb-2 flex items-baseline gap-2 text-14-medium text-text-strong">
                  Personal
                  <span class="text-13-regular text-text-weaker">{personal().length}</span>
                  <span class="text-12-regular text-text-weak">installed by you for these harnesses</span>
                </h2>
                <Show when={machine.error}>
                  <p class="text-12-regular text-text-weak">
                    Could not read this machine's harness installs: {String(machine.error)}
                  </p>
                </Show>
                <div class="grid gap-2 md:grid-cols-2">
                  <For each={personal()}>{(entry) => <PersonalCard entry={entry} />}</For>
                </div>
              </section>
            </Show>

            <Show when={sections().length === 0 && personal().length === 0 && !catalog.loading}>
              <p class="text-13-regular text-text-weak">No plugins match this search.</p>
            </Show>
          </div>
        </div>
      </div>

      <Show when={selected()}>
        {(plugin) => (
          <PluginDetailPane
            plugin={plugin()}
            signed={signed()}
            catalog={catalog()!}
            api={props.api}
            projectId={signed() ? projectId() : undefined}
            connections={connectionRows()}
            connectionsLoading={connections.loading}
            connectionsError={connections.error}
            pending={pending() === plugin().pluginInstanceId}
            onAdd={() => void add(plugin())}
            onActivate={(choice) => void mutate(plugin(), choice)}
            onUpdate={() => void update(plugin())}
            onOrganizationDefault={(choice) => void organizationDefault(plugin(), choice)}
            onConnect={openConnection}
            onDisconnect={(connection) => void disconnect(connection)}
            onClose={() => setSelectedId(undefined)}
          />
        )}
      </Show>
    </main>
  )
}

function SourceChip(props: {
  id: string
  label: string
  count?: number
  active: boolean
  onSelect: (id: string) => void
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={props.active}
      data-source-chip={props.id}
      class="rounded-full border px-3 py-1 text-12-regular"
      classList={{
        "border-border-strong-base bg-surface-raised-base text-text-strong": props.active,
        "border-border-weak-base text-text-weak": !props.active,
      }}
      onClick={() => props.onSelect(props.id)}
    >
      {props.label}
      <Show when={props.count !== undefined}>
        <span class="ml-1.5 text-text-weaker">{props.count}</span>
      </Show>
    </button>
  )
}
