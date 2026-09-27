import {
  CodeView,
  isDiffAnnotation,
  type CodeViewOptions,
  type DiffLineAnnotation,
  type GetHoveredLineResult,
  type LineAnnotation,
  type SelectedLineRange,
} from "@pierre/diffs"
import { createEffect, createMemo, createSignal, For, Show, on, onCleanup, onMount, type Accessor, type JSX } from "solid-js"
import { Portal } from "solid-js/web"

import { createDefaultOptions, styleVariables } from "./diff"
import { getWorkerPool } from "./diff/worker"
import { createReviewCodeViewItems } from "./review-code-view-items"

const FILE_HEADER_HEIGHT = 30

export type ReviewCodeViewDiff = {
  file: string
  additions?: number
  deletions?: number
  status?: string
  patch?: string
  before?: string
  after?: string
}

export type ReviewCodeViewCommentOwner<LAnnotation> = {
  renderAnnotation: (annotation: DiffLineAnnotation<LAnnotation>) => HTMLElement | undefined
  renderGutterUtility: (getHoveredRow: () => GetHoveredLineResult<"diff"> | undefined) => HTMLElement | null | undefined
  onLineSelected: (range: SelectedLineRange | null) => void
  onLineSelectionEnd: (range: SelectedLineRange | null) => void
}

export type ReviewCodeViewComments<LAnnotation> = {
  annotations: (file: string) => DiffLineAnnotation<LAnnotation>[] | undefined
  owner: (file: string) => ReviewCodeViewCommentOwner<LAnnotation>
  onRenderedFilesChange: (files: readonly string[]) => void
}

export type ReviewCodeViewProps<LAnnotation = undefined> = {
  diffs: readonly ReviewCodeViewDiff[]
  diffStyle: "unified" | "split"
  open: readonly string[]
  onToggleOpen?: (file: string) => void
  renderHeader?: (file: string, active: Accessor<boolean>) => JSX.Element
  headerTestId?: (file: string) => string | undefined
  focusedFile?: string
  scrollRef?: (element: HTMLDivElement) => void
  anchorTopRef?: (resolve: ((file: string) => number | undefined) | undefined) => void
  revealTarget?: ReviewCodeViewRevealTarget | null
  onRevealed?: (target: ReviewCodeViewRevealTarget) => void
  onScrollEvent?: JSX.EventHandler<HTMLDivElement, Event>
  onDiffRendered?: () => void
  onDiffContentRequired?: (files: string[]) => void
  customFiles?: ReadonlySet<string>
  renderCustomBody?: (file: string) => JSX.Element
  comments?: ReviewCodeViewComments<LAnnotation>
  selectedLines?: { file: string; range: SelectedLineRange } | null
  class?: string
}

export type ReviewCodeViewRevealTarget = {
  file: string
  lineNumber?: number
  side?: "additions" | "deletions"
}

type DivScrollEvent = Parameters<JSX.EventHandler<HTMLDivElement, Event>>[0]

function isDivScrollEvent(event: Event): event is DivScrollEvent {
  return event.currentTarget instanceof HTMLDivElement && event.target instanceof Element
}

