import { createMemo, Match, Switch, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useTranslator } from "@/i18n"
import { FailureNotice } from "@/lib/failure"
import type { FileContent } from "@/server"
import type { PaneProps } from "@/shell"
import { File, type FileRevealHandle } from "@/transcript"
import { useFilesApi } from "../api"
import { dictionary } from "../i18n"
import { fetchView, fileView, type FilePaneState } from "../model"
import { basename } from "../path"
import { imagePreviewUrl } from "../preview"
import { PlaceholderRows } from "./placeholder"

const REVEAL_WINDOW_MS = 5000

export function FilePane(props: PaneProps<FilePaneState>): JSX.Element {
  const t = useTranslator(dictionary)
  const api = useFilesApi()
  const query = useQuery(() => api.content(props.state.placementId, props.state.path))
  const view = createMemo(() => fileView(fetchView(query)))
  const failed = createMemo(() => {
    const current = view()
    return current.kind === "failed" ? current.error : undefined
  })
  const content = createMemo(() => {
    const current = view()
    return current.kind === "ready" ? current.content : undefined
  })
  return (
    <div
      data-testid="file-pane"
      data-path={props.state.path}
      class="flex size-full min-h-0 flex-col overflow-auto bg-background-base"
    >
      <Switch>
        <Match when={view().kind === "loading"}>
          <PlaceholderRows label={t("files.loading")} rows={5} />
        </Match>
        <Match when={view().kind === "missing"}>
          <p role="status" class="px-3 py-6 text-center text-sm text-text-muted">
            {t("files.missing")}
          </p>
        </Match>
        <Match when={failed()}>
          {(error) => (
            <FailureNotice
              title={t("files.readFailed")}
              message={error().message}
              retryLabel={t("files.retry")}
              onRetry={() => void query.refetch()}
            />
          )}
        </Match>
        <Match when={content()}>
          {(ready) => <FileBody path={props.state.path} content={ready()} line={props.state.line} />}
        </Match>
      </Switch>
    </div>
  )
}

function FileBody(props: {
  readonly path: string
  readonly content: FileContent
  readonly line?: number
}): JSX.Element {
  const t = useTranslator(dictionary)
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
        <p role="status" class="px-3 py-6 text-center text-sm text-text-muted">
          {t("files.binary")}
        </p>
      </Match>
      <Match when={props.content.type === "text"}>
        <FileText path={props.path} text={props.content.content} line={props.line} />
      </Match>
    </Switch>
  )
}

function FileText(props: { readonly path: string; readonly text: string; readonly line?: number }): JSX.Element {
  let handle: FileRevealHandle | null = null
  const revealUntil = performance.now() + REVEAL_WINDOW_MS
  const reveal = () => {
    if (props.line === undefined || performance.now() > revealUntil) return
    handle?.revealLine(props.line)
  }
  const file = createMemo(() => ({ name: basename(props.path), contents: props.text }))
  return (
    <File
      mode="text"
      file={file()}
      overflow="wrap"
      class="select-text"
      reveal={{ register: (next) => (handle = next) }}
      onRendered={reveal}
      selectedLines={props.line === undefined ? null : { start: props.line, end: props.line }}
    />
  )
}
