import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { documentsApi, type DocumentQuery, type DocumentSummary, type DocumentsApi } from "../data/documents-api"

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
  let stopped = true
  let retryAttempt = 0
  let abort: AbortController | undefined
  let cancelRetry: (() => void) | undefined

  const load = async (loading = true) => {
    if (loading) state.loading = true
    state.error = undefined
    emit()
    try {
      state.documents = await input.api.list(input.query)
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
      input.onError(error)
    }
    state.loading = false
    emit()
  }

  const connect = () => {
    if (stopped) return
    abort = new AbortController()
    void input.api
      .watch(
        input.query,
        (event) => {
          if (event.type === "document.connected") {
            const reconnected = state.connection === "reconnecting"
            state.connection = "connected"
            retryAttempt = 0
            emit()
            if (reconnected) void load(false)
            return
          }
          if (event.type === "document.changed") void load(false)
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
      stopped = true
      abort?.abort()
      cancelRetry?.()
    },
  }
}

type Project = { id: string; worktree: string }

export type PageIndexProps = {
  scope: "all" | "project" | "global"
  directory?: string
  projects: Project[]
  onOpenPage: (document: DocumentSummary) => void
}

export function PageIndex(props: PageIndexProps) {
  const [state, setState] = createSignal<IndexState>({ documents: [], loading: true, connection: "connecting" })
  const query = (): DocumentQuery => ({
    directory: props.scope === "project" ? props.directory : undefined,
    projectId: !props.directory ? props.projects[0]?.id : undefined,
  })
  const controller = createDocumentIndexController({
    query: query(),
    api: documentsApi,
    schedule: (handler, delay) => {
      const timer = setTimeout(handler, delay)
      return () => clearTimeout(timer)
    },
    onChange: setState,
    onError: (error) => console.error(error),
  })

  onMount(() => {
    if (!query().projectId && !query().directory) {
      setState({
        documents: [],
        loading: false,
        connection: "connecting",
        error: "Choose a project to view Documents.",
      })
      return
    }
    void controller.load()
    controller.start()
  })
  onCleanup(controller.stop)

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
            disabled
            title="Repository import will be available when repository routing is connected."
          >
            Add to Documents
          </button>
          <button
            type="button"
            class="rounded bg-surface-raised-base px-3 py-1.5 text-xs font-medium text-text-strong focus-visible:outline focus-visible:outline-2"
            disabled={!query().projectId && !query().directory}
            onClick={() =>
              void documentsApi
                .create({
                  projectId: query().projectId,
                  directory: query().directory,
                  displayName: "Untitled document",
                })
                .then(props.onOpenPage, (error) =>
                  setState({ ...state(), error: error instanceof Error ? error.message : String(error) }),
                )
            }
          >
            New document
          </button>
          <span class="text-xs text-text-weak" role="status" aria-live="polite">
            {state().connection === "reconnecting" ? "Reconnecting…" : `${state().documents.length} documents`}
          </span>
        </div>
      </header>
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
                  <button
                    type="button"
                    class="flex w-full items-center justify-between gap-4 px-2 py-3 text-left hover:bg-surface-raised-base focus-visible:outline focus-visible:outline-2"
                    onClick={() => props.onOpenPage(document)}
                  >
                    <span class="min-w-0">
                      <span class="block truncate text-sm font-medium text-text-strong">{document.display_name}</span>
                      <span class="mt-0.5 block truncate text-xs text-text-weak">
                        {document.origin_kind === "repository" ? document.repository_relative_path : "Managed document"}
                      </span>
                    </span>
                    <span class="shrink-0 text-xs text-text-weak">{document.status}</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </main>
  )
}
