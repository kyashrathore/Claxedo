import { createMemo, For, Match, Show, Switch, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import type { PlacementId } from "@/server"
import { useFilesApi } from "../api"
import { fetchView } from "../model"
import { useFiles } from "../store"
import { t } from "../i18n"
import { FailedNotice, PlaceholderRows } from "./placeholder"
import { FileTree } from "./file-tree"

export function FilesTab(): JSX.Element {
  const files = useFiles()
  return (
    <div data-component="files-tab" class="flex size-full min-h-0 flex-col">
      <Show when={files.placementId()} fallback={<EmptyNotice message={t("files.noPlacement")} />}>
        {(placementId) => (
          <>
            <SearchField />
            <div class="min-h-0 flex-1 overflow-auto">
              <Show when={files.search().trim()} fallback={<FileTree placementId={placementId()} />}>
                {(query) => <SearchResults placementId={placementId()} query={query()} />}
              </Show>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}

function EmptyNotice(props: { readonly message: string }) {
  return <div class="px-3 py-6 text-center text-12-regular text-text-weak">{props.message}</div>
}

function SearchField() {
  const files = useFiles()
  return (
    <div class="flex h-11 shrink-0 items-center gap-1 border-b border-border-weak-base px-2">
      <input
        type="search"
        value={files.search()}
        placeholder={t("files.search")}
        aria-label={t("files.search")}
        class="h-8 min-w-0 flex-1 rounded-md border border-border-weak-base bg-surface-base px-2 text-12-regular text-text-base outline-none placeholder:text-text-weak focus:border-border-strong-base"
        onInput={(event) => files.setSearch(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") files.setSearch("")
        }}
      />
      <Show when={files.search()}>
        <button
          type="button"
          aria-label={t("files.clearSearch")}
          class="flex size-8 items-center justify-center rounded-md text-text-weak hover:bg-surface-base-hover pointer-coarse:size-11"
          onClick={() => files.setSearch("")}
        >
          ×
        </button>
      </Show>
    </div>
  )
}

function SearchResults(props: { readonly placementId: PlacementId; readonly query: string }) {
  const api = useFilesApi()
  const files = useFiles()
  const results = useQuery(() => api.search(props.placementId, props.query))
  const view = createMemo(() => fetchView(results))
  const failed = createMemo(() => {
    const current = view()
    return current.kind === "failed" ? current : undefined
  })
  const paths = createMemo(() => {
    const current = view()
    return current.kind === "ready" ? current.data : undefined
  })
  return (
    <Switch>
      <Match when={view().kind === "loading"}>
        <PlaceholderRows label={t("files.searching")} />
      </Match>
      <Match when={failed()}>
        {(failure) => (
          <FailedNotice message={failure().error.message} retryLabel={t("files.retry")} onRetry={() => void results.refetch()} />
        )}
      </Match>
      <Match when={paths()}>
        {(found) => (
          <Show when={found().length > 0} fallback={<EmptyNotice message={t("files.noResults")} />}>
            <ul class="flex flex-col gap-0.5 p-1" aria-label={t("files.results")}>
              <For each={found()}>
                {(path) => (
                  <li>
                    <button
                      type="button"
                      class="flex h-7 w-full min-w-0 items-center rounded-md px-2 text-left text-12-medium text-text-base hover:bg-surface-base-hover pointer-coarse:min-h-11"
                      onClick={() => files.openPane("file", { placementId: props.placementId, path })}
                    >
                      <span class="min-w-0 truncate">{path}</span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        )}
      </Match>
    </Switch>
  )
}
