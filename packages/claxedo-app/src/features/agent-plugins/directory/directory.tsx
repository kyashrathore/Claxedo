import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { keepPreviousData, useQuery } from "@tanstack/solid-query"
import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import type { AgentPluginApi, AgentPluginHarness, PluginCandidate, PluginCatalog } from "../api"
import type { AgentPluginConnectionPort, AgentPluginConnectionSummary } from "../connections"
import { AddSourceForm } from "./add-source"
import { DirectoryCard, PersonalCard, personalEntryKey } from "./card"
import { PersonalPane } from "./personal-pane"
import { GHOST_ICON_BUTTON } from "./chrome"
import type { DirectoryApi, DirectorySourceRegistration } from "./data"
import { PluginDetailPane } from "./detail-pane"
import {
  directorySections,
  isInstalled,
  matchesQuery,
  personalEntries,
  pluginStatus,
  sourcesFromCandidates,
  type DirectorySourceView,
} from "./view"

const ALL = "all"
const PERSONAL = "personal"
const CROSS_PROJECT = "Cross-project defaults"

/**
 * The Agent Plugins Directory: the one browse surface for plugins.
 *
 * It owns the catalog read and every mutation against it, because activation,
 * update and organization defaults are all guarded by the same `revision` and
 * all end in the same refetch. The detail pane renders one candidate and calls
 * back; the install sheet is a composition concern reached through `onAdd`.
 *
 * The catalog is a query rather than a resource so that reopening the surface
 * paints the last read immediately and revalidates behind it — the same warm
 * boot the workspace catalog gets, through the same persisted `controlPlane`
 * prefix. "Refresh catalog" stays the one explicit way to make the server go
 * back to the source.
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
  const [projectId, setProjectId] = createSignal<string>()
  const [query, setQuery] = createSignal("")
  const [filter, setFilter] = createSignal<string>(ALL)
  const [selectedId, setSelectedId] = createSignal<string>()
  const [selectedPersonalKey, setSelectedPersonalKey] = createSignal<string>()
  const [pending, setPending] = createSignal<string>()
  const [adding, setAdding] = createSignal(false)

  // Not a signal: a forced re-read is a property of one fetch, not of the
  // query's identity. Keying on it would split the cache into a stale half and
  // a fresh half that never see each other's data.
  let forceRefresh = false
  const catalogQuery = useQuery(() => ({
    queryKey: ["controlPlane", props.mode, "agentPlugins", signed() ? projectId() ?? null : null],
    queryFn: () => {
      const refresh = forceRefresh
      forceRefresh = false
      const project = signed() ? projectId() : undefined
      return props.api.catalog({ ...(refresh ? { refresh: true } : {}), ...(project ? { projectId: project } : {}) })
    },
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  }))
  const reread = async (options: { refresh?: boolean } = {}) => {
    forceRefresh = options.refresh === true
    await catalogQuery.refetch()
  }

  const [connections, { refetch: refetchConnections }] = createResource(
    () => signed() && props.connections ? "signed" : undefined,
    () => props.connections!.load(),
  )
  const [sources, { refetch: refetchSources }] = createResource(
    () => ({ mode: props.mode }),
    () => props.directory.sources.list(),
  )
  const [machine] = createResource(() => "machine", () => props.directory.machineInstalled())
  // A resource read while errored rethrows its error into the render, so a
  // control plane without the sources route (or a daemon that cannot read the
  // machine's harness installs) must not take the whole Directory down: the
  // catalog still renders, and each failure is reported in its own place.
  // `.latest` keeps the last settled value through a refetch instead of
  // suspending the surface: reading `sources()` mid-refetch would put the whole
  // marketplace behind the surface-level "Loading…" fallback.
  const listedSources = () => (sources.error ? [] : sources.latest?.sources ?? [])
  const machineInstalled = () => (machine.error ? undefined : machine.latest)

  const catalog = () => catalogQuery.data
  const candidates = () => catalog()?.candidates ?? []
  // Guarded like sources and machine: an errored resource rethrows on read, and a
  // failed connection status must not take the Directory down.
  const connectionRows = (): AgentPluginConnectionSummary[] => (connections.error ? [] : connections.latest?.connections ?? [])
  const harnesses = createMemo<AgentPluginHarness[]>(() => catalog()?.supportedHarnesses ?? [])

  const sourceViews = createMemo<DirectorySourceView[]>(() => {
    const listed = listedSources()
    return listed.length > 0 ? listed : sourcesFromCandidates(candidates())
  })

  const sections = createMemo(() => directorySections({
    connectionsKnown: !connections.error,
    candidates: candidates(),
    sources: sourceViews(),
    connections: connectionRows(),
    query: query(),
    filter: filter(),
  }))
  const personal = createMemo(() => personalEntries({ machine: machineInstalled(), query: query(), filter: filter() }))

  const sourceCount = (id: string) => candidates()
    .filter((plugin) => plugin.source?.id === id && matchesQuery(plugin, query().trim().toLowerCase())).length
  const personalCount = () => personalEntries({ machine: machineInstalled(), query: query(), filter: ALL }).length

  const selected = createMemo(() => candidates().find((plugin) => plugin.pluginInstanceId === selectedId()))
  const selectedPersonal = createMemo(() => personal().find((entry) => personalEntryKey(entry) === selectedPersonalKey()))
  const projectLabel = () => catalog()?.projects?.find((project) => project.id === projectId())?.label ?? CROSS_PROJECT

  // ── Mutations, ported from the catalog article they replaced ──────────────
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
        harnessIds: harnesses(),
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
      await reread()
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
      await reread()
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
        harnessIds: harnesses(),
        choice,
        expectedRevision: current.revision,
      })
      await reread()
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
    await reread()
    if (signed() && props.connections) await refetchConnections()
  }

  const removableSource = () => listedSources().find((source) => source.id === filter() && source.canRemove)

  const removeSource = async (id: string) => {
    try {
      await props.directory.sources.remove(id)
      setFilter(ALL)
      await refetchSources()
      await reread({ refresh: true })
    } catch (error) {
      showToast({ title: "Could not remove source", description: error instanceof Error ? error.message : String(error) })
    }
  }

  const addSource = async (registration: DirectorySourceRegistration) => {
    await props.directory.sources.add(registration)
    setAdding(false)
    await refetchSources()
    await reread({ refresh: true })
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
          <header class="flex items-center gap-1.5">
            <input
              type="search"
              aria-label="Search plugins"
              placeholder="Search plugins, skills, MCP servers…"
              class="min-w-56 flex-1 rounded-lg border border-border-weak-base bg-surface-base px-3 py-2 text-13-regular text-text-base"
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
            <Show when={signed()}>
              <DropdownMenu>
                <DropdownMenu.Trigger
                  aria-label="Inspect effective state for"
                  class="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-12-regular text-text-weak hover:bg-surface-raised-base hover:text-text-base"
                >
                  <span class="truncate">{projectLabel()}</span>
                  <Icon name="chevron-down" size="small" />
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content>
                    <DropdownMenu.Item onSelect={() => setProjectId(undefined)}>{CROSS_PROJECT}</DropdownMenu.Item>
                    <For each={catalog()?.projects ?? []}>
                      {(project) => (
                        <DropdownMenu.Item onSelect={() => setProjectId(project.id)}>{project.label}</DropdownMenu.Item>
                      )}
                    </For>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu>
            </Show>
            <button
              type="button"
              aria-label="Refresh catalog"
              title="Refresh catalog"
              disabled={catalogQuery.isFetching}
              class={`${GHOST_ICON_BUTTON} size-7`}
              onClick={() => void reread({ refresh: true })}
            >
              <Icon name="reset" size="small" />
            </button>
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

          <Show when={catalogQuery.error}>
            <div role="alert" class="rounded-lg border border-border-critical-base p-3 text-13-regular text-icon-critical-base">
              {String(catalogQuery.error)}
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

          <Show when={catalogQuery.isPending && !catalog()}>
            <CatalogSkeleton />
          </Show>

          <div ref={grid} class="flex flex-col gap-6">
            <For each={sections()}>
              {(section) => (
                <section aria-label={section.title}>
                  <SectionHeading title={section.title} count={section.plugins.length} />
                  <div class="grid gap-2 grid-cols-[repeat(auto-fill,minmax(19rem,1fr))]">
                    <For each={section.plugins}>
                      {(plugin) => (
                        <DirectoryCard
                          plugin={plugin}
                          status={pluginStatus({ plugin, connections: connectionRows(), connectionsKnown: !connections.error })}
                          selected={selectedId() === plugin.pluginInstanceId}
                          action={cardAction(plugin)}
                          onOpen={() => { setSelectedPersonalKey(undefined); setSelectedId(plugin.pluginInstanceId) }}
                        />
                      )}
                    </For>
                  </div>
                </section>
              )}
            </For>

            <Show when={personal().length > 0 || machine.error}>
              <section aria-label="Personal">
                <SectionHeading title="Personal" count={personal().length} note="installed for other harnesses" />
                <Show when={machine.error}>
                  <p class="text-12-regular text-text-weak">
                    Could not read this machine's harness installs: {String(machine.error)}
                  </p>
                </Show>
                <div class="grid gap-2 grid-cols-[repeat(auto-fill,minmax(19rem,1fr))]">
                  <For each={personal()}>{(entry) => (
                    <PersonalCard
                      entry={entry}
                      selected={selectedPersonalKey() === personalEntryKey(entry)}
                      onOpen={() => { setSelectedId(undefined); setSelectedPersonalKey(personalEntryKey(entry)) }}
                    />
                  )}</For>
                </div>
              </section>
            </Show>

            <Show when={sections().length === 0 && personal().length === 0 && !catalogQuery.isPending}>
              <p class="text-13-regular text-text-weak">No plugins match this search.</p>
            </Show>
          </div>
        </div>
      </div>

      <Show when={selectedPersonal()}>
        {(entry) => <PersonalPane entry={entry()} onClose={() => setSelectedPersonalKey(undefined)} />}
      </Show>
      <Show when={selected()}>
        {(plugin) => (
          <Show when={catalog()}>
            {(current) => (
              <PluginDetailPane
                plugin={plugin()}
                signed={signed()}
                catalog={current()}
                api={props.api}
                harnesses={harnesses()}
                projectId={signed() ? projectId() : undefined}
                connections={connectionRows()}
                connectionsLoading={connections.loading}
                connectionsError={connections.error}
                onRetryConnections={() => void refetchConnections()}
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
        )}
      </Show>
    </main>
  )
}

/** 13/medium title, muted count, and nothing else unless the section needs a word. */
function SectionHeading(props: { title: string; count: number; note?: string }) {
  return (
    <h2 class="mb-2 flex items-baseline gap-2 text-13-medium text-text-strong">
      {props.title}
      <span class="text-12-regular text-text-weaker">{props.count}</span>
      <Show when={props.note}>{(note) => <span class="text-12-regular text-text-weaker">{note()}</span>}</Show>
    </h2>
  )
}

/** The first read has nothing to paint, so it paints the shape of the answer. */
function CatalogSkeleton() {
  return (
    <div data-component="agent-plugin-skeleton" aria-hidden="true" class="grid gap-2 grid-cols-[repeat(auto-fill,minmax(19rem,1fr))]">
      <For each={[0, 1, 2]}>
        {() => (
          <div class="flex items-start gap-3 rounded-lg border border-border-weak-base bg-surface-base p-3">
            <div class="size-10 shrink-0 rounded-lg bg-surface-raised-stronger" />
            <div class="flex min-w-0 flex-1 flex-col gap-2 pt-1">
              <div class="h-3 w-1/3 rounded-sm bg-surface-raised-stronger" />
              <div class="h-2.5 w-4/5 rounded-sm bg-surface-raised-base" />
            </div>
          </div>
        )}
      </For>
    </div>
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
