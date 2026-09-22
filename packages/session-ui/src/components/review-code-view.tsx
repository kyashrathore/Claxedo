/**
 * ReviewCodeView — the Review surface boundary around Pierre's CodeView.
 *
 * One CodeView instance owns the whole changed-file document: layout,
 * virtualization, scrolling, worker-pool highlighting. This component is the
 * Solid boundary around that imperative engine: it maps the review model
 * (files + expansion) onto controlled `CodeViewItem`s and exposes the scroll
 * element to the caller's scroll-restoration machinery.
 *
 * File headers render through Pierre's custom-header mode: the engine leaves a
 * light-DOM slot per file and this component portals the caller's header
 * content into it, wrapped in the accordion header structure the app's review
 * CSS styles. Headers therefore look identical to the accordion list while
 * the engine owns layout and virtualization.
 */
import {
  CodeView,
  isDiffAnnotation,
  type CodeViewOptions,
  type DiffLineAnnotation,
  type GetHoveredLineResult,
  type LineAnnotation,
  type SelectedLineRange,
} from "@pierre/diffs"
import { createEffect, createMemo, createSignal, For, Show, on, onCleanup, onMount, type JSX } from "solid-js"
import { Portal } from "solid-js/web"

import { createDefaultOptions, styleVariables } from "../pierre"
import { getWorkerPool } from "../pierre/worker"
import { createReviewCodeViewItems } from "./review-code-view-items"

export type ReviewCodeViewDiff = {
  file: string
  additions?: number
  deletions?: number
  status?: string
  patch?: string
  before?: string
  after?: string
}

/**
 * One file's comment UI. Built on first use and released when the file leaves
 * the rendered range, so a document of thousands of files holds controllers
 * only for what Pierre currently paints.
 */
export type ReviewCodeViewCommentOwner<LAnnotation> = {
  renderAnnotation: (annotation: DiffLineAnnotation<LAnnotation>) => HTMLElement | undefined
  renderGutterUtility: (getHoveredRow: () => GetHoveredLineResult<"diff"> | undefined) => HTMLElement | null | undefined
  onLineSelected: (range: SelectedLineRange | null) => void
  onLineSelectionEnd: (range: SelectedLineRange | null) => void
}

export type ReviewCodeViewComments<LAnnotation> = {
  /**
   * A file's annotations. Data only — this is read for every file in the
   * document, because an annotation takes document height wherever it sits, so
   * it must not build a controller or any DOM. Return the same array while the
   * file's comments and draft are unchanged.
   */
  annotations: (file: string) => DiffLineAnnotation<LAnnotation>[] | undefined
  /**
   * The file's comment owner. Only ever called from inside a render, a gutter
   * hover or a selection on an item Pierre is painting, which is what ties the
   * owner's creation to the item.
   */
  owner: (file: string) => ReviewCodeViewCommentOwner<LAnnotation>
  /**
   * The expanded files Pierre paints right now. Every other owner can be
   * released: collapsing a row or scrolling it away ends its comment UI.
   */
  onRenderedFilesChange: (files: readonly string[]) => void
}