export function ReviewCodeView<LAnnotation = undefined>(props: ReviewCodeViewProps<LAnnotation>) {
  let root: HTMLDivElement | undefined
  let view: CodeView<LAnnotation> | undefined
  let optionsForView: CodeViewOptions<LAnnotation, undefined> | undefined
  let stampFrame: number | undefined

  const openSet = createMemo(() => new Set(props.open))
  const expanded = (file: string) => openSet().has(file)

  const [hoveredFile, setHoveredFile] = createSignal<string | undefined>()
  const [focusedRow, setFocusedRow] = createSignal<string | undefined>()
  const rowOf = (node: EventTarget | null) =>
    node instanceof Element ? node.closest("[data-review-header-file]")?.getAttribute("data-review-header-file") ?? undefined : undefined
  const headerActive = (file: string) => hoveredFile() === file || focusedRow() === file

  const headerHosts = new Map<string, HTMLDivElement>()
  const [headerFiles, setHeaderFiles] = createSignal<string[]>([])
  const customHosts = new Map<string, HTMLDivElement>()
  const [customFiles, setCustomFiles] = createSignal<string[]>([])
  const acquireCustomHost = (file: string) => {
    let host = customHosts.get(file)
    if (!host) {
      host = document.createElement("div")
      host.dataset.slot = "session-review-custom-host"
      customHosts.set(file, host)
      setCustomFiles((files) => [...files, file])
    }
    return host
  }
  const acquireHeaderHost = (file: string) => {
    let host = headerHosts.get(file)
    if (!host) {
      host = document.createElement("div")
      host.dataset.slot = "session-review-header-host"
      headerHosts.set(file, host)
      setHeaderFiles((files) => [...files, file])
    }
    return host
  }

  let focusHandoff: string | undefined
  const customFileHolding = (element: Element | null) => [...customHosts].find(([, host]) => host.contains(element))?.[0]
  const handFocusToHeader = (host: HTMLElement) => {
    const file = focusHandoff
    const toggle = file ? headerHosts.get(file)?.querySelector("button") : undefined
    if (!toggle?.isConnected) return
    focusHandoff = undefined
    if (document.activeElement === document.body || document.activeElement === host) toggle.focus({ preventScroll: true })
  }

  const reconcileItems = createReviewCodeViewItems<LAnnotation>()
  const items = createMemo(() => reconcileItems({
    diffs: props.diffs,
    open: openSet(),
    customFiles: props.customFiles,
    annotations: props.comments?.annotations,
  }))

  const stamp = () => {
    stampFrame = undefined
    const current = view
    const host = root
    if (!current || !host) return
    const rendered = current.getRenderedItems()
    for (const record of rendered) {
      const element = record.element
      if (element.dataset.reviewFile !== record.id) {
        element.dataset.reviewFile = record.id
        element.dataset.file = record.id
        element.dataset.slot = "session-review-diff-wrapper"
        element.style.display = "block"
        element.style.minHeight = "1px"
      }
    }
    handFocusToHeader(host)
    host.dataset.reviewRenderedFiles = String(rendered.length)
    host.dataset.reviewTotalFiles = String(props.diffs.length)
    if (props.onDiffContentRequired) {
      const visible = current.getRenderedItemIds()
      const nearby = current.getRenderedItemIds({ before: 2, after: 2 })
      props.onDiffContentRequired([...new Set([...visible, ...nearby])].filter(expanded))
    }
  }

  let appliedReveal: ReviewCodeViewRevealTarget | undefined
  const tryReveal = () => {
    const instance = view
    const target = props.revealTarget
    if (!instance) return
    if (!target) {
      appliedReveal = undefined
      return
    }
    if (appliedReveal === target) return
    const item = instance.getItem(target.file)
    if (!item) return
    if (target.lineNumber === undefined) {
      if (instance.scrollTo({ type: "item", id: target.file, align: "start", behavior: "instant" })) {
        appliedReveal = target
        props.onRevealed?.(target)
      }
      return
    }
    if (item.type !== "diff" || item.collapsed === true) return
    const accepted = instance.scrollTo({
      type: "line",
      id: target.file,
      lineNumber: target.lineNumber,
      side: target.side,
      align: "center",
      behavior: "instant",
    })
    if (!accepted) return
    appliedReveal = target
    props.onRevealed?.(target)
  }

  const stampSoon = () => {
    if (!view || stampFrame !== undefined) return
    if (typeof requestAnimationFrame !== "function") {
      stamp()
      return
    }
    stampFrame = requestAnimationFrame(stamp)
  }

  onMount(() => {
    const host = root
    if (!host) return
    const comments = props.comments
    const options: CodeViewOptions<LAnnotation, undefined> = {
      ...createDefaultOptions(props.diffStyle),
      overflow: "scroll",
      hunkSeparators: "line-info-basic",
      lineDiffType: "none",
      disableFileHeader: false,
      stickyHeaders: true,
      layout: { paddingTop: 0, paddingBottom: 8, gap: 2 },
      itemMetrics: { diffHeaderHeight: FILE_HEADER_HEIGHT },
      renderCustomItem: (item) => acquireCustomHost(item.id),
      ...(props.renderHeader
        ? { renderCustomHeader: (_source: unknown, context: { item: { id: string } }) => acquireHeaderHost(context.item.id) }
        : {}),
      ...(comments
        ? {
            enableLineSelection: true,
            enableGutterUtility: true,
            controlledSelection: true,
            renderAnnotation: (
              annotation: DiffLineAnnotation<LAnnotation> | LineAnnotation<LAnnotation>,
              context: { item: { id: string } },
            ) => isDiffAnnotation(annotation)
              ? comments.owner(context.item.id).renderAnnotation(annotation)
              : undefined,
            renderGutterUtility: (
              getHoveredRow: () => GetHoveredLineResult<"diff"> | GetHoveredLineResult<"file"> | undefined,
              context: { item: { id: string } },
            ) => comments.owner(context.item.id).renderGutterUtility(() => {
              const row = getHoveredRow()
              return row && "side" in row ? row : undefined
            }),
            onLineSelected: (range: SelectedLineRange | null, context: { item: { id: string } }) =>
              comments.owner(context.item.id).onLineSelected(range),
            onLineSelectionEnd: (range: SelectedLineRange | null, context: { item: { id: string } }) =>
              comments.owner(context.item.id).onLineSelectionEnd(range),
          }
        : {}),
      onPostRender: () => {
        props.onDiffRendered?.()
        stampSoon()
      },
    }
    optionsForView = options
    const instance = new CodeView<LAnnotation>(options, getWorkerPool("unified"))
    view = instance
    instance.setSlotCoordinator({
      hasHeaderRenderers: true,
      hasAnnotationRenderer: !!comments,
      hasGutterRenderer: !!comments,
      onSnapshotChange: (snapshot) => {
        const rendered = new Set(snapshot?.items?.filter((record) => record.type !== "custom").map((record) => record.id))
        const custom = new Set(snapshot?.items?.filter((record) => record.type === "custom").map((record) => record.id))
        for (const file of headerHosts.keys()) {
          if (!rendered.has(file)) headerHosts.delete(file)
        }
        setHeaderFiles((files) => files.filter((file) => rendered.has(file)))
        for (const file of customHosts.keys()) {
          if (!custom.has(file)) customHosts.delete(file)
        }
        setCustomFiles((files) => files.filter((file) => custom.has(file)))
        comments?.onRenderedFilesChange([...rendered].filter(expanded))
        stampSoon()
      },
    })
    instance.setup(host)
    instance.setItems(items())
    instance.render(true)
    props.anchorTopRef?.((file) => instance.getTopForItem(file))
    tryReveal()

    const scroller = host
    scroller.dataset.scrollable = "true"
    props.scrollRef?.(host)
    const forwardScroll = (event: Event) => {
      setHoveredFile(undefined)
      if (isDivScrollEvent(event)) props.onScrollEvent?.(event)
    }
    scroller.addEventListener("scroll", forwardScroll, { passive: true })
    const unsubscribe = instance.subscribeToScroll(() => stampSoon())
    stampSoon()

    onCleanup(() => {
      view = undefined
      props.anchorTopRef?.(undefined)
      unsubscribe()
      scroller.removeEventListener("scroll", forwardScroll)
      if (stampFrame !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(stampFrame)
      instance.cleanUp()
      headerHosts.clear()
      setHeaderFiles([])
      customHosts.clear()
      setCustomFiles([])
      comments?.onRenderedFilesChange([])
    })
  })

  createEffect(on(
    items,
    (next, previous) => {
      if (previous === undefined) return
      const holder = customFileHolding(document.activeElement)
      view?.setItems(next)
      if (holder && !customHosts.get(holder)?.isConnected) focusHandoff = holder
      if (props.revealTarget) view?.render(true)
      tryReveal()
      stampSoon()
    },
  ))

  createEffect(on(() => props.revealTarget, () => tryReveal()))

  if (props.comments) {
    createEffect(on(
      () => props.selectedLines,
      (selection) => {
        view?.setSelectedLines(selection ? { id: selection.file, range: selection.range } : null, { notify: false })
      },
    ))
  }

  createEffect(on(
    () => props.diffStyle,
    (style, previous) => {
      if (previous === undefined) return
      view?.setOptions({ ...optionsForView, diffStyle: style })
      stampSoon()
    },
  ))

  const Header = (header: { file: string }) => (
    <div data-component="accordion-v2">
      <div
        data-component="accordion-v2-item" class="ui-accordion-v2-item"
        data-review-header-file={header.file}
        data-expanded={expanded(header.file) ? "" : undefined}
        data-selected={props.focusedFile === header.file ? "" : undefined}
      >
        <div data-slot="accordion-v2-header">
          <button
            type="button"
            data-component="accordion-v2-trigger"
            class="ui-accordion-v2-trigger"
            style={{ height: `${FILE_HEADER_HEIGHT}px` }}
            data-testid={props.headerTestId?.(header.file)}
            data-hovered={headerActive(header.file) ? "" : undefined}
            aria-expanded={expanded(header.file) ? "true" : "false"}
            aria-label={`Toggle diff for ${header.file}`}
            onClick={() => props.onToggleOpen?.(header.file)}
          >
            {props.renderHeader?.(header.file, () => headerActive(header.file)) ?? header.file}
          </button>
        </div>
      </div>
    </div>
  )

  return (
    <div
      ref={root}
      data-component="session-review"
      data-slot="session-review-scroll"
      class={props.class}
      style={{ ...styleVariables, height: "100%", "min-height": "0", overflow: "auto", position: "relative" }}
      onPointerMove={(event) => setHoveredFile(rowOf(event.target))}
      onPointerLeave={() => setHoveredFile(undefined)}
      onFocusIn={(event) => setFocusedRow(rowOf(event.target))}
      onFocusOut={(event) => {
        if (rowOf(event.relatedTarget) === focusedRow()) return
        setFocusedRow(undefined)
      }}
    >
      <For each={headerFiles()}>
        {(file) => (
          <Portal mount={headerHosts.get(file)}>
            <Header file={file} />
          </Portal>
        )}
      </For>
      <For each={customFiles()}>
        {(file) => (
          <Portal mount={customHosts.get(file)}>
            <Header file={file} />
            <Show when={expanded(file)}>
              {props.renderCustomBody?.(file) ?? <div role="status">Loading diff…</div>}
            </Show>
          </Portal>
        )}
      </For>
    </div>
  )
}
