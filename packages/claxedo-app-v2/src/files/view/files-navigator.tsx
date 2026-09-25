import { createEffect, createMemo, createSignal, on, Show, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useTranslator } from "@/i18n"
import type { PlacementId } from "@/server"
import { ClaxedoIcon as Icon, DelayedLoading, Spinner, ScrollView } from "@/ui"
import { useFilesApi } from "../api"
import { filesDictionary } from "../i18n"
import { buildKinds } from "../model"
import { useFiles } from "../store"
import { createSearchView } from "../search-view"
import { FileTree } from "./file-tree"

const VISIBLE_LIMIT = 24

export type FilesNavigatorProps = {
  readonly placementId: PlacementId
  readonly active: boolean
  readonly activePath?: string
  readonly onOpenFile: (path: string) => void
}

function expandToActivePath(input: {
  readonly path: () => string | undefined
  readonly active: () => boolean
  readonly expand: (dir: string) => void
}): void {
  createEffect(
    on([input.path, input.active], ([path, active]) => {
      if (!path || !active) return
      const segments = path.split("/").slice(0, -1)
      for (const [index] of segments.entries()) input.expand(segments.slice(0, index + 1).join("/"))
    }),
  )
}

function SearchRow(): JSX.Element {
  const t = useTranslator(filesDictionary)
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
  const t = useTranslator(filesDictionary)
  const api = useFilesApi()
  const search = createSearchView(
    () => props.placementId,
    () => props.active,
  )
  const source = search.listing
  const status = useQuery(() => ({ ...api.changes(props.placementId), enabled: props.active }))
  const kinds = createMemo(() => buildKinds(status.data))
  const changed = createMemo(() =>
    [...(status.data?.staged ?? []), ...(status.data?.unstaged ?? [])].map((change) => change.path),
  )
  const showTree = () => !search.pending() && !search.empty()
  const [scroller, setScroller] = createSignal<HTMLDivElement>()
  const dataReady = () => source.state("").loaded && source.children("").length > 0
  expandToActivePath({ path: () => props.activePath, active: () => props.active, expand: source.expand })
  return (
    <div
      data-testid="workspace-files-navigator"
      data-mode="files"
      data-file-tree-shell-ready={dataReady() || (!search.query() && source.state("").loading) ? "true" : undefined}
      data-file-tree-data-ready={dataReady() ? "true" : undefined}
      class="flex size-full min-h-0 flex-col"
    >
      <SearchRow />
      <ScrollView class="min-h-0 flex-1" viewportRef={setScroller}>
        <Show when={search.pending()}>
          <div class="flex h-24 items-center justify-center">
            <DelayedLoading>
              <Spinner class="h-4 w-4 text-text-weak" />
            </DelayedLoading>
          </div>
        </Show>
        <Show when={search.empty()}>
          <div class="px-3 py-6 text-center text-12-regular text-text-weak">{t("files.noResults")}</div>
        </Show>
        <div style={{ "content-visibility": showTree() ? "visible" : "hidden" }}>
          <FileTree
            source={search.source()}
            scroller={scroller}
            reveal={props.active ? props.activePath : undefined}
            modified={changed()}
            kinds={kinds()}
            active={props.activePath}
            visibleLimit={VISIBLE_LIMIT}
            onFileClick={(node) => props.onOpenFile(node.path)}
          />
        </div>
      </ScrollView>
    </div>
  )
}
