import { createEffect, createMemo, createSignal, onCleanup, Show, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useTranslator } from "@/i18n"
import { useServer, type PlacementId } from "@/server"
import { ClaxedoIcon as Icon, DelayedLoading } from "@/ui"
import { useFilesApi } from "../api"
import { dictionary } from "../i18n"
import { buildKinds } from "../model"
import { useFiles } from "../store"
import { createTreeSource } from "../tree-source"
import { FileTree } from "./file-tree"

const PREFETCH_DELAY_MS = 120
const VISIBLE_LIMIT = 24

export type FilesNavigatorProps = {
  readonly placementId: PlacementId
  readonly active: boolean
  readonly activePath?: string
  readonly onOpenFile: (path: string) => void
}

function createHoverPrefetch(placementId: () => PlacementId, active: () => boolean) {
  const api = useFilesApi()
  const server = useServer()
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => clearTimeout(timer)
  onCleanup(cancel)
  return {
    start: (path: string) => {
      cancel()
      if (!active()) return
      timer = setTimeout(
        () => void server.queryClient.prefetchQuery(api.content(placementId(), path)),
        PREFETCH_DELAY_MS,
      )
    },
    cancel,
  }
}

function revealActivePath(input: {
  readonly path: () => string | undefined
  readonly active: () => boolean
  readonly expand: (dir: string) => void
  readonly scroller: () => HTMLDivElement | undefined
}): void {
  createEffect(() => {
    const path = input.path()
    if (!path || !input.active()) return
    const segments = path.split("/").slice(0, -1)
    for (const [index] of segments.entries()) input.expand(segments.slice(0, index + 1).join("/"))
    const reveal = () => {
      const row = input.scroller()?.querySelector(`[data-file-tree-path="${CSS.escape(path)}"]`)
      row?.scrollIntoView({ block: "nearest" })
      return !!row
    }
    let observer: MutationObserver | undefined
    const frame = requestAnimationFrame(() => {
      const scroller = input.scroller()
      if (reveal() || !scroller) return
      observer = new MutationObserver(() => {
        if (reveal()) observer?.disconnect()
      })
      observer.observe(scroller, { childList: true, subtree: true })
    })
    onCleanup(() => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
    })
  })
}

function SearchRow(): JSX.Element {
  const t = useTranslator(dictionary)
  const files = useFiles()
  return (
    <div class="shrink-0 flex items-center gap-1 px-2 h-9 border-b border-border-weak-base">
      <Icon name="magnifying-glass" size="small" class="text-icon-weak-base shrink-0" />
      <div class="flex min-w-0 flex-1 items-center rounded-md border border-transparent bg-surface-base px-2 focus-within:border-border-strong-base focus-within:bg-background-base">
        <input
          type="text"
          value={files.search()}
          placeholder={t("files.search")}
          autofocus
          class="flex-1 min-w-0 bg-transparent text-sm text-text-base placeholder:text-text-weak/60 outline-none"
          onInput={(event) => files.setSearch(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") files.setSearch("")
          }}
        />
      </div>
      <Show when={files.search().trim()}>
        <button
          type="button"
          aria-label={t("files.clearSearch")}
          onClick={() => files.setSearch("")}
          class="flex items-center justify-center size-6 rounded text-icon-weak-base hover:text-icon-base transition-colors cursor-pointer"
        >
          <Icon name="close-small" size="small" />
        </button>
      </Show>
    </div>
  )
}

export function FilesNavigator(props: FilesNavigatorProps): JSX.Element {
  const t = useTranslator(dictionary)
  const api = useFilesApi()
  const files = useFiles()
  const source = createTreeSource(
    () => props.placementId,
    () => props.active,
  )
  const prefetch = createHoverPrefetch(
    () => props.placementId,
    () => props.active,
  )
  const query = createMemo(() => files.search().trim())
  const search = useQuery(() => ({ ...api.search(props.placementId, query()), enabled: query().length > 0 }))
  const status = useQuery(() => ({ ...api.changes(props.placementId), enabled: props.active }))
  const kinds = createMemo(() => buildKinds(status.data))
  const changed = createMemo(() =>
    [...(status.data?.staged ?? []), ...(status.data?.unstaged ?? [])].map((change) => change.path),
  )
  const allowed = createMemo<readonly string[] | undefined>((previous) => {
    if (!query()) return undefined
    return search.isSuccess ? search.data : previous
  }, undefined)
  const searchPending = () => !!query() && search.isPending
  const emptySearch = () => !!query() && search.isSuccess && (allowed()?.length ?? 0) === 0
  const showTree = () => !searchPending() && !emptySearch()
  const [scroller, setScroller] = createSignal<HTMLDivElement>()
  revealActivePath({ path: () => props.activePath, active: () => props.active, expand: source.expand, scroller })
  return (
    <div data-testid="workspace-files-navigator" data-mode="files" class="flex size-full min-h-0 flex-col">
      <SearchRow />
      <div class="min-h-0 flex-1 overflow-auto" ref={setScroller}>
        <Show when={searchPending()}>
          <div class="flex h-24 items-center justify-center">
            <DelayedLoading>
              <Spinner class="h-4 w-4 text-text-weak" />
            </DelayedLoading>
          </div>
        </Show>
        <Show when={emptySearch()}>
          <div class="px-3 py-6 text-center text-12-regular text-text-weak">{t("files.noResults")}</div>
        </Show>
        <div style={{ "content-visibility": showTree() ? "visible" : "hidden" }}>
          <FileTree
            source={source}
            path=""
            enabled={props.active && showTree()}
            allowed={allowed()}
            modified={changed()}
            kinds={kinds()}
            active={props.activePath}
            visibleLimit={VISIBLE_LIMIT}
            onFilePointerEnter={(node) => prefetch.start(node.path)}
            onFilePointerLeave={() => prefetch.cancel()}
            onFileClick={(node) => props.onOpenFile(node.path)}
          />
        </div>
      </div>
    </div>
  )
}
