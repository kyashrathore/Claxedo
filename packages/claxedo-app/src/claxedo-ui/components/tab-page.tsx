import { createEffect, createSignal, Match, on, Switch } from "solid-js"
import { pagesApi, type Page } from "../../utils/pages-api"
import PageEditor, { loadTiptap, type PageEditorProps } from "./page-editor"

export type TabPageProps = {
  pageId: string
  sessionId?: string
  directory?: string
  filePath?: string
  leafId?: string
  tabId?: string
  onTitleChange?: (title: string) => void
  onBackToIndex?: () => void
}

function Loading() {
  return (
    <div class="flex items-center gap-2 px-4 py-6 text-text-weak">
      <div class="size-4 rounded-full border-2 border-text-weak border-t-transparent animate-spin" />
      <span>Loading...</span>
    </div>
  )
}

export function TabPage(props: TabPageProps) {
  const [page, setPage] = createSignal<Page | undefined>()
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | undefined>()
  const [saving, setSaving] = createSignal(false)

  const loadPage = (id: string) => {
    setLoading(true)
    setError(undefined)
    void loadTiptap()
    pagesApi
      .get(id)
      .then((page) => {
        setPage(page)
        setLoading(false)
      })
      .catch((err: Error) => {
        setError(err.message)
        setLoading(false)
      })
  }

  const editor = (): PageEditorProps | undefined => {
    const next = page()
    if (!next) return
    return {
      page: next,
      pageId: props.pageId,
      sessionId: props.sessionId,
      directory: props.directory,
      filePath: props.filePath,
      leafId: props.leafId,
      tabId: props.tabId,
      saving: saving(),
      loading: loading(),
      onSavingChange: setSaving,
      onTitleChange: props.onTitleChange,
      onBackToIndex: props.onBackToIndex,
    }
  }

  loadPage(props.pageId)

  createEffect(
    on(
      () => props.pageId,
      (id) => loadPage(id),
      { defer: true },
    ),
  )

  return (
    <div class="relative flex flex-col size-full min-h-0 overflow-hidden bg-background-base">
      <div class="flex-1 min-h-0 overflow-auto">
        <Switch>
          <Match when={loading()}>
            <Loading />
          </Match>
          <Match when={error()}>{(err) => <div class="px-4 py-6 text-red-500/80">{err()}</div>}</Match>
          <Match when={editor()}>{(next) => <PageEditor {...next()} />}</Match>
          <Match when={!loading()}>
            <div class="px-4 py-6 text-text-weak">No content</div>
          </Match>
        </Switch>
      </div>
    </div>
  )
}
