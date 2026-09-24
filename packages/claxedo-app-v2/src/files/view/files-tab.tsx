import { createMemo, For, Match, Show, Switch, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useTranslator } from "@/i18n"
import { FailureNotice } from "@/lib/failure"
import type { PlacementId } from "@/server"
import { TextInput } from "@/ui"
import { useWorkbench } from "@/workbench"
import { useFilesApi } from "../api"
import { dictionary } from "../i18n"
import { fetchView } from "../model"
import { filePaneKind } from "../pane"
import { useFiles } from "../store"
import { FileTree } from "./file-tree"
import { PlaceholderRows } from "./placeholder"

export function FilesTab(): JSX.Element {
  const t = useTranslator(dictionary)
  const files = useFiles()
  return (
    <div data-testid="files-tab" class="flex size-full min-h-0 flex-col bg-background-base">
      <Show when={files.placementId()} keyed fallback={<p class="px-3 py-6 text-center text-sm text-text-muted">{t("files.noPlacement")}</p>}>
        {(placementId) => (
          <>
            <div class="shrink-0 border-b border-border-muted px-2 py-2">
              <TextInput
                type="search"
                value={files.search()}
                placeholder={t("files.search")}
                aria-label={t("files.search")}
                showClearButton={files.search().length > 0}
                clearLabel={t("files.clearSearch")}
                onClearClick={() => files.setSearch("")}
                onInput={(event) => files.setSearch(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") files.setSearch("")
                }}
              />
            </div>
            <div class="min-h-0 flex-1 overflow-auto">
              <Show when={files.search().trim()} fallback={<FileTree placementId={placementId} />}>
                {(query) => <SearchResults placementId={placementId} query={query()} />}
              </Show>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}

function SearchResults(props: { readonly placementId: PlacementId; readonly query: string }): JSX.Element {
  const t = useTranslator(dictionary)
  const api = useFilesApi()
  const workbench = useWorkbench()
  const results = useQuery(() => api.search(props.placementId, props.query))
  const view = createMemo(() => fetchView(results))
  const failed = createMemo(() => {
    const current = view()
    return current.kind === "failed" ? current.error : undefined
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
        {(error) => (
          <FailureNotice title={t("files.searchFailed")} message={error().message} retryLabel={t("files.retry")} onRetry={() => void results.refetch()} />
        )}
      </Match>
      <Match when={paths()}>
        {(found) => (
          <Show when={found().length > 0} fallback={<p class="px-3 py-6 text-center text-sm text-text-muted">{t("files.noResults")}</p>}>
            <ul class="flex flex-col gap-0.5 p-1" aria-label={t("files.results")}>
              <For each={found()}>
                {(path) => (
                  <li>
                    <button
                      type="button"
                      class="flex h-7 w-full min-w-0 items-center rounded-md px-2 text-left text-sm text-text-base hover:bg-overlay-hover pointer-coarse:min-h-11"
                      onClick={() => workbench.openPane(filePaneKind, { placementId: props.placementId, path })}
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
