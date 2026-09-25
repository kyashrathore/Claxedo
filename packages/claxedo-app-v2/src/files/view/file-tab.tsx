import { createEffect, createMemo, createSignal, Match, on, onCleanup, Show, Switch, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { useQuery } from "@tanstack/solid-query"
import type { SelectedLineRange } from "@pierre/diffs"
import { useTranslator } from "@/i18n"
import type { FileContent, PlacementId } from "@/server"
import { File, Markdown, type FileRevealHandle } from "@/transcript"
import { ClaxedoIconButton as IconButton, DelayedLoading, fileHeaderActionsSlot, FileIcon, Tooltip, checksum } from "@/ui"
import { useFilesApi } from "../api"
import { filesDictionary } from "../i18n"
import { basename } from "../path"
import { imagePreviewUrl, isMarkdownPath } from "../preview"
import { useFiles } from "../store"
import { createFileComments, type FileCommentProps, type FileLineComments } from "./file-comments"

const FOCUS_FRESH_MS = 5000
const COPIED_MS = 2000

export type FileTabProps = {
  readonly placementId: PlacementId
  readonly path: string
  readonly headerActive: boolean
  readonly focusLine?: number
  readonly focusNonce?: number
  readonly comments?: FileLineComments
}

type TextFile = { readonly name: string; readonly contents: string; readonly cacheKey: string | undefined }

function CopyPathAction(props: { readonly path: string }): JSX.Element {
  const t = useTranslator(filesDictionary)
  const [copied, setCopied] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))
  const copy = () => {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
    if (!clipboard?.writeText) return
    void clipboard.writeText(props.path).then(
      () => {
        setCopied(true)
        clearTimeout(timer)
        timer = setTimeout(() => setCopied(false), COPIED_MS)
      },
      (error: unknown) => console.warn("Copying the relative path failed", error),
    )
  }
  const label = () => (copied() ? t("files.tab.copiedPath") : t("files.tab.copyPath"))
  return (
    <Tooltip value={label()}>
      <IconButton
        icon={copied() ? "check" : "copy"}
        variant="ghost"
        size="small"
        data-icon-interaction="subdued"
        onClick={copy}
        aria-label={label()}
      />
    </Tooltip>
  )
}

function createFocusReveal(props: FileTabProps) {
  let handle: FileRevealHandle | null = null
  let freshUntil = 0
  const revealLine = () => {
    const line = props.focusLine
    if (line === undefined || line <= 0 || performance.now() > freshUntil) return
    handle?.revealLine(line)
  }
  createEffect(
    on(
      () => [props.focusLine, props.focusNonce] as const,
      () => {
        freshUntil = performance.now() + FOCUS_FRESH_MS
        revealLine()
      },
    ),
  )
  const [manual, setManual] = createSignal<{
    readonly atNonce: number | undefined
    readonly range: SelectedLineRange | null
  }>()
  const selected = createMemo<SelectedLineRange | null>(() => {
    const current = manual()
    if (current && current.atNonce === props.focusNonce) return current.range
    return props.focusLine !== undefined && props.focusLine > 0
      ? { start: props.focusLine, end: props.focusLine }
      : null
  })
  return {
    control: { register: (next: FileRevealHandle | null) => (handle = next) },
    revealLine,
    selected,
    select: (range: SelectedLineRange | null) => setManual({ atNonce: props.focusNonce, range }),
  }
}

function FileText(props: {
  readonly file: TextFile
  readonly previewing: boolean
  readonly focus: ReturnType<typeof createFocusReveal>
  readonly comments: FileCommentProps
  readonly onRendered: () => void
}): JSX.Element {
  return (
    <>
      <div class={props.previewing ? "hidden" : undefined}>
        <File
          mode="text"
          file={props.file}
          overflow="wrap"
          class="select-text"
          reveal={props.focus.control}
          onRendered={() => {
            props.onRendered()
            props.focus.revealLine()
          }}
          enableLineSelection={true}
          selectedLines={props.focus.selected()}
          onLineSelected={props.focus.select}
          {...props.comments}
        />
      </div>
      <Show when={props.previewing}>
        <div class="px-6 py-4">
          <Markdown text={props.file.contents} />
        </div>
      </Show>
    </>
  )
}