export type ReviewCodeViewProps<LAnnotation = undefined> = {
  diffs: readonly ReviewCodeViewDiff[]
  diffStyle: "unified" | "split"
  /** Expanded file paths; every other file renders collapsed. */
  open: readonly string[]
  onToggleOpen?: (file: string) => void
  /**
   * Header row content for a file (the accordion trigger-content markup).
   * Rendered in light DOM through the engine's header slot, so app CSS and
   * context providers apply. Falls back to Pierre's default header when absent.
   *
   * `active` is true for the one row the pointer is on or that holds focus, so
   * a caller can build its hover-only controls for that row alone.
   */
  renderHeader?: (file: string, active: boolean) => JSX.Element
  /** Test id for the header trigger button. */
  headerTestId?: (file: string) => string | undefined
  /** File whose header row shows the selected highlight. */
  focusedFile?: string
  /** Receives the live scroll element for scroll capture/restoration. */
  scrollRef?: (element: HTMLDivElement) => void
  /**
   * Receives a reader for where a file sits in the document, in the scroll
   * element's coordinates. The engine knows every file's position whether or
   * not the row is rendered, so a scroll restoration can target a file it
   * cannot see instead of replaying a pixel offset from an older document.
   */
  anchorTopRef?: (resolve: ((file: string) => number | undefined) | undefined) => void
  /**
   * Somewhere to bring into view, held until the engine can actually resolve it.
   *
   * CodeView resolves a target through the item it has committed, so one
   * published before `setItems` handed the engine that item — or, for a line,
   * while the file is still a summary row — would be dropped silently. This
   * surface therefore retries the target at each item commit and reports back
   * through `onRevealed` once it has been applied, which is the only point at
   * which a caller may consider the request satisfied.
   */
  revealTarget?: ReviewCodeViewRevealTarget | null
  onRevealed?: (target: ReviewCodeViewRevealTarget) => void
  /**
   * Native scroll events from the scroll element.
   *
   * Typed as Solid's handler rather than a bare `(event: Event) => void` so a
   * caller can forward straight into an `onScroll` prop: Solid's handlers read
   * `currentTarget` as the bound element, and a plain DOM `Event` does not
   * satisfy that, so every consumer was re-asserting the shape at its own call
   * site. Declaring it here moves the one narrowing to `forwardScroll`, which
   * is the only place the element is actually known.
   */
  onScrollEvent?: JSX.EventHandler<HTMLDivElement, Event>
  /** Fired after CodeView commits a render pass with visible content. */
  onDiffRendered?: () => void
  /** Current rendered files first, followed by nearby content prefetch targets. */
  onDiffContentRequired?: (files: string[]) => void
  /** Files whose body is supplied by the caller, without parsing a text diff. */
  customFiles?: ReadonlySet<string>
  /** Loading, error, or other custom body; mounted only while Pierre renders the item. */
  renderCustomBody?: (file: string) => JSX.Element
  /** Line comments, selection and the gutter utility. Omit to render read-only. */
  comments?: ReviewCodeViewComments<LAnnotation>
  /**
   * The selection the caller considers current. CodeView runs in controlled
   * selection mode, so this prop is what puts the highlight on screen.
   */
  selectedLines?: { file: string; range: SelectedLineRange } | null
  class?: string
}

/**
 * Somewhere to bring into view. A file alone resolves as soon as the engine has
 * committed that item, whatever kind it is; a line also needs that item to be an
 * expanded diff with its layout computed.
 */
export type ReviewCodeViewRevealTarget = {
  file: string
  lineNumber?: number
  side?: "additions" | "deletions"
}

/**
 * The event shape Solid's scroll handlers receive. Derived from `JSX.EventHandler`
 * rather than spelled out, so it cannot drift from what a consumer's `onScroll`
 * expects.
 */
type DivScrollEvent = Parameters<JSX.EventHandler<HTMLDivElement, Event>>[0]

