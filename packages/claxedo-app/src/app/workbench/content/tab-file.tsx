// target-layer: surfaces/files (org doc §3c) — the ONE file view.
/**
 * Tab File Content
 *
 * File viewer for Claxedo file tabs with syntax highlighting and line numbers.
 * Uses SDK directly (not FileProvider) to avoid the legacy sync gate
 * which blocks rendering until sync data loads.
 * Renders via the `Code` component (@pierre/diffs) for full highlighting.
 *
 * Rendered inside SDKProvider only; no legacy sync or FileProvider needed.
 */

import { Match, Show, Switch, createEffect, createMemo, createSignal, on } from "solid-js"
import { useSDK } from "@/app/providers/sdk/sdk"
import { useComments } from "@/platform/comments/provider"
import { selectionFromLines, type FileSelection, type SelectedLineRange } from "@/app/providers/file"
import { useLanguage } from "@/platform/i18n/provider"
import { usePrompt } from "@/features/session/providers/prompt"
import { File, type TextFileProps } from "@/ui/session-kit"
import {
  createLineCommentController,
  type LineCommentAnnotationMeta,
} from "@/ui/session-kit"
import { Markdown } from "@/ui/session-kit"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { getFilename } from "@/lib/path"
import { checksum } from "@/lib/encode"
import type { LineComment } from "@/platform/comments/provider"

// Module-level signal tracking which file paths are in preview mode.
// Shared across all TabFile instances so the same file shows consistent state.
const [previewPaths, setPreviewPaths] = createSignal(new Set())

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path)
}

export function toggleMarkdownPreview(path: string) {
  setPreviewPaths((prev) => {
    const next = new Set(prev)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })
}

export type TabFileProps = {
  path: string
  class?: string
  hideHeader?: boolean
  onCollaborate?: () => void
}

