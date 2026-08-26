import { createAsyncState } from "@/lib/async-state"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { List } from "@opencode-ai/ui/list"
import { Popover } from "@opencode-ai/ui/popover"
import { For, Show, createTrackedEffect, createSignal, onCleanup } from "solid-js"
import { SemanticIcon } from "@/ui/semantic-icon"
import { claxedoEventsPort } from "../app-ports"
import {
  DocumentApiError,
  documentsApi,
  type DocumentQuery,
  type DocumentStatus,
  type DocumentSummary,
  type DocumentsApi,
} from "../data/documents-api"
import type { DocumentChangedEvent } from "../data/document-changed-event"
import "./document-index.css"

/**
 * A project's documents, keyed by the project THIS CLIENT ASKED FOR.
 *
 * Deliberately not `DocumentSummary.project_id`. Those two ids are different
 * namespaces for a local workspace: `routeScope` resolves a loopback request
 * through `resolveLocalProjectId(directory)`, which mints and stores its own
 * `project_<uuid>` per canonical directory (`documents/index-store.ts`) and
 * ignores the `project_id` we sent. Grouping on the echoed id therefore finds
 * no matching project in the inventory and labels the group with a raw uuid.
 * The requesting project is the one we can actually name.
 */
export type DocumentIndexGroup = { projectId: string; documents: DocumentSummary[] }

type IndexState = {
  groups: DocumentIndexGroup[]
  loading: boolean
  error?: string
  /**
   * Projects whose list call failed. The index spans many projects now, and one
   * of them returning 403/500 must cost its own documents rather than blanking
   * everyone else's — but a short list is indistinguishable from a complete one
   * unless we say so, so the shortfall is named instead of swallowed.
   */
  unavailable: string[]
  connection: "connecting" | "connected" | "reconnecting"
}

/**
 * Documents index live sync.
 *
 * This controller used to own a dedicated `GET /documents/events` SSE purely to
 * learn "something changed" — a held local-origin socket per index surface, and
 * one of the connections in the 6-per-origin budget that stalled ordinary
 * fetches for 25–35s. It now listens for the `document.changed` doorbell on the
 * already-open central events stream and re-reads the list. No socket of its
 * own; the reconnect/backoff ladder it used to run belongs to that shared
 * stream now.
 *
 * The doorbell is a HINT, never a source of truth: every field rendered here
 * comes from `api.list`. A missed nudge costs freshness until the next
 * reconnect or focus, never correctness.
 */
