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

import { Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
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
import { imagePreviewUrl } from "@/platform/files/file-preview"
import type { LineComment } from "@/platform/comments/provider"

// Module-level signal tracking which file paths are in preview mode.
// Shared across all TabFile instances so the same file shows consistent state.
// Markdown renders by default; this set holds files toggled to SOURCE view.
const [sourcePaths, setSourcePaths] = createSignal(new Set())

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path)
}

/** Whether a markdown file is toggled to SOURCE view (default is rendered). */
export function markdownSourceView(path: string) {
  return sourcePaths().has(path)
}

export function toggleMarkdownPreview(path: string) {
  setSourcePaths((prev) => {
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
  /** Line to select + reveal once content renders (from `file.ts:42` links). */
  focusLine?: number
  /** Bumped by the opener so re-clicking the same link re-reveals the line. */
  focusNonce?: number
}

export function TabFile(props: TabFileProps) {
  const sdk = useSDK()
  const comments = useComments()
  const language = useLanguage()
  const prompt = usePrompt()

  // Text files carry `content` (rendered by the code viewer); binary files
  // (images, etc.) carry `binary` with the base64 payload + mime type.
  const [content, setContent] = createSignal<string | undefined>()
  const [binary, setBinary] = createSignal<
    { content: string; encoding?: "base64"; mimeType?: string } | undefined
  >()
  const [error, setError] = createSignal<string | undefined>()
  const [loading, setLoading] = createSignal(true)
  const [openedComment, setOpenedComment] = createSignal<string | null>(null)
  const [commenting, setCommenting] = createSignal<SelectedLineRange | null>(null)
  // Selection = the user's manual line selection, or (until the user selects
  // manually under the current focus nonce) the line a `file.ts:42` link
  // focused. Derived rather than effect-written so link focus needs no
  // state-writing effect.
  const [manualSelected, setManualSelected] = createSignal<
    { atNonce: number | undefined; range: SelectedLineRange | null } | undefined
  >()
  const focusSelection = (): SelectedLineRange | null =>
    props.focusLine !== undefined && props.focusLine > 0
      ? { start: props.focusLine, end: props.focusLine }
      : null
  const selected = createMemo<SelectedLineRange | null>(() => {
    const manual = manualSelected()
    if (manual && manual.atNonce === props.focusNonce) return manual.range
    return focusSelection()
  })
  const setSelected = (range: SelectedLineRange | null) =>
    setManualSelected({ atNonce: props.focusNonce, range })
  let loadSeq = 0

  const loadFile = (path: string, opts?: { silent?: boolean }) => {
    if (!path) return
    const seq = ++loadSeq
    // silent = watcher-driven refresh: swap content in place without flashing
    // the loading state.
    if (!opts?.silent) {
      setLoading(true)
      setError(undefined)
    }
    sdk.client.file
      .read({ path })
      .then((res) => {
        if (seq !== loadSeq) return
        const data = res.data
        if (data?.type === "binary") {
          setBinary({ content: data.content, encoding: data.encoding, mimeType: data.mimeType })
          setContent(undefined)
          setLoading(false)
          return
        }
        setBinary(undefined)
        setContent(data?.content)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (seq !== loadSeq) return
        if (!opts?.silent) setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
  }

  // Keep the tab fresh while the file changes on disk (agent edits, git
  // operations): reload on this file's watcher events only — a string compare
  // per event plus a 150ms debounce, so a burst of writes costs one request
  // and unrelated files cost nothing.
  let watchTimer: ReturnType<typeof setTimeout> | undefined
  const stopWatch = sdk.event.listen((event) => {
    if (event.details.type !== "file.watcher.updated") return
    const detail = event.details.properties as { file?: string } | undefined
    const raw = detail?.file
    if (!raw) return
    const workspaceDir = sdk.directory.replace(/\/+$/, "")
    let relative = raw.replaceAll("\\", "/")
    if (workspaceDir && relative.startsWith(`${workspaceDir}/`)) relative = relative.slice(workspaceDir.length + 1)
    relative = relative.replace(/^\/+/, "")
    if (relative !== props.path.replace(/^\/+/, "")) return
    if (watchTimer) clearTimeout(watchTimer)
    const path = props.path
    watchTimer = setTimeout(() => {
      if (props.path !== path) return
      loadFile(path, { silent: true })
    }, 150)
  })
  onCleanup(() => {
    loadSeq++
    if (watchTimer) clearTimeout(watchTimer)
    stopWatch()
  })

  createEffect(
    on(
      () => props.path,
      (path) => {
        if (watchTimer) clearTimeout(watchTimer)
        loadFile(path)
      },
    ),
  )

  // Reveal the focused line: the Code component marks rendered lines with
  // [data-line="N"]. Two triggers, both DOM-only (selection is derived in
  // `selected`): the File component's onRendered covers the mount path (the
  // tab body mounts lazily, so a timed retry from the open click used to
  // expire before any rows existed), and the effect covers re-clicking a link
  // for an already-rendered tab.
  let scrollRoot: HTMLDivElement | undefined
  // The viewer periodically rebuilds its shadow content (annotations,
  // highlight passes); mid-rebuild the content height collapses and the
  // browser clamps the scroller back to 0. onRendered re-applies the reveal
  // after each rebuild — but only within a short window of the focus change,
  // so a link click reliably lands on its line without later rebuilds yanking
  // the user back after they scroll away.
  let focusFreshUntil = 0
  const revealFocusLine = () => {
    const line = props.focusLine
    if (line === undefined || line <= 0 || !scrollRoot) return
    if (typeof performance !== "undefined" && performance.now() > focusFreshUntil) return
    // The viewer renders the code into a shadow root, so the line rows are
    // invisible to a plain querySelector — find the shadow host first.
    for (const host of scrollRoot.querySelectorAll("*")) {
      const row = host.shadowRoot?.querySelector(`[data-line="${line}"]`)
      if (row) {
        row.scrollIntoView({ block: "center" })
        return
      }
    }
  }
  createEffect(
    on(
      () => [props.focusLine, props.focusNonce] as const,
      () => {
        if (typeof performance !== "undefined") focusFreshUntil = performance.now() + 5000
        revealFocusLine()
      },
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

  const imageSrc = createMemo(() => imagePreviewUrl({ path: props.path, text: content(), binary: binary() }))
  // A binary file we can't preview inline (pdf, archive, font, …).
  const unpreviewableBinary = createMemo(() => !!binary() && !imageSrc())

  const isMd = createMemo(() => isMarkdownPath(props.path))
  const previewing = createMemo(() => isMd() && !sourcePaths().has(props.path))
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

      {/* With the header hidden the source/preview toggle lives in the shell
          header next to the file name; only the Documents action floats here. */}
      <Show when={props.hideHeader && isMd() && props.onCollaborate}>
        <div class="absolute right-2 top-2 z-10 rounded-md border border-border-weak-base bg-background-stronger/90 p-0.5 backdrop-blur-sm">
          <Tooltip value="Add to Documents">
            <IconButton
              icon="file-text"
              variant="ghost"
              size="small"
              onClick={() => props.onCollaborate?.()}
              aria-label="Add to Documents"
            />
          </Tooltip>
        </div>
      </Show>
      <div class="flex-1 min-h-0 overflow-auto" ref={scrollRoot}>
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

          <Match when={imageSrc()}>
            {(src) => (
              <div class="flex min-h-full items-center justify-center p-6">
                <img
                  src={src()}
                  alt={getFilename(props.path)}
                  class="max-h-full max-w-full object-contain"
                  style={{ "image-rendering": "auto" }}
                />
              </div>
            )}
          </Match>

          <Match when={unpreviewableBinary()}>
            <div class="flex min-h-full flex-col items-center justify-center gap-2 px-4 py-10 text-center text-text-weak">
              <FileIcon node={{ path: props.path, type: "file" }} class="size-8 opacity-70" />
              <div class="text-sm text-text-base">{getFilename(props.path)}</div>
              <div class="text-xs">Binary file — no inline preview available.</div>
            </div>
          </Match>

          <Match when={file()}>
            {(f) => (
              <>
                {/* Code stays mounted (hidden via CSS) to avoid re-highlighting */}
                <div class={previewing() ? "hidden" : undefined}>
                  {/* Reactive JSX attributes, NOT a pre-built object: a static
                      `fileProps` snapshot froze selectedLines/commentedLines at
                      first render, so a line focus arriving after mount (link
                      re-click) never reached the viewer. */}
                  <File
                    mode="text"
                    file={f()}
                    overflow="wrap"
                    class="select-text"
                    onRendered={revealFocusLine}
                    enableLineSelection={true}
                    enableGutterUtility={true}
                    selectedLines={selected()}
                    commentedLines={commentedLines()}
                    annotations={commentAnnotations()}
                    renderAnnotation={renderAnnotation}
                    renderGutterUtility={renderGutterUtility}
                    onLineSelected={commentsUi.onLineSelected}
                    onLineNumberSelectionEnd={commentsUi.onLineSelectionEnd}
                    onLineSelectionEnd={commentsUi.onLineSelectionEnd}
                  />

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