/**
 * Check the handler contract instead of asserting it.
 *
 * DOM listeners receive a generic Event even when attached to our root div.
 * Testing both fields makes the narrowing true at
 * runtime rather than promised at compile time, which matters because
 * consumers read `currentTarget` to restore scroll position.
 */
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

  /**
   * Which header row shows its hover-only controls.
   *
   * Armed by pointer MOVEMENT, not by `pointerover`: the engine moves rows under
   * a stationary pointer as the document scrolls, and each of those boundary
   * events would otherwise re-arm the controls on whatever row slid underneath.
   * Scrolling and leaving the surface clear it, so controls never follow a row
   * that moved. Focus is tracked separately so the keyboard keeps them usable.
   */
  const [hoveredFile, setHoveredFile] = createSignal<string | undefined>()
  const [focusedRow, setFocusedRow] = createSignal<string | undefined>()
  const rowOf = (node: EventTarget | null) =>
    node instanceof Element ? node.closest("[data-review-header-file]")?.getAttribute("data-review-header-file") ?? undefined : undefined
  const headerActive = (file: string) => hoveredFile() === file || focusedRow() === file

  // Per-file light-DOM hosts for the engine's custom-header slots. The engine
  // asks for a host whenever it (re)renders an item's header; the host is
  // retained only while Pierre renders the item. Its slot snapshot releases
  // the Solid portal synchronously when the item leaves the rendered range.
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

  const reconcileItems = createReviewCodeViewItems<LAnnotation>()
  const items = createMemo(() => reconcileItems({
    diffs: props.diffs,
    open: openSet(),
    customFiles: props.customFiles,
    annotations: props.comments?.annotations,
  }))

  /**
   * Light-DOM review identities on CodeView's rendered item containers: the
   * `data-review-file` identity the app's tooling queries. Shadow DOM stays
   * Pierre's.
   */
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
        // A custom element defaults to display:inline, which computes a zero
        // light-DOM box around shadow content -- invisible to any tooling that
        // measures the host. Give it a real block box.
        element.style.display = "block"
        element.style.minHeight = "1px"
      }
    }
    host.dataset.reviewRenderedFiles = String(rendered.length)
    host.dataset.reviewTotalFiles = String(props.diffs.length)
    if (props.onDiffContentRequired) {
      const visible = current.getRenderedItemIds()
      const nearby = current.getRenderedItemIds({ before: 2, after: 2 })
      props.onDiffContentRequired([...new Set([...visible, ...nearby])].filter(expanded))
    }
  }

  /**
   * Apply a held target, and report it only if the engine took it.
   *
   * A committed item is enough to reach the file. It is not enough to reach a
   * line: a diff whose layout has not been recomputed yet resolves none, and
   * `scrollTo` answers that instead of leaving the caller to assume it landed.
   */
  let appliedReveal: ReviewCodeViewRevealTarget | undefined
  const tryReveal = () => {
    const instance = view
    const target = props.revealTarget
    if (!instance) return
    if (!target) {
      appliedReveal = undefined
      return
    }
    // Compared by reference, not by value: a target stays published until the
    // caller's request ends, so re-applying it on every commit would fight a
    // reader who scrolled away — while a NEW request for the same file is a new
    // object and is applied again.
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
    // Comment wiring is fixed for this mount: it decides which slot renderers
    // the engine allocates and whether selection is live at all.
    const comments = props.comments
    const options: CodeViewOptions<LAnnotation, undefined> = {
      // The app's one Pierre style owner: the OpenCode theme, the shared
      // `unsafeCSS` that maps Pierre's variables onto app tokens, and the
      // reading defaults the file viewers already use.
      ...createDefaultOptions(props.diffStyle),
      // Long lines scroll inside their own row rather than wrapping, and a hunk
      // break carries its line info and nothing else.
      overflow: "scroll",
      hunkSeparators: "line-info-basic",
      // `none` for BOTH diff styles, because this option has to agree with the
      // worker pool's: WorkerPoolManager bakes `lineDiffType` into every
      // highlighted render, while CodeView's copy only drives the main-thread
      // plain pass. Disagreement shows as word highlights that appear and then
      // vanish when the worker result lands.
      lineDiffType: "none",
      // createDefaultOptions turns the file header off for the inline viewers.
      // This surface is the one that uses it: Pierre's header slot is where the
      // accordion row is portalled, and CodeView drops both that slot and the
      // whole sticky-header region when the header is disabled.
      disableFileHeader: false,
      stickyHeaders: true,
      // The engine's own 8px gap and document padding read as loose next to the
      // review list this replaces, whose rows sit 2px apart.
      layout: { paddingTop: 0, paddingBottom: 8, gap: 2 },
      renderCustomItem: (item) => acquireCustomHost(item.id),
      // Keyed by the item id, never `fileDiff.name`: Pierre names a parsed
      // patch from its `+++` header, so a bare `--- a/x` / `+++ b/x` diff is
      // named `b/x` while `open`, `focusedFile` and `renderHeader` all speak
      // the review file `x`.
      ...(props.renderHeader
        ? { renderCustomHeader: (_source: unknown, context: { item: { id: string } }) => acquireHeaderHost(context.item.id) }
        : {}),
      ...(comments
        ? {
            enableLineSelection: true,
            enableGutterUtility: true,
            // The app's store is the one selection anyone reads; leaving the
            // engine uncontrolled would give a drag two owners.
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
              // The engine types the hovered row by its own mode; only the
              // side-tagged one addresses a diff line a comment can hang on.
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
    // NOT container-managed: the managed mode is the React wrapper's portal
    // path and it disables the vanilla header-slot rendering entirely.
    //
    // The pool is chosen by `lineDiffType`, not by diff style: `"unified"` is
    // the pool built with `lineDiffType: "none"`, which is what the options
    // above ask for in either style. It also survives the style toggle, which
    // replaces options but never the instance's pool.
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
        // A collapsed row is a header; it paints no lines, so it owns no
        // annotations, gutter or selection.
        comments?.onRenderedFilesChange([...rendered].filter(expanded))
        stampSoon()
      },
    })
    instance.setup(host)
    instance.setItems(items())
    // setItems queues its own pass; this one is synchronous because `tryReveal`
    // below resolves a line against committed layout, and a queued pass would
    // arrive after it.
    instance.render(true)
    props.anchorTopRef?.((file) => instance.getTopForItem(file))
    tryReveal()

    // CodeView.setup owns this root's scrolling and ResizeObserver. Its native
    // readiness subscriptions render when workers or the shared highlighter
    // become available; this boundary needs no retry timer or second observer.
    const scroller = host
    scroller.dataset.scrollable = "true"
    props.scrollRef?.(host)
    const forwardScroll = (event: Event) => {
      // The row under the pointer just changed without a pointer event, so the
      // hovered row is no longer known until the pointer moves again.
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
      view?.setItems(next)
      // setItems queues its own pass, which is all an ordinary content arrival
      // needs. A held reveal target needs this commit's layout before
      // `tryReveal` can resolve its line, so that one case is forced
      // synchronous instead.
      if (props.revealTarget) view?.render(true)
      tryReveal()
      stampSoon()
    },
  ))

  createEffect(on(() => props.revealTarget, () => tryReveal()))

  // Only a surface with comment wiring has a selection to own; a read-only one
  // must not push one into the engine at all.
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
      // setOptions replaces the complete options object, including callbacks.
      // Preserve the header and post-render owners when switching modes.
      view?.setOptions({ ...optionsForView, diffStyle: style })
      stampSoon()
    },
  ))

  const Header = (header: { file: string }) => (
    <div data-component="accordion" class="ui-accordion">
      <div
        data-slot="accordion-item" class="ui-accordion-item"
        data-review-header-file={header.file}
        data-review-file={header.file}
        data-expanded={expanded(header.file) ? "" : undefined}
        data-selected={props.focusedFile === header.file ? "" : undefined}
      >
        <div data-slot="accordion-header">
          <button
            type="button"
            data-slot="accordion-trigger"
            class="ui-accordion-trigger"
            data-testid={props.headerTestId?.(header.file)}
            data-hovered={headerActive(header.file) ? "" : undefined}
            aria-expanded={expanded(header.file) ? "true" : "false"}
            aria-label={`Toggle diff for ${header.file}`}
            onClick={() => props.onToggleOpen?.(header.file)}
          >
            {props.renderHeader?.(header.file, headerActive(header.file)) ?? header.file}
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