export function createDocumentIndexController(input: {
  /**
   * One query per project in view. There is no cross-project list to call:
   * `routeScope` in the server's document routes requires a project and
   * authorizes that one project, so this fan-out IS the authorization model —
   * each project's visibility is decided on its own request, and a project the
   * caller cannot read drops out of the merge instead of failing the page.
   */
  queries: DocumentQuery[]
  api: DocumentsApi
  // NOTE: the old `schedule` input is gone with the reconnect backoff ladder —
  // the central stream owns reconnection now.
  /**
   * `document.changed` from the central bus. Absent until Wave 3 wires the
   * events port (see `app-ports.ts`), in which case the index loads on open and
   * refreshes on reconnect but does not live-update.
   */
  subscribe?: (handler: (event: DocumentChangedEvent) => void) => () => void
  /**
   * Central-stream connectivity. `false → true` is the revalidation edge: it
   * covers every nudge missed while the stream was down, which is what keeps R4
   * ("never silently stale") true without a per-surface socket.
   */
  subscribeConnected?: (handler: (connected: boolean) => void) => () => void
  onChange: (state: IndexState) => void
  onError: (error: unknown) => void
}) {
  const state: IndexState = { groups: [], loading: true, unavailable: [], connection: "connecting" }
  const emit = () => input.onChange({ ...state, groups: [...state.groups], unavailable: [...state.unavailable] })
  let stopped = false
  let unsubscribe: (() => void) | undefined
  let unsubscribeConnected: (() => void) | undefined
  let loadSequence = 0
  let refreshing = false
  let refreshAgain = false
  // Projects the server answered 404 for. A 404 here is `authorizeProject`
  // fail-closed — the project is gone or not ours — and that verdict does not
  // change on a doorbell or a stream reconnect, only when the INVENTORY
  // changes (which rebuilds this controller with fresh queries). Without the
  // quarantine, every revalidation edge re-fired one guaranteed-404 request
  // per dead project forever: staging's leaked smoke workspaces turned the
  // index into a visible 404 storm. Transient failures (network, 5xx) stay
  // out of this set and keep retrying on the next refresh.
  const gone = new Set<string>()

  const load = async (loading = true) => {
    if (stopped) return
    const request = ++loadSequence
    if (loading) state.loading = true
    state.error = undefined
    emit()
    const queries = input.queries.filter((query) => !query.projectId || !gone.has(query.projectId))
    // `allSettled`, not `all`: a rejected project costs its own documents, not
    // the whole index.
    const results = await Promise.allSettled(queries.map((query) => input.api.list(query)))
    if (stopped || request !== loadSequence) return
    const groups: DocumentIndexGroup[] = []
    const unavailable: string[] = [...gone]
    let failure: unknown
    results.forEach((result, index) => {
      const projectId = queries[index]?.projectId
      if (result.status === "fulfilled") {
        if (projectId) groups.push({ projectId, documents: result.value })
        return
      }
      failure = result.reason
      if (projectId) {
        unavailable.push(projectId)
        if (result.reason instanceof DocumentApiError && result.reason.status === 404) gone.add(projectId)
      }
      input.onError(result.reason)
    })
    state.groups = groups
    state.unavailable = unavailable
    // Only a total wipeout is an error banner: a partial failure still leaves a
    // usable index, and `unavailable` already names what is missing from it.
    // "Total" is measured against the queries actually SENT this load —
    // quarantined projects are already counted unavailable and must not dilute
    // the ratio.
    state.error =
      failure !== undefined && results.length > 0 && groups.length === 0
        ? failure instanceof Error
          ? failure.message
          : String(failure)
        : undefined
    state.loading = false
    emit()
  }

  const refresh = async () => {
    if (refreshing) {
      refreshAgain = true
      return
    }
    refreshing = true
    do {
      refreshAgain = false
      await load(false)
    } while (refreshAgain && !stopped)
    refreshing = false
  }

  /**
   * Could this nudge concern a project we are showing?
   *
   * The bus reports `scope.projectId` — the id the SERVER resolved — and which
   * id space that is depends on the deployment. A signed request authorizes the
   * inventory id we sent, so the two match. A loopback request resolves the
   * project from `directory` instead and answers with the `project_<uuid>` that
   * `resolveLocalProjectId` mints per canonical directory, which matches nothing
   * we asked for. Comparing only against `input.queries` therefore discarded
   * every LOCAL nudge and quietly froze the index — the silent staleness (R4)
   * this controller exists to prevent.
   *
   * So both spaces are checked, and the local one is learned from the documents
   * themselves. When a project we asked for has no documents yet, its server-side
   * id is still unknown — an unfamiliar id could be that project, and the first
   * document created in it is precisely the update we must not miss, so an
   * unresolved project makes this fail toward refreshing.
   */
  const concernsUs = (projectId: string | undefined) => {
    if (!projectId) return true
    if (requestedProjects.has(projectId)) return true
    if (state.groups.some((group) => group.documents.some((document) => document.project_id === projectId))) return true
    // Quarantined projects count as resolved: their absence from `groups` is a
    // settled 404, not an unmapped local id an unfamiliar nudge might belong to.
    return (
      state.groups.length + gone.size < input.queries.length ||
      state.groups.some((group) => group.documents.length === 0)
    )
  }

  const requestedProjects = new Set(input.queries.map((query) => query.projectId).filter(Boolean) as string[])

  const connect = () => {
    if (stopped) return
    if (!input.subscribe) {
      // Loud on purpose: silently degrading to a non-live index is the failure
      // mode this whole change is supposed to make impossible to ship.
      console.warn("[documents] central events port unavailable — the Documents index will not live-update.")
    }
    unsubscribe = input.subscribe?.((event) => {
      if (stopped) return
      // The central stream carries every project's documents; the legacy SSE got
      // this scoping from its per-connection subscription. Server-side org
      // filtering in `routes/events.ts` is the authorization boundary — this is
      // only routing.
      if (!concernsUs(event.projectId)) return
      void refresh()
    })
    unsubscribeConnected = input.subscribeConnected?.((connected) => {
      if (stopped) return
      const reconnected = state.connection === "reconnecting"
      state.connection = connected ? "connected" : "reconnecting"
      emit()
      // Only on the reconnect EDGE. The first connect rides the initial load,
      // and refreshing on every `true` would re-fetch on each re-render.
      if (connected && reconnected) void refresh()
    })
  }

  return {
    snapshot: () => ({ ...state, groups: [...state.groups], unavailable: [...state.unavailable] }),
    load,
    start() {
      stopped = false
      connect()
    },
    stop() {
      refreshAgain = false
      loadSequence++
      stopped = true
      unsubscribe?.()
      unsubscribeConnected?.()
      unsubscribe = undefined
      unsubscribeConnected = undefined
    },
  }
}