export function TabFile(props: TabFileProps) {
  const sdk = useSDK()
  const comments = useComments()
  const language = useLanguage()
  const prompt = usePrompt()

  const [content, setContent] = createSignal<string | undefined>()
  const [error, setError] = createSignal<string | undefined>()
  const [loading, setLoading] = createSignal(true)
  const [openedComment, setOpenedComment] = createSignal<string | null>(null)
  const [commenting, setCommenting] = createSignal<SelectedLineRange | null>(null)
  const [selected, setSelected] = createSignal<SelectedLineRange | null>(null)
  let loadSeq = 0

  const loadFile = (path: string) => {
    if (!path) return
    const seq = ++loadSeq
    setLoading(true)
    setError(undefined)
    sdk.client.file
      .read({ path })
      .then((res) => {
        if (seq !== loadSeq) return
        setContent(res.data?.content)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (seq !== loadSeq) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
  }

  const scheduleLoadFile = (path: string) => {
    const load = () => loadFile(path)
    if (typeof requestAnimationFrame !== "function") {
      queueMicrotask(load)
      return
    }
    requestAnimationFrame(() => setTimeout(load, 0))
  }

  createEffect(
    on(
      () => props.path,
      (path) => scheduleLoadFile(path),
    ),
  )

  // Build FileContents for the Code component (name for syntax detection, contents, cacheKey)
  const file = createMemo(() => {
    const text = content()
    if (!text) return undefined
    return {
      name: getFilename(props.path),
      contents: text,
      cacheKey: checksum(text),
    }
  })

  const isMd = createMemo(() => isMarkdownPath(props.path))
  const previewing = createMemo(() => isMd() && previewPaths().has(props.path))
  const fileComments = createMemo(() => comments.list(props.path))
  const commentedLines = createMemo(() => fileComments().map((comment) => comment.selection))

  const buildPreview = (selection: FileSelection) => {
    const source = content()
    if (!source) return undefined
    const start = Math.max(1, Math.min(selection.startLine, selection.endLine))
    const end = Math.max(selection.startLine, selection.endLine)
    const lines = source.split("\n").slice(start - 1, end)
    if (lines.length === 0) return undefined
    return lines.slice(0, 2).join("\n")
  }

  const commentsUi = createLineCommentController({
    comments: fileComments,
    label: language.t("ui.lineComment.submit"),
    draftKey: () => props.path,
    state: {
      opened: openedComment,
      setOpened: setOpenedComment,
      selected,
      setSelected,
      commenting,
      setCommenting,
    },
    getHoverSelectedRange: selected,
    cancelDraftOnCommentToggle: true,
    clearSelectionOnSelectionEndNull: true,
    onSubmit: ({ comment, selection }) => {
      const fileSelection = selectionFromLines(selection)
      const saved = comments.add({
        file: props.path,
        selection,
        comment,
      })
      prompt.context.add({
        type: "file",
        path: props.path,
        selection: fileSelection,
        comment,
        commentID: saved.id,
        commentOrigin: "file",
        preview: buildPreview(fileSelection),
      })
    },
    onUpdate: ({ id, comment, selection }) => {
      comments.update(props.path, id, comment)
      const fileSelection = selectionFromLines(selection)
      prompt.context.updateComment(props.path, id, {
        comment,
        preview: buildPreview(fileSelection),
      })
    },
    onDelete: (comment) => {
      comments.remove(props.path, comment.id)
      prompt.context.removeComment(props.path, comment.id)
    },
    editSubmitLabel: language.t("common.save"),
  })
  const commentAnnotations = createMemo(() => commentsUi.annotations() as TextFileProps<unknown>["annotations"])
  const renderAnnotation = (annotation: { metadata: unknown }) =>
    commentsUi.renderAnnotation(annotation as { metadata: LineCommentAnnotationMeta<LineComment> })
  const renderGutterUtility = (getHoveredRow: () => { lineNumber: number } | undefined) =>
    commentsUi.renderGutterUtility(getHoveredRow) ?? null

  return (
    <div class={`relative flex flex-col size-full min-h-0 overflow-hidden bg-background-base ${props.class ?? ""}`}>
      <Show when={!props.hideHeader}>
        <div class="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-border-weak-base bg-background-stronger">
          <FileIcon node={{ path: props.path, type: "file" }} class="shrink-0" />
          <div class="min-w-0 flex-1">
            <div class="text-sm font-medium text-text-strong truncate">{getFilename(props.path)}</div>
            <div class="text-xs text-text-weak truncate">{props.path}</div>
          </div>
          <Show when={isMd()}>
            <Tooltip value={previewing() ? "Show source" : "Preview markdown"}>
              <IconButton
                icon={previewing() ? "code" : "eye"}
                variant="ghost"
                size="small"
                onClick={() => toggleMarkdownPreview(props.path)}
                aria-label={previewing() ? "Show source" : "Preview markdown"}
              />
            </Tooltip>
          </Show>
          {/* This is where adding a repository file to Documents lives: on the
              Markdown file itself, next to the file it acts on. The Documents
              index used to carry a "type the path yourself" importer, which
              asked you to name a file you were already looking at. */}
          <Show when={isMd() && props.onCollaborate}>
            <Tooltip value="Add to Documents">
              <IconButton
                icon="file-text"
                variant="ghost"
                size="small"
                onClick={() => props.onCollaborate?.()}
                aria-label="Add to Documents"
              />
            </Tooltip>
          </Show>
        </div>
      </Show>

      <div class="flex-1 min-h-0 overflow-auto">
        <Switch>
          <Match when={loading()}>
            <div class="flex items-center gap-2 px-4 py-6 text-text-weak">
              <div class="size-4 rounded-full border-2 border-text-weak border-t-transparent animate-spin" />
              <span>Loading...</span>
            </div>
          </Match>

          <Match when={error()}>
            {(e) => <div class="px-4 py-6 text-text-on-critical-base">{e()}</div>}
          </Match>

          <Match when={file()}>
            {(f) => (
              <>
                {/* Code stays mounted (hidden via CSS) to avoid re-highlighting */}
                <div class={previewing() ? "hidden" : undefined}>
                  {(() => {
                    const fileProps = {
                      mode: "text",
                      file: f(),
                      overflow: "wrap",
                      class: "select-text",
                      enableLineSelection: true,
                      enableGutterUtility: true,
                      selectedLines: selected(),
                      commentedLines: commentedLines(),
                      annotations: commentAnnotations(),
                      renderAnnotation,
                      renderGutterUtility,
                      onLineSelected: commentsUi.onLineSelected,
                      onLineNumberSelectionEnd: commentsUi.onLineSelectionEnd,
                      onLineSelectionEnd: commentsUi.onLineSelectionEnd,
                    } satisfies TextFileProps<unknown>
                    return <File {...fileProps} />
                  })()}
                </div>
                {/* Markdown preview — lightweight, mounted on demand */}
                <Show when={previewing()}>
                  <div class="px-6 py-4">
                    <Markdown text={f().contents} />
                  </div>
                </Show>
              </>
            )}
          </Match>

          <Match when={!loading()}>
            <div class="px-4 py-6 text-text-weak">No content</div>
          </Match>
        </Switch>
      </div>
    </div>
  )
}
