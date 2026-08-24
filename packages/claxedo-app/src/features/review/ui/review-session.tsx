import { Accordion } from "@opencode-ai/ui/accordion"
import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { RadioGroup } from "@opencode-ai/ui/radio-group"
import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { ClaxedoIcon as Icon, ClaxedoIconV2 as IconV2 } from "@/ui/controls/claxedo-icon"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { StickyAccordionHeader } from "@opencode-ai/ui/sticky-accordion-header"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import {
  MAX_DIFF_CHANGED_LINES,
  diffId,
  diffTestId,
  diffTriggerTestId,
  exceedsDiffLimit,
  expandOrCollapseAll,
  groupCommentsByFile,
  hasDiffContent,
  reviewDiffList,
} from "./review-session-logic"
import { createComputed, createEffect, createMemo, createSelector, createSignal, For, Match, on, onCleanup, Show, Switch, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import type { SelectedLineRange } from "@/app/providers/file"
import {
  cloneSelectedLineRange,
  createLineCommentController,
  mediaKindFromPath,
  normalize,
  previewSelectedLines,
  text,
  type LineCommentEditorProps,
  type ViewDiff,
} from "@/ui/session-kit"

const REVIEW_MOUNT_MARGIN = 80
const REVIEW_RENDER_BATCH = 8
const REVIEW_IDLE_BATCH = 2

export type SessionReviewDiffStyle = "unified" | "split"

export type SessionReviewComment = {
  id: string
  file: string
  selection: SelectedLineRange
  comment: string
}

export type SessionReviewLineComment = {
  file: string
  selection: SelectedLineRange
  comment: string
  preview?: string
}

export type SessionReviewCommentUpdate = SessionReviewLineComment & {
  id: string
}

export type SessionReviewCommentDelete = {
  id: string
  file: string
}

export type SessionReviewCommentActions = {
  moreLabel: string
  editLabel: string
  deleteLabel: string
  saveLabel: string
}

export type SessionReviewFocus = { file: string; id: string }

type FileContent = {
  content?: string
  data?: string
  mimeType?: string
  type?: string
  url?: string
}

type RawReviewDiff = {
  file?: string
  patch?: string
  before?: string
  after?: string
  additions: number
  deletions: number
  status?: string
  preloaded?: unknown
}
type ReviewDiff = RawReviewDiff & {
  file: string
  status?: "added" | "deleted" | "modified"
  preloaded?: unknown
}
type Item = ViewDiff & { preloaded?: unknown }

export interface SessionReviewProps {
  title?: JSX.Element
  empty?: JSX.Element
  split?: boolean
  diffStyle?: SessionReviewDiffStyle
  onDiffStyleChange?: (diffStyle: SessionReviewDiffStyle) => void
  onDiffRendered?: VoidFunction
  onLineComment?: (comment: SessionReviewLineComment) => void
  onLineCommentUpdate?: (comment: SessionReviewCommentUpdate) => void
  onLineCommentDelete?: (comment: SessionReviewCommentDelete) => void
  lineCommentActions?: SessionReviewCommentActions
  comments?: SessionReviewComment[]
  focusedComment?: SessionReviewFocus | null
  onFocusedCommentChange?: (focus: SessionReviewFocus | null) => void
  focusedFile?: string
  open?: string[]
  onOpenChange?: (open: string[]) => void
  /**
   * Files the user chose to render past the large-diff limit. Controlled the
   * same way as `open`: pass it to own the set (so it survives a remount),
   * omit it to let this component keep its own.
   */
  forcedFiles?: string[]
  onForcedFilesChange?: (files: string[]) => void
  /**
   * Progressive-render admission carried across a remount: how many file rows
   * to admit immediately for the first changeset this mount renders. Later
   * changesets reset to the small first batch as before.
   */
  initialRenderLimit?: number
  onRenderLimitChange?: (limit: number) => void
  onDiffContentRequired?: (files: string[]) => void
  scrollRef?: (el: HTMLDivElement) => void
  onScroll?: JSX.EventHandlerUnion<HTMLDivElement, Event>
  onWheel?: JSX.EventHandlerUnion<HTMLDivElement, WheelEvent>
  class?: string
  classList?: Record<string, boolean | undefined>
  classes?: { root?: string; header?: string; container?: string }
  actions?: JSX.Element
  diffs: RawReviewDiff[]
  onViewFile?: (file: string) => void
  readFile?: (path: string) => Promise<FileContent | undefined>
  lineCommentMention?: LineCommentEditorProps["mention"]
}

function ReviewCommentMenu(props: {
  labels: SessionReviewCommentActions
  onEdit: VoidFunction
  onDelete: VoidFunction
}) {
  return (
    <div onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <DropdownMenu gutter={4} placement="bottom-end">
        <DropdownMenu.Trigger
          as={IconButton}
          icon="dot-grid"
          variant="ghost"
          size="small"
          class="size-6 rounded-md"
          aria-label={props.labels.moreLabel}
        />
        <DropdownMenu.Portal>
          <DropdownMenu.Content>
            <DropdownMenu.Item onSelect={props.onEdit}>
              <DropdownMenu.ItemLabel>{props.labels.editLabel}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={props.onDelete}>
              <DropdownMenu.ItemLabel>{props.labels.deleteLabel}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </div>
  )
}

type SessionReviewSelection = {
  file: string
  range: SelectedLineRange
}

export const ClaxedoSessionReview = (props: SessionReviewProps) => {
  let scroll: HTMLDivElement | undefined
  let focusToken = 0
  let frame: number | undefined
  let renderTask: number | undefined
  let renderTaskIsIdle = false
  const i18n = useI18n()
  const fileComponent = useFileComponent()
  const anchors = new Map<string, HTMLElement>()
  const nodes = new Map<string, HTMLDivElement>()
  const [store, setStore] = createStore({
    open: [] as string[],
    visible: {} as Record<string, boolean>,
    forced: [] as string[],
    selection: null as SessionReviewSelection | null,
    commenting: null as SessionReviewSelection | null,
    opened: null as SessionReviewFocus | null,
  })
  const selection = () => store.selection
  const commenting = () => store.commenting
  const opened = () => store.opened
  const isSelectedFile = createSelector(() => store.selection?.file)
  const isCommentingFile = createSelector(() => store.commenting?.file)
  const isOpenedFile = createSelector(() => store.opened?.file)

  const open = () => props.open ?? store.open
  const forcedFiles = () => props.forcedFiles ?? store.forced
  const forcedFileSet = createMemo(() => new Set(forcedFiles()))
  const isForcedFile = (file: string) => forcedFileSet().has(file)
  const items = createMemo<ReviewDiff[]>(() => reviewDiffList(props.diffs) as ReviewDiff[])
  const files = createMemo(() => items().map((diff) => diff.file))
  const [renderLimit, setRenderLimit] = createSignal(
    Math.max(REVIEW_RENDER_BATCH, props.initialRenderLimit ?? 0),
  )
  const renderedItems = createMemo(() => {
    const required = props.focusedFile ?? props.focusedComment?.file
    const requiredIndex = required ? items().findIndex((diff) => diff.file === required) + 1 : 0
    return items().slice(0, Math.max(renderLimit(), requiredIndex))
  })
  const grouped = createMemo(() => groupCommentsByFile(props.comments))
  const diffStyle = () => props.diffStyle ?? (props.split ? "split" : "unified")
  const hasDiffs = () => files().length > 0

  const syncVisible = () => {
    frame = undefined
    if (!scroll) return

    const root = scroll.getBoundingClientRect()
    const top = root.top - REVIEW_MOUNT_MARGIN
    const bottom = root.bottom + REVIEW_MOUNT_MARGIN
    const openSet = new Set(open())
    const next: Record<string, boolean> = {}

    for (const [file, el] of nodes) {
      if (!openSet.has(file)) continue
      const rect = el.getBoundingClientRect()
      if (rect.bottom < top || rect.top > bottom) continue
      next[file] = true
    }

    const prev = store.visible
    const prevKeys = Object.keys(prev)
    const nextKeys = Object.keys(next)
    if (prevKeys.length === nextKeys.length && nextKeys.every((file) => prev[file])) return
    setStore("visible", next)
  }

  const queue = () => {
    if (frame !== undefined) return
    frame = requestAnimationFrame(syncVisible)
  }

  const pinned = (file: string) =>
    props.focusedComment?.file === file ||
    props.focusedFile === file ||
    isSelectedFile(file) ||
    isCommentingFile(file) ||
    isOpenedFile(file)

  const shouldRequestContent = (diff: ReviewDiff) => {
    if (hasDiffContent(diff)) return false
    if (isForcedFile(diff.file)) return true
    if (mediaKindFromPath(diff.file)) return true
    return diff.additions + diff.deletions <= MAX_DIFF_CHANGED_LINES
  }

  createEffect(() => {
    const openSet = new Set(open())
    const required = items()
      .filter((diff) => openSet.has(diff.file))
      .filter((diff) => (store.visible[diff.file] || pinned(diff.file)) && shouldRequestContent(diff))
      .map((diff) => diff.file)
    if (required.length > 0) props.onDiffContentRequired?.(required)
  })

  const handleScroll: JSX.EventHandler<HTMLDivElement, Event> = (event) => {
    queue()
    if (scroll && scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - REVIEW_MOUNT_MARGIN) {
      setRenderLimit((limit) => Math.min(items().length, limit + REVIEW_RENDER_BATCH))
    }
    const next = props.onScroll
    if (!next) return
    if (Array.isArray(next)) {
      const [fn, data] = next as [(data: unknown, event: Event) => void, unknown]
      fn(data, event)
      return
    }
    ;(next as JSX.EventHandler<HTMLDivElement, Event>)(event)
  }

  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    if (renderTask !== undefined) {
      if (renderTaskIsIdle && typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(renderTask)
      else window.clearTimeout(renderTask)
    }
  })

  createEffect(() => {
    props.open
    files()
    queue()
  })

  // The retained admission applies to the first real changeset this mount
  // renders; every later changeset starts from the small first batch as before.
  let pendingInitialRenderLimit = props.initialRenderLimit
  createEffect(on(() => files().join("\0"), (key, prev) => {
    if (key === "") return
    const initial = pendingInitialRenderLimit
    pendingInitialRenderLimit = undefined
    if (initial !== undefined) {
      setRenderLimit(Math.max(REVIEW_RENDER_BATCH, initial))
      return
    }
    if (prev !== undefined) setRenderLimit(REVIEW_RENDER_BATCH)
  }))
  createEffect(() => props.onRenderLimitChange?.(renderLimit()))

  // Keep first paint small, then admit every file header during browser idle
  // time. This preserves keyboard search, browser find, and programmatic
  // navigation without competing with review interactions for a frame; the
  // expensive diff bodies remain viewport-gated by `visible`.
  createEffect(() => {
    const total = items().length
    const current = renderLimit()
    if (current >= total || renderTask !== undefined) return
    const render = () => {
      renderTask = undefined
      setRenderLimit((limit) => Math.min(total, limit + REVIEW_IDLE_BATCH))
    }
    if (typeof window.requestIdleCallback === "function") {
      renderTaskIsIdle = true
      renderTask = window.requestIdleCallback(render, { timeout: 2_000 })
      return
    }
    renderTaskIsIdle = false
    renderTask = window.setTimeout(render, 0)
  })

  const handleChange = (next: string[]) => {
    props.onOpenChange?.(next)
    if (props.open === undefined) setStore("open", next)
    queue()
  }

  const handleForce = (file: string) => {
    if (forcedFiles().includes(file)) return
    const next = [...forcedFiles(), file]
    props.onForcedFilesChange?.(next)
    if (props.forcedFiles === undefined) setStore("forced", next)
  }

  const handleExpandOrCollapseAll = () => {
    handleChange(expandOrCollapseAll(open(), files()))
  }

  const openFileLabel = () => i18n.t("ui.sessionReview.openFile")

  const selectionSide = (range: SelectedLineRange) => range.endSide ?? range.side ?? "additions"

  const selectionPreview = (diff: ViewDiff, range: SelectedLineRange) => {
    const side = selectionSide(range)
    const contents = text(diff, side)
    if (contents.length === 0) return undefined

    return previewSelectedLines(contents, range)
  }

  createComputed(
    on(
      () => props.focusedComment,
      (focus) => {
        if (!focus) return

        focusToken++
        const token = focusToken

        setStore("opened", focus)

        const comment = (props.comments ?? []).find((c) => c.file === focus.file && c.id === focus.id)
        if (comment) setStore("selection", { file: comment.file, range: cloneSelectedLineRange(comment.selection) })

        const current = open()
        if (!current.includes(focus.file)) {
          handleChange([...current, focus.file])
        }

        const scrollTo = (attempt: number) => {
          if (token !== focusToken) return

          const root = scroll
          if (!root) return

          const wrapper = anchors.get(focus.file)
          const anchor = wrapper?.querySelector(`[data-comment-id="${focus.id}"]`)
          const ready =
            anchor instanceof HTMLElement && anchor.style.pointerEvents !== "none" && anchor.style.opacity !== "0"

          const target = ready ? anchor : wrapper
          if (!target) {
            if (attempt >= 120) return
            requestAnimationFrame(() => scrollTo(attempt + 1))
            return
          }

          const rootRect = root.getBoundingClientRect()
          const targetRect = target.getBoundingClientRect()
          const offset = targetRect.top - rootRect.top
          const next = root.scrollTop + offset - rootRect.height / 2 + targetRect.height / 2
          root.scrollTop = Math.max(0, next)

          if (ready) return
          if (attempt >= 120) return
          requestAnimationFrame(() => scrollTo(attempt + 1))
        }

        requestAnimationFrame(() => scrollTo(0))

        requestAnimationFrame(() => props.onFocusedCommentChange?.(null))
      },
    ),
  )

  return (
    <div
      data-component="session-review"
      data-testid="session-review-root"
      class={props.class}
      classList={props.classList}
    >
      <div data-slot="session-review-header" class={props.classes?.header}>
        <div data-slot="session-review-title">
          {props.title === undefined ? i18n.t("ui.sessionReview.title") : props.title}
        </div>
        <div data-slot="session-review-actions">
          <Show when={hasDiffs() && props.onDiffStyleChange}>
            <RadioGroup
              options={["unified", "split"] as const}
              current={diffStyle()}
              size="small"
              value={(style) => style}
              label={(style) =>
                i18n.t(style === "unified" ? "ui.sessionReview.diffStyle.unified" : "ui.sessionReview.diffStyle.split")
              }
              onSelect={(style) => style && props.onDiffStyleChange?.(style)}
            />
          </Show>
          <Show when={hasDiffs()}>
            <Button
              size="small"
              icon="chevron-grabber-vertical"
              class="w-[106px] justify-start"
              onClick={handleExpandOrCollapseAll}
            >
              <Switch>
                <Match when={open().length > 0}>{i18n.t("ui.sessionReview.collapseAll")}</Match>
                <Match when={true}>{i18n.t("ui.sessionReview.expandAll")}</Match>
              </Switch>
            </Button>
          </Show>
          {props.actions}
        </div>
      </div>

      <ScrollView
        data-slot="session-review-scroll"
        viewportRef={(el) => {
          scroll = el
          props.scrollRef?.(el)
          queue()
        }}
        onScroll={handleScroll}
        onWheel={props.onWheel}
        classList={{
          [props.classes?.root ?? ""]: !!props.classes?.root,
        }}
      >
        <div data-slot="session-review-container" class={props.classes?.container}>
          <Show when={hasDiffs()} fallback={props.empty}>
            <div
              class="pb-6"
              data-review-rendered-files={renderedItems().length}
              data-review-total-files={items().length}
            >
              <Accordion multiple value={open()} onChange={handleChange}>
                <For each={renderedItems()}>
                  {(diff) => {
                    let wrapper: HTMLDivElement | undefined
                    const file = diff.file
                    let normalizedCache: Item | undefined
                    const normalized = () => normalizedCache ??= { ...normalize(diff), preloaded: diff.preloaded }

                    const expanded = createMemo(() => open().includes(file))
                    const force = () => isForcedFile(file)

                    const comments = createMemo(() => grouped().get(file) ?? [])
                    const commentedLines = createMemo(() => comments().map((c) => c.selection))

                    const changedLines = () => diff.additions + diff.deletions
                    const mediaKind = createMemo(() => mediaKindFromPath(file))
                    const loaded = () => hasDiffContent(diff)

                    const tooLarge = createMemo(() =>
                      exceedsDiffLimit({
                        changedLines: changedLines(),
                        expanded: expanded(),
                        forced: force(),
                        media: !!mediaKind(),
                      }),
                    )

                    const isAdded = () => diff.status === "added"
                    const isDeleted = () => diff.status === "deleted"

                    const selectedLines = createMemo(() => {
                      if (!isSelectedFile(file)) return null
                      return selection()?.range ?? null
                    })

                    const draftRange = createMemo(() => {
                      if (!isCommentingFile(file)) return null
                      return commenting()?.range ?? null
                    })

                    const commentsUi = createLineCommentController<SessionReviewComment>({
                      comments,
                      label: i18n.t("ui.lineComment.submit"),
                      draftKey: () => file,
                      mention: props.lineCommentMention,
                      state: {
                        opened: () => {
                          if (!isOpenedFile(file)) return null
                          return opened()?.id ?? null
                        },
                        setOpened: (id) => setStore("opened", id ? { file, id } : null),
                        selected: selectedLines,
                        setSelected: (range) => setStore("selection", range ? { file, range } : null),
                        commenting: draftRange,
                        setCommenting: (range) => setStore("commenting", range ? { file, range } : null),
                      },
                      getSide: selectionSide,
                      clearSelectionOnSelectionEndNull: false,
                      onSubmit: ({ comment, selection }) => {
                        props.onLineComment?.({
                          file,
                          selection,
                          comment,
                          preview: selectionPreview(normalized(), selection),
                        })
                      },
                      onUpdate: ({ id, comment, selection }) => {
                        props.onLineCommentUpdate?.({
                          id,
                          file,
                          selection,
                          comment,
                          preview: selectionPreview(normalized(), selection),
                        })
                      },
                      onDelete: (comment) => {
                        props.onLineCommentDelete?.({
                          id: comment.id,
                          file,
                        })
                      },
                      editSubmitLabel: props.lineCommentActions?.saveLabel,
                      renderCommentActions: props.lineCommentActions
                        ? (comment, controls) => (
                            <ReviewCommentMenu
                              labels={props.lineCommentActions!}
                              onEdit={controls.edit}
                              onDelete={controls.remove}
                            />
                          )
                        : undefined,
                    })

                    onCleanup(() => {
                      anchors.delete(file)
                      nodes.delete(file)
                      queue()
                    })

                    const handleLineSelected = (range: SelectedLineRange | null) => {
                      if (!props.onLineComment) return
                      commentsUi.onLineSelected(range)
                    }

                    const handleLineSelectionEnd = (range: SelectedLineRange | null) => {
                      if (!props.onLineComment) return
                      commentsUi.onLineSelectionEnd(range)
                    }

                    return (
                      <Accordion.Item
                        value={file}
                        id={diffId(file)}
                        data-file={file}
                        data-review-file={file}
                        data-slot="session-review-accordion-item"
                        data-testid={diffTestId(file)}
                        data-selected={props.focusedFile === file ? "" : undefined}
                      >
                        <StickyAccordionHeader>
                          <Accordion.Trigger data-testid={diffTriggerTestId(file)}>
                            <div data-slot="session-review-trigger-content">
                              <div data-slot="session-review-file-info">
                                <FileIcon node={{ path: file, type: "file" }} />
                                <div data-slot="session-review-file-name-container">
                                  <Show when={file.includes("/")}>
                                    <span data-slot="session-review-directory">{`\u202A${getDirectory(file)}\u202C`}</span>
                                  </Show>
                                  <span data-slot="session-review-filename">{getFilename(file)}</span>
                                </div>
                              </div>
                              <div data-slot="session-review-trigger-actions">
                                <div data-slot="session-review-row-summary">
                                  <Switch>
                                    <Match when={isAdded()}>
                                      <div data-slot="session-review-change-group" data-type="added">
                                        <span data-slot="session-review-change" data-type="added">
                                          {i18n.t("ui.sessionReview.change.added")}
                                        </span>
                                        <DiffChanges changes={diff} />
                                      </div>
                                    </Match>
                                    <Match when={isDeleted()}>
                                      <span data-slot="session-review-change" data-type="removed">
                                        {i18n.t("ui.sessionReview.change.removed")}
                                      </span>
                                    </Match>
                                    <Match when={!!mediaKind()}>
                                      <span data-slot="session-review-change" data-type="modified">
                                        {i18n.t("ui.sessionReview.change.modified")}
                                      </span>
                                    </Match>
                                    <Match when={true}>
                                      <DiffChanges changes={diff} />
                                    </Match>
                                  </Switch>
                                </div>
                                <div data-slot="session-review-row-controls">
                                  <Tooltip value={i18n.t("ui.message.copy")} placement="top" gutter={4}>
                                    <button
                                      data-slot="session-review-copy-button"
                                      type="button"
                                      aria-label={i18n.t("ui.message.copy")}
                                      onClick={(event) => {
                                        event.stopPropagation()
                                        void navigator.clipboard?.writeText(file)
                                      }}
                                    >
                                      <Icon name="copy" size="small" />
                                    </button>
                                  </Tooltip>
                                  <span data-slot="session-review-diff-chevron" aria-hidden="true">
                                    <IconV2 name="chevron-down" size="small" />
                                  </span>
                                  <Show when={props.onViewFile}>
                                    <Tooltip value={openFileLabel()} placement="top" gutter={4}>
                                      <button
                                        data-slot="session-review-view-button"
                                        type="button"
                                        aria-label={openFileLabel()}
                                        onClick={(event) => {
                                          event.stopPropagation()
                                          props.onViewFile?.(file)
                                        }}
                                      >
                                        <Icon name="open-file" size="small" />
                                      </button>
                                    </Tooltip>
                                  </Show>
                                </div>
                              </div>
                            </div>
                          </Accordion.Trigger>
                        </StickyAccordionHeader>
                        <Accordion.Content data-slot="session-review-accordion-content">
                          <div
                            data-slot="session-review-diff-wrapper"
                            ref={(el) => {
                              wrapper = el
                              anchors.set(file, el)
                              nodes.set(file, el)
                              queue()
                            }}
                          >
                            <Show when={expanded()}>
                              <Switch>
                                <Match when={tooLarge()}>
                                  <div data-slot="session-review-large-diff">
                                    <div data-slot="session-review-large-diff-title">
                                      {i18n.t("ui.sessionReview.largeDiff.title")}
                                    </div>
                                    <div data-slot="session-review-large-diff-meta">
                                      {i18n.t("ui.sessionReview.largeDiff.meta", {
                                        limit: MAX_DIFF_CHANGED_LINES.toLocaleString(),
                                        current: changedLines().toLocaleString(),
                                      })}
                                    </div>
                                    <div data-slot="session-review-large-diff-actions">
                                      <Button
                                        size="normal"
                                        variant="secondary"
                                        onClick={() => handleForce(file)}
                                      >
                                        {i18n.t("ui.sessionReview.largeDiff.renderAnyway")}
                                      </Button>
                                    </div>
                                  </div>
                                </Match>
                                <Match when={!loaded()}>
                                  <div
                                    data-slot="session-review-diff-placeholder"
                                    class="rounded-lg border border-border-weak-base bg-background-stronger/40 animate-pulse"
                                    style={{ height: "160px" }}
                                  />
                                </Match>
                                <Match when={true}>
                                  <Dynamic
                                    component={fileComponent}
                                    mode="diff"
                                    fileDiff={normalized().fileDiff}
                                    preloadedDiff={normalized().preloaded}
                                    diffStyle={diffStyle()}
                                    onRendered={() => {
                                      props.onDiffRendered?.()
                                    }}
                                    enableLineSelection={props.onLineComment != null}
                                    enableGutterUtility={props.onLineComment != null}
                                    onLineSelected={handleLineSelected}
                                    onLineSelectionEnd={handleLineSelectionEnd}
                                    onLineNumberSelectionEnd={commentsUi.onLineSelectionEnd}
                                    annotations={commentsUi.annotations()}
                                    renderAnnotation={commentsUi.renderAnnotation}
                                    renderGutterUtility={props.onLineComment ? commentsUi.renderGutterUtility : undefined}
                                    selectedLines={selectedLines()}
                                    commentedLines={commentedLines()}
                                    media={{
                                      mode: "auto",
                                      path: file,
                                      deleted: diff.status === "deleted",
                                      readFile: diff.status === "deleted" ? undefined : props.readFile,
                                    }}
                                  />
                                </Match>
                              </Switch>
                            </Show>
                          </div>
                        </Accordion.Content>
                      </Accordion.Item>
                    )
                  }}
                </For>
              </Accordion>
            </div>
          </Show>
        </div>
      </ScrollView>
    </div>
  )
}
