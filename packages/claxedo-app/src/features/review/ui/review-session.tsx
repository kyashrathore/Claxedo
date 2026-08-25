import { Accordion } from "@opencode-ai/ui/accordion"
import { Button } from "@opencode-ai/ui/button"
import { RadioGroup } from "@opencode-ai/ui/radio-group"
import { StickyAccordionHeader } from "@opencode-ai/ui/sticky-accordion-header"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { ReviewCommentMenu } from "./review-comment-menu"
import { ReviewFileHeaderContent } from "./review-file-header"
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
import { createReviewDiffPrime } from "./review-diff-prime"
import { createReviewRowHoverOwner } from "./review-row-hover"
import { afterVisibleWork } from "./review-deferred-work"
import {
  createReviewWindowSegments,
  rememberReviewRowHeight,
  reviewEstimatedRowHeight,
  reviewWindowRowCount,
  sameReviewWindowSegments,
} from "./review-window"
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

/** Two file sets (required, expanded) are the same when they name the same files. */
function sameFileSet(a: ReadonlySet<string>, b: ReadonlySet<string>) {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const file of a) if (!b.has(file)) return false
  return true
}

/** Two comment lists are the same when they hold the same comments in order. */
function sameComments(a: readonly SessionReviewComment[], b: readonly SessionReviewComment[]) {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return false
  }
  return true
}

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
   * The semantic scroll anchor a restoration is heading for. Materialized
   * regardless of the window so an anchor-based scroll restore can land before
   * the window has scrolled anywhere near it.
   */
  anchorFile?: string
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

type SessionReviewSelection = {
  file: string
  range: SelectedLineRange
}

