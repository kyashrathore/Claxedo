import { createMemo, Match, Show, Switch, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import type { FileContent } from "@/server"
import type { PaneProps } from "@/shell/types"
import { useFilesApi } from "../api"
import { fetchView, fileView, type FilePaneState } from "../model"
import { imagePreviewUrl } from "../preview"
import { t } from "../i18n"
import { FailedNotice, PlaceholderRows } from "./placeholder"
import { TextLines } from "./text-lines"

export function FilePane(props: PaneProps<FilePaneState>): JSX.Element {
  const api = useFilesApi()
  const query = useQuery(() => api.content(props.state.placementId, props.state.path))
  const view = createMemo(() => fileView(fetchView(query)))
  const failed = createMemo(() => {
    const current = view()
    return current.kind === "failed" ? current : undefined
  })
  const content = createMemo(() => {
    const current = view()
    return current.kind === "ready" ? current.content : undefined
  })
  return (
    <div data-component="file-pane" data-path={props.state.path} class="flex size-full min-h-0 flex-col bg-background-base">
      <header class="flex h-9 shrink-0 items-center border-b border-border-weak-base px-3 text-12-medium text-text-base">
        <span class="min-w-0 truncate" title={props.state.path}>
          {props.state.path}
        </span>
      </header>
      <div class="min-h-0 flex-1 overflow-auto">
        <Switch>
          <Match when={view().kind === "loading"}>
            <PlaceholderRows label={t("files.loading")} rows={5} />
          </Match>
          <Match when={view().kind === "missing"}>
            <div role="status" class="px-3 py-6 text-center text-12-regular text-text-weak">
              {t("files.missing")}
            </div>
          </Match>
          <Match when={failed()}>
            {(failure) => (
              <FailedNotice message={failure().error.message} retryLabel={t("files.retry")} onRetry={() => void query.refetch()} />
            )}
          </Match>
          <Match when={content()}>
            {(ready) => <FileBody path={props.state.path} content={ready()} line={props.state.line} />}
          </Match>
        </Switch>
      </div>
    </div>
  )
}

function FileBody(props: { readonly path: string; readonly content: FileContent; readonly line?: number }) {
  const image = () => imagePreviewUrl(props.path, props.content)
  return (
    <Switch>
      <Match when={image()}>
        {(url) => (
          <div class="flex min-h-full items-center justify-center p-4">
            <img src={url()} alt={props.path} class="max-h-full max-w-full" />
          </div>
        )}
      </Match>
      <Match when={props.content.type === "binary"}>
        <div role="status" class="px-3 py-6 text-center text-12-regular text-text-weak">
          {t("files.binary")}
        </div>
      </Match>
      <Match when={props.content.type === "text"}>
        <TextLines text={props.content.content} line={props.line} label={props.path} />
      </Match>
    </Switch>
  )
}
