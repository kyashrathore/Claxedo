import { For, Show, createResource, createSignal, onCleanup } from "solid-js"
import {
  documentsApi,
  type DocumentQuery,
  type DocumentStatus,
  type DocumentSummary,
  type DocumentsApi,
} from "../data/documents-api"

type IndexState = {
  documents: DocumentSummary[]
  loading: boolean
  error?: string
  connection: "connecting" | "connected" | "reconnecting"
}

export function createDocumentIndexController(input: {
  query: DocumentQuery
  api: DocumentsApi
  schedule: (handler: () => void, delay: number) => () => void
  onChange: (state: IndexState) => void
  onError: (error: unknown) => void
}) {
  const state: IndexState = { documents: [], loading: true, connection: "connecting" }
  const emit = () => input.onChange({ ...state, documents: [...state.documents] })
  let stopped = false
  let retryAttempt = 0
  let abort: AbortController | undefined
  let cancelRetry: (() => void) | undefined
  let loadSequence = 0
  let refreshing = false
  let refreshAgain = false

  const load = async (loading = true) => {
    if (stopped) return
    const request = ++loadSequence
    if (loading) state.loading = true
    state.error = undefined
    emit()
    try {
      const documents = await input.api.list(input.query)
      if (stopped || request !== loadSequence) return
      state.documents = documents
    } catch (error) {
      if (stopped || request !== loadSequence) return
      state.error = error instanceof Error ? error.message : String(error)
      input.onError(error)
    }
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

  const connect = () => {
    if (stopped) return
    abort = new AbortController()
    void input.api
      .watch(
        input.query,
        (event) => {
          if (stopped) return
          if (event.type === "document.connected") {
            const reconnected = state.connection === "reconnecting"
            state.connection = "connected"
            retryAttempt = 0
            emit()
            if (reconnected) void refresh()
            return
          }
          if (event.type === "document.changed") void refresh()
        },
        abort.signal,
      )
      .then(() => {
        if (!stopped) reconnect(new Error("Document event stream closed."))
      }, reconnect)
  }

  const reconnect = (error: unknown) => {
    if (stopped || abort?.signal.aborted) return
    input.onError(error)
    state.connection = "reconnecting"
    emit()
    const delay = Math.min(1_000 * 2 ** retryAttempt, 8_000)
    retryAttempt++
    cancelRetry = input.schedule(connect, delay)
  }

  return {
    snapshot: () => ({ ...state, documents: [...state.documents] }),
    load,
    start() {
      stopped = false
      connect()
    },
    stop() {
      refreshAgain = false
      loadSequence++
      stopped = true
      abort?.abort()
      cancelRetry?.()
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

export function repositoryDocumentPath(value: string) {
  const path = value.trim().replaceAll("\\", "/")
  if (!path) return { error: "Enter a repository Markdown path." } as const
  if (path.startsWith("/") || path.split("/").includes("..")) {
    return { error: "Use a relative path inside the repository." } as const
  }
  if (!/\.(?:md|markdown)$/i.test(path)) return { error: "Choose a Markdown file ending in .md or .markdown." } as const
  return { path } as const
}

export type PageIndexProps = {
  scope: "all" | "project" | "global"
  directory?: string
  projects: Project[]
  onOpenPage: (document: DocumentSummary) => void
}

export function PageIndex(props: PageIndexProps) {
  const [state, setState] = createSignal<IndexState>({ documents: [], loading: true, connection: "connecting" })
  const [statuses, setStatuses] = createSignal<DocumentStatus[]>([])
  const [importOpen, setImportOpen] = createSignal(false)
  const [importPath, setImportPath] = createSignal("")
  const [importing, setImporting] = createSignal(false)
  const [creating, setCreating] = createSignal(false)
  const placement = () => resolveDocumentProjectScope(props.projects, props.directory)
  const query = (): DocumentQuery => ({
    directory: props.scope === "project" ? props.directory : undefined,
    projectId: placement().projectId,
  })
  const workspaceId = () => placement().workspaceId
  let controller: ReturnType<typeof createDocumentIndexController> | undefined
  let generation = 0
  let importRequest = 0
  let createRequest = 0

  const currentScope = (started: {
    generation: number
    projectId?: string
    directory?: string
    workspaceId?: string
  }) => {
    const current = query()
    return (
      started.generation === generation &&
      started.projectId === current.projectId &&
      started.directory === current.directory &&
      started.workspaceId === workspaceId()
    )
  }

  createResource(
    () => ({ query: query(), workspaceId: placement().workspaceId }),
    (configuration) => {
      const currentQuery = configuration.query
      const currentGeneration = ++generation
      controller?.stop()
      controller = undefined
      setStatuses([])
      setImportOpen(false)
      setImportPath("")
      importRequest++
      createRequest++
      setImporting(false)
      setCreating(false)
      if (!currentQuery.projectId) {
        setState({
          documents: [],
          loading: false,
          connection: "connecting",
          error: "Choose a project to view Documents.",
        })
        return currentGeneration
      }
      const current = createDocumentIndexController({
        query: currentQuery,
        api: documentsApi,
        schedule: (handler, delay) => {
          const timer = setTimeout(handler, delay)
          return () => clearTimeout(timer)
        },
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
        documentsApi.listStatuses(currentQuery).then(
          (next) => {
            if (currentGeneration === generation) setStatuses(next)
          },
          (error) => {
            if (currentGeneration !== generation) return
            setState((value) => ({ ...value, error: error instanceof Error ? error.message : String(error) }))
          },
        ),
      ])
      return currentGeneration
    },
  )
  onCleanup(() => {
    generation++
    importRequest++
    createRequest++
    controller?.stop()
  })
  const importRepositoryDocument = async () => {
    if (importing()) return
    const parsed = repositoryDocumentPath(importPath())
    if ("error" in parsed) {
      setState({ ...state(), error: parsed.error })
      return
    }
    const workspace = workspaceId()
    if (!workspace) {
      setState({ ...state(), error: "Choose a workspace before adding a repository document." })
      return
    }
    const request = ++importRequest
    const started = {
      generation,
      ...query(),
      workspaceId: workspace,
    }
    setImporting(true)
    setState({ ...state(), error: undefined })
    try {
      const document = await documentsApi.createFromRepository({
        projectId: started.projectId,
        directory: started.directory,
        workspaceId: workspace,
        path: parsed.path,
        displayName: parsed.path.split("/").at(-1),
      })
      if (request !== importRequest || !currentScope(started)) return
      setImportOpen(false)
      setImportPath("")
      props.onOpenPage(document)
    } catch (error) {
      if (request !== importRequest || !currentScope(started)) return
      setState({ ...state(), error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (request === importRequest && currentScope(started)) setImporting(false)
    }
  }
  const createManagedDocument = async () => {
    if (creating()) return
    const started = { generation, ...query(), workspaceId: workspaceId() }
    if (!started.projectId) return
    const request = ++createRequest
    setCreating(true)
    try {
      const document = await documentsApi.create({
        projectId: started.projectId,
        directory: started.directory,
        displayName: "Untitled document",
      })
      if (request === createRequest && currentScope(started)) props.onOpenPage(document)
    } catch (error) {
      if (request !== createRequest || !currentScope(started)) return
      setState({ ...state(), error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (request === createRequest && currentScope(started)) setCreating(false)
    }
  }

  return (
    <main class="size-full overflow-auto bg-background-base px-6 py-6" aria-labelledby="documents-index-title">
      <header class="mb-5 flex items-end justify-between gap-4 border-b border-border-weak-base pb-4">
        <div>
          <h1 id="documents-index-title" class="text-lg font-medium text-text-strong">
            Documents
          </h1>
          <p class="mt-1 text-xs text-text-weak">Markdown files available in this project.</p>
        </div>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="rounded px-2 py-1.5 text-xs text-text-weak focus-visible:outline focus-visible:outline-2"
            disabled={!workspaceId()}
            onClick={() => setImportOpen(true)}
          >
            Add to Documents
          </button>
          <button
            type="button"
            class="rounded bg-surface-raised-base px-3 py-1.5 text-xs font-medium text-text-strong focus-visible:outline focus-visible:outline-2"
            disabled={!query().projectId || creating()}
            aria-busy={creating()}
            onClick={() => void createManagedDocument()}
          >
            New document
          </button>
          <span class="text-xs text-text-weak" role="status" aria-live="polite">
            {state().connection === "reconnecting" ? "Reconnecting…" : `${state().documents.length} documents`}
          </span>
        </div>
      </header>
      <Show when={importOpen()}>
        <form
          role="dialog"
          aria-label="Add repository document"
          class="mb-5 flex items-end gap-3 rounded border border-border-weak-base bg-surface-raised-base p-4"
          onSubmit={(event) => {
            event.preventDefault()
            void importRepositoryDocument()
          }}
        >
          <label class="min-w-0 flex-1 text-xs text-text-weak">
            Repository Markdown path
            <input
              aria-label="Repository Markdown path"
              class="mt-1 w-full rounded border border-border-weak-base bg-background-base px-3 py-2 text-sm text-text-strong outline-none focus-visible:outline focus-visible:outline-2"
              placeholder="docs/plan.md"
              value={importPath()}
              onInput={(event) => setImportPath(event.currentTarget.value)}
            />
          </label>
          <button
            type="button"
            class="rounded px-3 py-2 text-xs text-text-weak hover:bg-background-base"
            onClick={() => setImportOpen(false)}
          >
            Cancel
          </button>
          <button
            type="submit"
            class="rounded bg-background-base px-3 py-2 text-xs font-medium text-text-strong"
            disabled={importing()}
          >
            {importing() ? "Adding…" : "Add document"}
          </button>
        </form>
      </Show>
      <Show when={state().error}>
        <p class="mb-4 text-sm text-text-on-critical-base" role="alert">
          {state().error}
        </p>
      </Show>
      <Show
        when={!state().loading}
        fallback={
          <p class="text-sm text-text-weak" role="status">
            Loading documents…
          </p>
        }
      >
        <Show
          when={state().documents.length}
          fallback={<p class="py-12 text-center text-sm text-text-weak">No documents yet.</p>}
        >
          <ul class="divide-y divide-border-weak-base" aria-label="Documents">
            <For each={state().documents}>
              {(document) => (
                <li>
                  <div class="flex w-full items-center gap-4 px-2 py-3 hover:bg-surface-raised-base">
                    <button
                      type="button"
                      class="min-w-0 flex-1 text-left focus-visible:outline focus-visible:outline-2"
                      onClick={() => props.onOpenPage(document)}
                    >
                      <span class="min-w-0">
                        <span class="block truncate text-sm font-medium text-text-strong">{document.display_name}</span>
                        <span class="mt-0.5 block truncate text-xs text-text-weak">
                          {document.origin_kind === "repository"
                            ? document.repository_relative_path
                            : "Managed document"}
                        </span>
                      </span>
                    </button>
                    <select
                      aria-label={`Status for ${document.display_name}`}
                      class="shrink-0 rounded border border-border-weak-base bg-background-base px-2 py-1 text-xs text-text-weak"
                      value={document.status}
                      onChange={(event) => {
                        const status = event.currentTarget.value
                        void documentsApi.transitionStatus(document.id, status).then(
                          () => controller?.load(false),
                          (error) =>
                            setState({ ...state(), error: error instanceof Error ? error.message : String(error) }),
                        )
                      }}
                    >
                      <option value={document.status}>
                        {statuses().find((status) => status.id === document.status)?.name ?? document.status}
                      </option>
                      <For
                        each={statuses().filter((status) =>
                          statuses()
                            .find((current) => current.id === document.status)
                            ?.transitions.includes(status.id),
                        )}
                      >
                        {(status) => <option value={status.id}>{status.name}</option>}
                      </For>
                    </select>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </main>
  )
}