type Project = {
  id: string
  worktree: string
  workspaceId?: string
  sandboxes?: string[]
  workspaces?: Record<string, { id?: string; workspaceId?: string; directory?: string; kind?: string }>
}

export function resolveDocumentProjectScope(projects: Project[], directory?: string) {
  if (!directory) {
    const project = projects[0]
    return { projectId: project?.id, workspaceId: project?.workspaceId }
  }
  const matches = (value?: string) => value === directory
  const project = projects.find(
    (candidate) =>
      matches(candidate.worktree) ||
      candidate.sandboxes?.some(matches) ||
      Object.entries(candidate.workspaces ?? {}).some(
        ([key, workspace]) =>
          matches(key) || matches(workspace.directory) || matches(workspace.id) || matches(workspace.workspaceId),
      ),
  )
  if (!project) return {}
  const workspace = Object.entries(project.workspaces ?? {}).find(
    ([key, value]) => matches(key) || matches(value.directory) || matches(value.id) || matches(value.workspaceId),
  )
  return {
    projectId: project.id,
    workspaceId:
      workspace?.[1].workspaceId ??
      workspace?.[1].id ??
      (workspace?.[0] === directory ? workspace[0] : undefined) ??
      (matches(project.worktree) ? project.workspaceId : undefined),
  }
}

/** A project as this surface names it. Read off the project inventory and never
 *  invented: an id with no known worktree renders as the id itself. */
export type DocumentProjectIdentity = { id: string; label: string; detail?: string }

export function documentProjectIdentity(projects: Project[], projectId: string): DocumentProjectIdentity {
  const worktree = projects.find((project) => project.id === projectId)?.worktree
  if (!worktree) return { id: projectId, label: projectId }
  return { id: projectId, label: worktree.split("/").filter(Boolean).at(-1) ?? worktree, detail: worktree }
}

export type PageIndexProps = {
  scope: "all" | "project" | "global"
  /** The workspace in view. Places new documents, and at `all` scope it is only
   *  a default — never the scope of what is listed. */
  directory?: string
  projects: Project[]
  /**
   * `projectId` is the project the document was LISTED under (an inventory id),
   * which the caller needs to open it against its own workspace. Reading
   * `document.project_id` instead would hand back the server's id and, for a
   * repository document, host the tab in whichever workspace happened to be
   * focused.
   */
  onOpenPage: (document: DocumentSummary, projectId: string) => void
}