export const ClaxedoSessionReview = (props: SessionReviewProps) => {
  let scroll: HTMLDivElement | undefined
  let focusToken = 0
  let frame: number | undefined
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
  const openFiles = createMemo(() => new Set(open()), undefined, { equals: sameFileSet })
  const forcedFiles = () => props.forcedFiles ?? store.forced
  const forcedFileSet = createMemo(() => new Set(forcedFiles()))
  const isForcedFile = (file: string) => forcedFileSet().has(file)
  const items = createMemo<ReviewDiff[]>(() => reviewDiffList(props.diffs) as ReviewDiff[])
  const files = createMemo(() => items().map((diff) => diff.file))
  // Windowed materialization: only a viewport's worth of header rows exists in
  // the DOM (plus required rows); gaps preserve the corpus's scroll geometry.
  const [windowScrollTop, setWindowScrollTop] = createSignal(0)
  const [windowViewportHeight, setWindowViewportHeight] = createSignal(0)
  const [estimatedRowHeight, setEstimatedRowHeight] = createSignal(reviewEstimatedRowHeight())
  const [rowHeightsVersion, setRowHeightsVersion] = createSignal(0)
  const rowHeights = new Map<string, number>()
  const itemElements = new Map<string, HTMLElement>()
  // `focusedComment` is re-derived per session (the comment store is keyed by
  // session id), so activating a sibling session hands this memo a fresh but
  // identical answer. Compare by content: the window only cares *which* files
  // are required, never which object says so.
  const requiredFiles = createMemo(
    () => {
      const required = new Set<string>()
      if (props.focusedFile) required.add(props.focusedFile)
      if (props.focusedComment?.file) required.add(props.focusedComment.file)
      if (props.anchorFile) required.add(props.anchorFile)
      return required
    },
    undefined,
    { equals: sameFileSet },
  )
  const stableWindowSegments = createReviewWindowSegments<ReviewDiff>()
  const windowSegments = createMemo(
    () => {
      rowHeightsVersion()
      return stableWindowSegments({
        items: items(),
        scrollTop: windowScrollTop(),
        viewportHeight: windowViewportHeight(),
        overscan: REVIEW_MOUNT_MARGIN,
        estimatedRowHeight: estimatedRowHeight(),
        measuredHeight: (diff) => rowHeights.get(diff.file),
        // Focus and restoration anchors must stay mounted until the viewport
        // reaches them. Expansion is semantic state, not a materialization
        // requirement: an expanded offscreen diff is disposed and expands
        // again when its row re-enters the window. Otherwise expand-all (and
        // the initial all-open review state) bypasses the window completely.
        required: (diff) => requiredFiles().has(diff.file),
      })
    },
    undefined,
    { equals: sameReviewWindowSegments },
  )
  const materializedRowCount = createMemo(() => reviewWindowRowCount(windowSegments()))
  const syncWindowGeometry = () => {
    if (!scroll) return
    setWindowScrollTop(scroll.scrollTop)
    setWindowViewportHeight(scroll.clientHeight)
    let changed = false
    let collapsedSample: number | undefined
    const expandedFiles = openFiles()
    for (const [file, element] of itemElements) {
      const height = element.offsetHeight
      if (height <= 0) continue
      if (Math.abs((rowHeights.get(file) ?? 0) - height) > 0.5) {
        rowHeights.set(file, height)
        changed = true
      }
      // The row-height *estimate* drives the window budget, so it may only ever
      // be sampled from a collapsed row: an expanded diff is hundreds of rows
      // tall and would shrink the budget to a single row.
      if (collapsedSample === undefined && !expandedFiles.has(file)) collapsedSample = height
    }
    if (collapsedSample !== undefined) {
      rememberReviewRowHeight(collapsedSample)
      if (Math.abs(collapsedSample - estimatedRowHeight()) > 0.5) setEstimatedRowHeight(collapsedSample)
    }
    if (changed) setRowHeightsVersion((version) => version + 1)
  }
  const grouped = createMemo(() => groupCommentsByFile(props.comments))
  const diffStyle = () => props.diffStyle ?? (props.split ? "split" : "unified")
  const hasDiffs = () => files().length > 0

  const syncVisible = () => {
    frame = undefined
    if (!scroll) return
    syncWindowGeometry()

    const root = scroll.getBoundingClientRect()
    const top = root.top - REVIEW_MOUNT_MARGIN
    const bottom = root.bottom + REVIEW_MOUNT_MARGIN
    const openSet = openFiles()
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

  const isExpandedFile = (file: string) => openFiles().has(file)

  createEffect(() => {
    const openSet = openFiles()
    const required = items()
      .filter((diff) => openSet.has(diff.file))
      .filter((diff) => (store.visible[diff.file] || pinned(diff.file)) && shouldRequestContent(diff))
      .map((diff) => diff.file)
    if (required.length > 0) props.onDiffContentRequired?.(required)
  })

  // Prime what the next press will mount, before the press: the row under the
  // resting pointer, and any row whose large-diff guard pane is up. Both fetch
  // the content through the same loader the mounted-content effect uses, and
  // both highlight it in the worker — so the expand (or the force) renders
  // once instead of three times.
  const diffPrime = createReviewDiffPrime({ diffs: items, diffStyle, isForcedFile, isExpandedFile })
  const rowHover = createReviewRowHoverOwner({
    onHoverIntent: (file) => {
      diffPrime.intend(file)
      const diff = items().find((item) => item.file === file)
      if (!diff || !shouldRequestContent(diff)) return
      props.onDiffContentRequired?.([file])
    },
  })

  const handleScroll: JSX.EventHandler<HTMLDivElement, Event> = (event) => {
    queue()
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
  })

  createEffect(() => {
    props.open
    files()
    queue()
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

  /**
   * Everything a review row needs only while it is EXPANDED.
   *
   * A collapsed row is one sticky header. It needs no diff normalization, no
   * per-file comment memos, and above all no line-comment controller — a whole
   * annotation state machine, managed annotation renderer and gutter renderer,
   * per file. Building that for every MATERIALIZED row made the window's
   * construction cost scale with the window rather than with what the user
   * actually opened, and the window is reconstructed on every Files -> Review
   * switch and every panel reopen.
   *
   * Mounted from inside `<Show when={expanded()}>`, so its lifetime is exactly
   * the row's expansion: collapsing releases the controller, the diff's shadow
   * tree, and the anchor/visibility registrations in one disposal.
   */
  const ExpandedReviewDiff = (row: { diff: ReviewDiff }) => {
    const diff = row.diff
    const file = diff.file
    let normalizedCache: Item | undefined
    const normalized = () => normalizedCache ??= { ...normalize(diff), preloaded: diff.preloaded }

    // `grouped` re-derives whole per-file arrays whenever the comment session
    // changes identity — including a session switch that carries no comment
    // change for this file. A content comparison keeps that off the diff
    // renderer, whose `commentedLines` prop would otherwise re-render the
    // expanded shadow tree on every switch.
    const comments = createMemo(() => grouped().get(file) ?? [], undefined, { equals: sameComments })
    const commentedLines = createMemo(() => comments().map((c) => c.selection))

    const changedLines = () => diff.additions + diff.deletions
    const mediaKind = createMemo(() => mediaKindFromPath(file))
    const loaded = () => hasDiffContent(diff)

    const tooLarge = createMemo(() =>
      exceedsDiffLimit({
        changedLines: changedLines(),
        expanded: true,
        forced: isForcedFile(file),
        media: !!mediaKind(),
      }),
    )

    // The guard pane paints nothing of this diff — only its "render anyway"
    // press will — so its content is asked for AFTER the expand that opened
    // the pane has painted. Inside the expand, the fetch and the parse its
    // arrival triggers would be charged to the very interaction they exist to
    // spare; scheduled here they land in the gap while the user reads the
    // confirmation. Collapsing or forcing disposes this scope and the pending
    // schedule with it.
    createEffect(() => {
      if (!tooLarge() || loaded()) return
      onCleanup(afterVisibleWork(() => props.onDiffContentRequired?.([file])))
    })

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

    // The anchor/visibility registrations describe the row's mounted diff, so
    // they belong to this scope: collapsing must drop them, or `syncVisible`
    // keeps measuring a detached wrapper.
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
      <div
        data-slot="session-review-diff-wrapper"
        ref={(el) => {
          anchors.set(file, el)
          nodes.set(file, el)
          queue()
        }}
      >
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
                <Button size="normal" variant="secondary" onClick={() => handleForce(file)}>
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
      </div>
    )
  }


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
              data-review-rendered-files={materializedRowCount()}
              data-review-total-files={items().length}
              onPointerOver={rowHover.onPointerOver}
              onPointerOut={rowHover.onPointerOut}
              onFocusIn={rowHover.onFocusIn}
              onFocusOut={rowHover.onFocusOut}
            >
              <Accordion multiple value={open()} onChange={handleChange}>
                <For each={windowSegments()}>
                  {(segment) => {
                    if (segment.kind === "gap") {
                      return (
                        <div
                          data-slot="session-review-window-gap"
                          data-review-window-gap-files={segment.count}
                          style={{ height: `${segment.height}px` }}
                        />
                      )
                    }
                    const diff = segment.item
                    const file = diff.file

                    const expanded = createMemo(() => openFiles().has(file))

                    onCleanup(() => {
                      itemElements.delete(file)
                      queue()
                    })

                    return (
                      <Accordion.Item
                        ref={(element: HTMLElement) => {
                          itemElements.set(file, element)
                          queue()
                        }}
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
                            <ReviewFileHeaderContent
                              diff={diff}
                              onViewFile={props.onViewFile}
                              showControls={rowHover.controlsMounted(file)}
                            />
                          </Accordion.Trigger>
                        </StickyAccordionHeader>
                        {/* Collapsed rows mount no Content at all: Kobalte's
                            content mounts a presence that probes computed
                            styles per row (a forced recalc), and review CSS
                            snaps collapse via display:none anyway — there is
                            no exit animation to preserve. The anchors/nodes
                            consumers only read open files. */}
                        <Show when={expanded()}>
                          <Accordion.Content data-slot="session-review-accordion-content">
                            <ExpandedReviewDiff diff={diff} />
                          </Accordion.Content>
                        </Show>
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