function BinaryNotice(props: { readonly path: string }): JSX.Element {
  const t = useTranslator(filesDictionary)
  return (
    <div class="flex min-h-full flex-col items-center justify-center gap-2 px-4 py-10 text-center text-text-weak">
      <FileIcon node={{ path: props.path, type: "file" }} class="size-8 opacity-70" />
      <div class="text-sm text-text-base">{basename(props.path)}</div>
      <div class="text-xs">{t("files.tab.binary")}</div>
    </div>
  )
}

function renderState(file: TextFile | undefined, renderedKey: string | undefined): string | undefined {
  if (!file) return undefined
  return renderedKey === file.cacheKey ? "painted" : "pending"
}

export function FileTab(props: FileTabProps): JSX.Element {
  const t = useTranslator(filesDictionary)
  const api = useFilesApi()
  const files = useFiles()
  const query = useQuery(() => api.content(props.placementId, props.path))
  const focus = createFocusReveal(props)
  const [renderedKey, setRenderedKey] = createSignal<string>()
  const data = (): FileContent | undefined => (query.isSuccess ? query.data : undefined)
  const error = () => (query.isError ? query.error.message : undefined)
  const content = () => {
    const current = data()
    return current?.type === "text" ? current.content : undefined
  }
  const file = createMemo((): TextFile | undefined => {
    const text = content()
    return text ? { name: basename(props.path), contents: text, cacheKey: checksum(text) } : undefined
  })
  const imageSrc = createMemo(() => {
    const current = data()
    return current ? imagePreviewUrl(props.path, current) : undefined
  })
  const binary = () => data()?.type === "binary" && !imageSrc()
  const store = props.comments
  const commentProps = store
    ? createFileComments({
        path: () => props.path,
        contents: content,
        store,
        selected: focus.selected,
        setSelected: focus.select,
      })
    : {}
  const lines = () => {
    const value = content()
    return value ? value.split("\n").length - (value.endsWith("\n") ? 1 : 0) : 0
  }
  const state = () => {
    if (query.isPending) return "loading"
    if (error()) return "error"
    return file() || imageSrc() || binary() ? "ready" : "empty"
  }
  return (
    <div
      data-testid="tab-file-root"
      data-tab-file-path={props.path}
      data-tab-file-state={state()}
      data-tab-file-content-chars={content()?.length ?? 0}
      data-tab-file-content-lines={lines()}
      data-tab-file-render-state={renderState(file(), renderedKey())}
      data-tab-file-rendered-cache-key={renderedKey()}
      class="relative flex flex-col size-full min-h-0 overflow-hidden bg-background-base h-full"
    >
      <Show when={props.headerActive && fileHeaderActionsSlot()}>
        {(mount) => (
          <Portal mount={mount()}>
            <div class="flex shrink-0 items-center gap-0.5">
              <CopyPathAction path={props.path} />
            </div>
          </Portal>
        )}
      </Show>
      <div class="flex-1 min-h-0 overflow-auto">
        <Switch fallback={<div class="px-4 py-6 text-text-weak">{t("files.tab.empty")}</div>}>
          <Match when={query.isPending}>
            <DelayedLoading>
              <div class="flex items-center gap-2 px-4 py-6 text-text-weak">
                <div class="size-4 rounded-full border-2 border-text-weak border-t-transparent animate-spin" />
                <span>{t("files.tab.loading")}</span>
              </div>
            </DelayedLoading>
          </Match>
          <Match when={error()}>
            {(message) => <div class="px-4 py-6 text-text-on-critical-base">{message()}</div>}
          </Match>
          <Match when={imageSrc()}>
            {(src) => (
              <div class="flex min-h-full items-center justify-center p-6">
                <img
                  src={src()}
                  alt={basename(props.path)}
                  class="max-h-full max-w-full object-contain"
                  style={{ "image-rendering": "auto" }}
                />
              </div>
            )}
          </Match>
          <Match when={binary()}>
            <BinaryNotice path={props.path} />
          </Match>
          <Match when={file()}>
            {(current) => (
              <FileText
                file={current()}
                previewing={isMarkdownPath(props.path) && !files.markdownSource(props.path)}
                focus={focus}
                comments={commentProps}
                onRendered={() => setRenderedKey(file()?.cacheKey)}
              />
            )}
          </Match>
        </Switch>
      </div>
    </div>
  )
}