export function PageIndex(props: PageIndexProps) {
  // Resolved once during setup: `useClaxedoEventsOptional` reads context, which
  // is only legal here — not inside the async createResource fetcher below.
  const events = claxedoEventsPort()?.()
  // The controller is a plain object, so the connectivity signal is bridged to it
  // through this handler rather than the controller reading the signal itself.
  //
  // `centralConnected`, NOT the aggregate `connected`: `document.changed` rides
  // the CENTRAL stream only, and the aggregate ORs in every remote workspace
  // relay stream — so it stays true across a central drop/recover, the
  // reconnect edge never fires, and the nudges missed during the gap are never
  // recovered (silent staleness). See `app/connection/stream-connectivity.ts`.
  let connectionHandler: ((connected: boolean) => void) | undefined
  createTrackedEffect(() => {
    const connected = events?.centralConnected()
    if (connected !== undefined) connectionHandler?.(connected)
  })
  const [state, setState] = createSignal<IndexState>({
    groups: [],
    loading: true,
    unavailable: [],
    connection: "connecting",
  })
  const [statuses, setStatuses] = createSignal<Record<string, DocumentStatus[]>>({})
  const [projectFilter, setProjectFilter] = createSignal<string | undefined>()
  const [statusFilter, setStatusFilter] = createSignal<string | undefined>()
  const placement = () => resolveDocumentProjectScope(props.projects, props.directory)

  /**
   * One authorized query per project in view.
   *
   * `project` scope pins the open directory's project. The standalone index
   * (`all`/`global`) spans every project in the inventory — it used to send a
   * single query for `projects[0]` alone, which presented one arbitrary
   * project's documents as though they were all of them.
   *
   * Both keys travel on every query, because the two deployment modes read
   * different ones and each ignores the other: a loopback request resolves the
   * project from `directory` alone, while a signed request authorizes
   * `projectId` and never looks at the directory. Sending only the id would
   * return an empty list locally — the id space wouldn't match anything in the
   * server's local-project table.
   */
  const scopes = (): DocumentQuery[] => {
    if (props.scope === "project") {
      const projectId = placement().projectId
      return projectId ? [{ projectId, directory: props.directory }] : []
    }
    return props.projects
      .filter((project) => project.id)
      .map((project) => ({ projectId: project.id, directory: project.worktree }))
  }
  let controller: ReturnType<typeof createDocumentIndexController> | undefined
  let generation = 0

  createAsyncState(async () => {
    const source = (() => ({ scopes: scopes(), workspaceId: placement().workspaceId }))()
    if (!source) return undefined
    return ((configuration) => {
      const currentScopes = configuration.scopes
      const currentGeneration = ++generation
      controller?.stop()
      controller = undefined
      setStatuses({})
      setProjectFilter(undefined)
      setStatusFilter(undefined)
      if (currentScopes.length === 0) {
        setState((state) => ({
          ...state,
          ...{
            groups: [],
            loading: false,
            unavailable: [],
            connection: "connecting",
            error: "Choose a project to view Documents.",
          },
        }))
        return currentGeneration
      }
      const current = createDocumentIndexController({
        queries: currentScopes,
        api: documentsApi,
        ...(events
          ? {
              subscribe: (handler: (event: DocumentChangedEvent) => void) => events.on("document.changed", handler),
              subscribeConnected: (handler: (connected: boolean) => void) => {
                connectionHandler = handler
                handler(events.centralConnected())
                return () => {
                  if (connectionHandler === handler) connectionHandler = undefined
                }
              },
            }
          : {}),
        onChange: (next) => {
          if (currentGeneration === generation) setState(next)
        },
        onError: (error) => {
          if (currentGeneration === generation) console.error(error)
        },
      })
      controller = current
      current.start()
      void Promise.all([
        current.load(),
        // Status vocabularies are per project (`listStatuses(projectId)`), so
        // they fan out alongside the lists. A project whose vocabulary fails
        // still shows its documents: the rows fall back to the raw status id,
        // which is visibly degraded rather than silently wrong.
        ...currentScopes.map((scope) =>
          documentsApi.listStatuses(scope).then(
            (next) => {
              const projectId = scope.projectId
              if (currentGeneration !== generation || !projectId) return
              setStatuses((value) => ({ ...value, [projectId]: next }))
            },
            (error) => {
              if (currentGeneration === generation) console.error(error)
            },
          ),
        ),
      ])
      return currentGeneration
    })(source)
  })
  // Distinct from `generation`, which also moves on every scope change: a scope
  // change is not a disposal, and a create the user explicitly filed against a
  // named project should still open when it lands. This flag marks the one case
  // where the completion has nowhere to go — the index itself is gone.
  let disposed = false
  onCleanup(() => {
    disposed = true
    generation++
    controller?.stop()
  })

  // Creating a document requires an EXPLICITLY chosen project. The index spans
  // many projects (`all`/`global` scope) and the tab's host workspace is only
  // where it happens to be mounted — it is not a document destination. The old
  // flow inferred one anyway (`resolveDocumentProjectScope` falling back to
  // `projects[0]` or the host workspace), so "New document" either filed against
  // a project the user never picked or, when nothing resolved, sat silently
  // disabled with no visual cue. "New document" now just opens a project menu;
  // picking one creates the document there and opens it. No faked destination.
  const [creating, setCreating] = createSignal(false)

  /** Every project in the inventory, named the same way the groups are. Empty
   *  ⇒ nothing to create against, so the button is disabled honestly. */
  const createProjectOptions = (): DocumentProjectIdentity[] =>
    props.projects.filter((project) => project.id).map((project) => documentProjectIdentity(props.projects, project.id))

  const createInProject = async (projectId: string) => {
    if (creating()) return
    const project = props.projects.find((candidate) => candidate.id === projectId)
    // Only ever a project the user actually picked from the menu.
    if (!project) return
    setCreating(true)
    try {
      const document = await documentsApi.create({
        projectId: project.id,
        // The SELECTED project's own worktree. A loopback create resolves the
        // project from this directory, so it must be the real one — never the
        // tab's host directory.
        directory: project.worktree,
        displayName: "Untitled document",
      })
      // The index can be closed while the create is still in flight. Opening the
      // result then would drop a tab on a surface the user has already left.
      if (disposed) return
      props.onOpenPage(document, project.id)
    } catch (error) {
      if (disposed) return
      setState((state) => ({ ...state, error: error instanceof Error ? error.message : String(error) }))
    } finally {
      setCreating(false)
    }
  }

  const matchesFilters = (group: DocumentIndexGroup, document: DocumentSummary) => {
    if (projectFilter() && group.projectId !== projectFilter()) return false
    if (statusFilter() && document.status !== statusFilter()) return false
    return true
  }

  const visible = () =>
    state().groups.flatMap((group) => group.documents.filter((document) => matchesFilters(group, document)))

  /** Groups keep the order the queries were issued in, which is inventory order,
   *  so projects read the same here as in the sidebar. A project with nothing
   *  left after filtering drops its header rather than showing an empty one. */
  const groups = () =>
    state()
      .groups.map((group) => ({
        ...documentProjectIdentity(props.projects, group.projectId),
        documents: group.documents
          .filter((document) => matchesFilters(group, document))
          .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? "")),
      }))
      .filter((group) => group.documents.length)

  /** Everything that loaded, before filters — what distinguishes "nothing here"
   *  from "nothing matches what you asked for". */
  const loaded = () => state().groups.reduce((total, group) => total + group.documents.length, 0)

  /** Only projects that actually hold a document: a filter listing a dozen
   *  empty projects is a worse index than no filter at all. */
  const projectOptions = () =>
    state()
      .groups.filter((group) => group.documents.length)
      .map((group) => documentProjectIdentity(props.projects, group.projectId))

  const statusOptions = () => {
    const merged = new Map<string, DocumentStatus>()
    for (const list of Object.values(statuses())) {
      for (const status of list) if (!merged.has(status.id)) merged.set(status.id, status)
    }
    return [...merged.values()].sort((a, b) => a.position - b.position)
  }

  return (
    <main class="size-full overflow-auto bg-background-base px-6 py-6" aria-labelledby="documents-index-title">
      <div class="documents-canvas">
        <header class="documents-head">
          <div class="min-w-0">
            <h1 id="documents-index-title" class="documents-title text-text-strong">
              Documents
            </h1>
            <p class="documents-lede text-text-weak">
              {props.scope === "project" ? "Markdown files in this project." : "Markdown files across your projects."}
            </p>
          </div>
          <div class="documents-head-actions">
            <span class="text-xs text-text-weak" role="status" aria-live="polite">
              {state().connection === "reconnecting" ? "Reconnecting…" : `${visible().length} documents`}
            </span>
            <NewDocumentButton
              projects={createProjectOptions()}
              creating={creating()}
              onCreate={(projectId) => void createInProject(projectId)}
            />
          </div>
        </header>

        <Show when={loaded() || projectFilter() || statusFilter()}>
          <div class="documents-filters">
            <Show when={props.scope !== "project"}>
              <FilterChip
                label="Project"
                value={projectFilter()}
                options={projectOptions()}
                onSelect={setProjectFilter}
              />
            </Show>
            <FilterChip
              label="Status"
              value={statusFilter()}
              options={statusOptions().map((status) => ({ id: status.id, label: status.name, color: status.color }))}
              onSelect={setStatusFilter}
            />
          </div>
        </Show>

        <Show when={state().error}>
          <p class="mb-4 text-sm text-text-on-critical-base" role="alert">
            {state().error}
          </p>
        </Show>

        <Show
          when={!state().loading}
          fallback={
            <p class="documents-empty text-text-weak" role="status">
              Loading documents…
            </p>
          }
        >
          <Show
            when={groups().length}
            fallback={
              <p class="documents-empty text-text-weak">
                {loaded() ? "No documents match these filters." : "No documents yet."}
              </p>
            }
          >
            <For each={groups()}>
              {(group) => (
                <section aria-label={`Project ${group.label}`}>
                  <div class="documents-project-row">
                    <SemanticIcon concept="project" size="small" class="documents-project-icon" />
                    <span class="documents-project-name text-text-strong">{group.label}</span>
                    <Show when={group.detail}>
                      <span class="documents-project-path text-text-weaker">{group.detail}</span>
                    </Show>
                  </div>
                  <ul aria-label={`Documents in ${group.label}`}>
                    <For each={group.documents}>
                      {(document) => (
                        <li class="documents-row">
                          {/* Status lives in the top filter, not on the row —
                              it read as a redundant "Draft" tag on every card.
                              The status vocabulary is still fetched (see
                              `statuses()`) so the Status filter above stays
                              populated; only the per-row control is gone. */}
                          <button
                            type="button"
                            class="documents-open"
                            onClick={() => props.onOpenPage(document, group.id)}
                          >
                            <span class="documents-name text-text-strong">{document.display_name}</span>
                            <span class="documents-meta text-text-weak" data-origin={document.origin_kind}>
                              {document.origin_kind === "repository"
                                ? document.repository_relative_path
                                : "Managed document"}
                            </span>
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              )}
            </For>
          </Show>
        </Show>

        <Show when={state().unavailable.length}>
          <p class="documents-note text-text-weak" role="status">
            {state().unavailable.length} project{state().unavailable.length === 1 ? "" : "s"} could not be loaded.
          </p>
        </Show>
      </div>
    </main>
  )
}

/** "New document" is a searchable project picker, not a dialog: click it, filter
 *  to a project, pick it, and the document is created there and opened. Reuses
 *  the same shared `List` (fuzzy search box + keyed items) as WorkGraph's base
 *  revision picker, so the styling and typeahead match exactly. Disabled (and
 *  non-opening) when there is no project to create in — never a faked
 *  destination. */
function NewDocumentButton(props: {
  projects: DocumentProjectIdentity[]
  creating: boolean
  onCreate: (projectId: string) => void
}) {
  const [open, setOpen] = createSignal(false)
  return (
    <Popover
      placement="bottom-end"
      portal
      open={open()}
      onOpenChange={setOpen}
      class="documents-new-popover"
      trigger={
        <>
          {props.creating ? "Creating…" : "New document"}
          <Icon name="chevron-down" size="small" class="documents-new-caret" />
        </>
      }
      triggerAs="button"
      triggerProps={{
        type: "button",
        class: "documents-new-trigger",
        disabled: props.projects.length === 0 || props.creating,
        "aria-label": "New document",
      }}
    >
      <div class="documents-new-list-host">
        <List<DocumentProjectIdentity>
          class="documents-new-list"
          search={{ placeholder: "Search projects…", autofocus: true }}
          key={(project) => project.id}
          // Match on both the shown name and the full path, so a search like
          // "live-mcp" finds a project the basename alone would hide.
          filterKeys={["label", "detail"]}
          items={props.projects}
          emptyMessage="No matching projects"
          onSelect={(project) => {
            if (!project) return
            props.onCreate(project.id)
            setOpen(false)
          }}
        >
          {(project) => (
            <span class="documents-new-option" title={project.detail}>
              <SemanticIcon concept="project" size="small" class="documents-project-icon" />
              <span class="documents-new-option-label">{project.label}</span>
            </span>
          )}
        </List>
      </div>
    </Popover>
  )
}

type FilterOption = { id: string; label: string; color?: string }

/** A Stripe-style filter pill: ghost while unset, `Label: value` once it carries
 *  one, and the full option list a click away. */
function FilterChip(props: {
  label: string
  value?: string
  options: FilterOption[]
  onSelect: (id?: string) => void
}) {
  const [open, setOpen] = createSignal(false)
  const selected = () => props.options.find((option) => option.id === props.value)
  return (
    <Popover
      placement="bottom-start"
      portal
      open={open()}
      onOpenChange={setOpen}
      class="documents-filter-popover"
      trigger={
        <>
          <span class="documents-chip-label">{props.label}</span>
          <Show when={selected()}>{(option) => <span class="documents-chip-value">{option().label}</span>}</Show>
          <Icon name="chevron-down" size="small" class="documents-chip-caret" />
        </>
      }
      triggerAs="button"
      triggerProps={{
        type: "button",
        class: `documents-chip${selected() ? " documents-chip--active" : ""}`,
        "aria-label": `Filter by ${props.label.toLowerCase()}`,
      }}
    >
      <div class="documents-menu" role="menu">
        <button
          type="button"
          role="menuitemradio"
          aria-checked={!props.value == null ? undefined : !props.value ? "true" : "false"}
          class="documents-menu-item"
          onClick={() => {
            props.onSelect(undefined)
            setOpen(false)
          }}
        >
          <span class="documents-menu-label">All {props.label.toLowerCase()}s</span>
          <Show when={!props.value}>
            <Icon name="check" size="small" class="documents-menu-check" />
          </Show>
        </button>
        <For each={props.options}>
          {(option) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={
                (props.value === option.id) == null ? undefined : props.value === option.id ? "true" : "false"
              }
              class="documents-menu-item"
              onClick={() => {
                props.onSelect(option.id)
                setOpen(false)
              }}
            >
              <Show when={option.color}>
                <span class="documents-status-dot" style={{ "--current-status-color": option.color }} />
              </Show>
              <span class="documents-menu-label">{option.label}</span>
              <Show when={props.value === option.id}>
                <Icon name="check" size="small" class="documents-menu-check" />
              </Show>
            </button>
          )}
        </For>
      </div>
    </Popover>
  )
}
