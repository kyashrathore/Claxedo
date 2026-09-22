import { cleanup, render } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CodeView, type CodeViewCustomItem, type CodeViewItem, registerCustomTheme } from "../../../../../session-ui/node_modules/@pierre/diffs"
import { resolveFileDiff } from "../../../../../session-ui/src/components/session-diff"
import { ReviewCodeView, type ReviewCodeViewDiff } from "@opencode-ai/session-ui/review-code-view"

// The surface builds its own worker pool; nothing here renders highlighted
// tokens, and a worker is the one collaborator jsdom cannot host.
vi.mock("../../../../../session-ui/src/pierre/worker", () => ({ getWorkerPool: () => undefined }))

// The patched engine itself, not a stand-in for it: these assertions are the
// contract `review-code-view.tsx` builds on, so a stub would only restate the
// test's own assumptions. The test environment runs no layout, so heights come
// from the `data-test-height` model below; real geometry is a browser step.

// The surface names the `OpenCode` theme, and CodeView renders nothing until
// that theme resolves. In the app `workspace-panel-review-load` registers it on
// the same lazy edge that loads the surface; here the registry is process-wide
// and write-once, so register it before the first mount.
registerCustomTheme("OpenCode", () => Promise.resolve({ name: "OpenCode", type: "dark", settings: [] }))

const VIEWPORT = 600
/** Height the engine reserves for an item it has not measured. */
const HEADER = 32
/** Height the owner's mounted row reports, deliberately unequal to HEADER. */
const ROW = 40

function measure(element: Element): number {
  if (element instanceof HTMLElement && element.dataset.testHeight != null) return Number(element.dataset.testHeight)
  let total = 0
  for (const child of element.children) total += measure(child)
  return total
}

let originalRect: PropertyDescriptor | undefined
let originalReplaceSync: PropertyDescriptor | undefined
const resizeCallbacks = new Set<ResizeObserverCallback>()
/** Every viewer this file creates, torn down even when an assertion throws:
 *  a retained viewer keeps its options and the callbacks they close over. */
const viewers = new Set<CodeView>()

beforeEach(() => {
  // jsdom constructs a `CSSStyleSheet` but implements none of the constructable
  // stylesheet methods, and `diffs-container` calls `replaceSync` in its element
  // constructor — so creating one throws out of `document.createElement` and
  // kills the worker instead of failing an assertion. Styles are unobservable
  // without layout, so accepting the text and dropping it changes nothing here.
  originalReplaceSync = Object.getOwnPropertyDescriptor(CSSStyleSheet.prototype, "replaceSync")
  if (typeof CSSStyleSheet.prototype.replaceSync !== "function") {
    Object.defineProperty(CSSStyleSheet.prototype, "replaceSync", { configurable: true, value: () => undefined })
  }
  originalRect = Object.getOwnPropertyDescriptor(Element.prototype, "getBoundingClientRect")
  Object.defineProperty(Element.prototype, "getBoundingClientRect", {
    configurable: true,
    value: function boundingRect(this: Element) {
      const height = measure(this)
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: height, width: 0, height, toJSON: () => ({}) } as DOMRect
    },
  })
  // The environment installs `ResizeObserver` as a non-writable global, so this
  // has to go through the descriptor, not an assignment.
  vi.stubGlobal("ResizeObserver", RecordingResizeObserver)
})

afterEach(() => {
  cleanup()
  for (const viewer of viewers) viewer.cleanUp()
  viewers.clear()
  if (originalRect) Object.defineProperty(Element.prototype, "getBoundingClientRect", originalRect)
  if (originalReplaceSync) Object.defineProperty(CSSStyleSheet.prototype, "replaceSync", originalReplaceSync)
  else Reflect.deleteProperty(CSSStyleSheet.prototype, "replaceSync")
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resizeCallbacks.clear()
  document.body.replaceChildren()
})

/** A resize observer that hands its callback to the test instead of watching. */
class RecordingResizeObserver implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallbacks.add(callback)
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}


/** Report a size change for one element through the engine's own resize entry
 *  point. The engine observes its root AND its sticky container, and treats the
 *  two differently, so the target decides which branch runs. */
function reportResize(target: HTMLElement) {
  const size: ResizeObserverSize = { blockSize: measure(target), inlineSize: 0 }
  const entry: ResizeObserverEntry = {
    target,
    borderBoxSize: [size],
    contentBoxSize: [size],
    devicePixelContentBoxSize: [size],
    contentRect: target.getBoundingClientRect(),
  }
  const observer = new RecordingResizeObserver(() => undefined)
  for (const callback of resizeCallbacks) callback([entry], observer)
}

const reportRootResize = reportResize

/**
 * The sticky container, reached the way the DOM gives it: the rendered rows are
 * its flex children. Growing one of them grows its border box, which is what
 * makes the browser deliver an entry for it.
 */
function stickyContainerOf(view: CodeView): HTMLElement {
  const parent = view.getRenderedItems()[0]?.element.parentElement
  if (!(parent instanceof HTMLElement)) throw new Error("no rendered row to find the sticky container from")
  return parent
}

const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index}\n`).join("")

/**
 * The viewer the surface builds, reached without asking production for a debug
 * handle: every viewer sets itself up, so the spy's first call context is it.
 */
function captureSurfaceEngine() {
  const setup = vi.spyOn(CodeView.prototype, "setup")
  return () => setup.mock.contexts[0] as CodeView | undefined
}

function mountRoot(height = VIEWPORT) {
  const root = document.createElement("div")
  root.dataset.testHeight = String(height)
  document.body.append(root)
  return root
}

/** The engine defers its first content pass until the shared highlighter is up
 * and re-renders itself; nothing here kicks it. */
async function settle(until: () => boolean) {
  for (let attempt = 0; attempt < 400 && !until(); attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
  return until()
}

/** Give something that should not happen a fair chance to happen. */
const quiet = async () => {
  for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setTimeout(resolve, 10))
}

type Harness = {
  view: CodeView
  root: HTMLElement
  bodies: Map<string, HTMLElement>
  renders: string[]
}

function createHarness(items: CodeViewItem<undefined>[], height = VIEWPORT): Harness {
  const root = mountRoot(height)
  const bodies = new Map<string, HTMLElement>()
  const renders: string[] = []
  const view = new CodeView({
    theme: "github-light",
    stickyHeaders: true,
    disableErrorHandling: true,
    // Zero padding and gap so a difference between two item tops is that item's
    // height and nothing else.
    layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
    itemMetrics: { diffHeaderHeight: HEADER },
    renderCustomItem: (item: CodeViewCustomItem) => {
      renders.push(item.id)
      let body = bodies.get(item.id)
      if (!body) {
        body = document.createElement("div")
        body.dataset.reviewPendingRow = item.id
        bodies.set(item.id, body)
      }
      body.dataset.testHeight = String(item.collapsed === false ? ROW * 3 : ROW)
      return body
    },
  })
  viewers.add(view)
  view.setup(root)
  view.setItems(items)
  view.render(true)
  return { view, root, bodies, renders }
}

const pending = (id: string, extra: Partial<CodeViewCustomItem> = {}): CodeViewCustomItem => ({ id, type: "custom", version: 0, ...extra })
const diffItem = (id: string, lines: number): CodeViewItem<undefined> => ({
  id,
  type: "diff",
  version: 1,
  collapsed: false,
  fileDiff: resolveFileDiff({ file: id, before: "", after: Array.from({ length: lines }, (_, line) => `line ${line}\n`).join("") }),
})

describe("CodeView custom items", () => {
  it("reserves one header row for unfetched content and adopts the measured row once mounted", async () => {
    const items = Array.from({ length: 200 }, (_, index) => pending(`f${index}.ts`))
    const { view } = createHarness(items)
    const spacing = (id: string, next: string) => view.getTopForItem(next)! - view.getTopForItem(id)!
    expect(spacing("f0.ts", "f1.ts")).toBe(HEADER)

    expect(await settle(() => view.getRenderedItems().length > 0)).toBe(true)

    expect(spacing("f0.ts", "f1.ts")).toBe(ROW)
    // Content nobody has mounted keeps the reservation instead of inheriting a
    // height measured somewhere else.
    expect(spacing("f198.ts", "f199.ts")).toBe(HEADER)
  })

  it("mounts the owner's row inside the item and releases it when the item leaves the range", async () => {
    const items = Array.from({ length: 200 }, (_, index) => pending(`f${index}.ts`))
    const { view, root, bodies } = createHarness(items)
    expect(await settle(() => view.getRenderedItems().length > 0)).toBe(true)

    const first = bodies.get("f0.ts")!
    expect(first.isConnected).toBe(true)
    expect(view.getRenderedItemIds()).toContain("f0.ts")

    root.scrollTop = 4000
    root.dispatchEvent(new Event("scroll"))
    view.render(true)

    expect(view.getRenderedItemIds()).not.toContain("f0.ts")
    expect(first.isConnected).toBe(false)
    expect(bodies.get(view.getRenderedItemIds()[0])!.isConnected).toBe(true)

    root.scrollTop = 0
    root.dispatchEvent(new Event("scroll"))
    view.render(true)
    expect(view.getRenderedItemIds()).toContain("f0.ts")
    expect(bodies.get("f0.ts")!.isConnected).toBe(true)
  })

  it("expanding every item renders only the rows inside the range", async () => {
    const items = Array.from({ length: 200 }, (_, index) => pending(`f${index}.ts`))
    const { view, renders } = createHarness(items)
    expect(await settle(() => view.getRenderedItems().length > 0)).toBe(true)

    renders.length = 0
    view.setItems(items.map((item) => ({ ...item, collapsed: false, version: 1 })))
    view.render(true)

    const rendered = view.getRenderedItemIds()
    expect(rendered.length).toBeLessThan(items.length)
    expect([...new Set(renders)].sort()).toEqual([...rendered].sort())
  })

  it("bounds prefetch ids to whole items around the rendered range", async () => {
    const items = Array.from({ length: 200 }, (_, index) => pending(`f${index}.ts`))
    const { view, root } = createHarness(items)
    expect(await settle(() => view.getRenderedItems().length > 0)).toBe(true)

    root.scrollTop = 2000
    root.dispatchEvent(new Event("scroll"))
    view.render(true)

    const range = view.getRenderedItemIds()
    const extended = view.getRenderedItemIds({ before: 2, after: 2 })
    const start = items.findIndex((item) => item.id === range[0])
    expect(extended).toEqual(items.slice(start - 2, start + range.length + 2).map((item) => item.id))

    // The document's edges clamp instead of inventing ids.
    root.scrollTop = 0
    root.dispatchEvent(new Event("scroll"))
    view.render(true)
    expect(view.getRenderedItemIds({ before: 5, after: 0 })[0]).toBe("f0.ts")
  })

  it("keeps the anchored item in place when a pending row becomes a diff under the same id", async () => {
    const items: CodeViewItem<undefined>[] = Array.from({ length: 200 }, (_, index) => pending(`f${index}.ts`))
    const { view, root } = createHarness(items)
    expect(await settle(() => view.getRenderedItems().length > 0)).toBe(true)

    root.scrollTop = 2000
    root.dispatchEvent(new Event("scroll"))
    view.render(true)

    // The engine anchors on the first item whose top is inside the viewport, so
    // that is the item whose transition can move the viewport.
    const anchorId = view.getRenderedItemIds().find((id) => view.getTopForItem(id)! >= view.getScrollTop())!
    const anchorIndex = items.findIndex((item) => item.id === anchorId)
    const offsetBefore = view.getTopForItem(anchorId)! - view.getScrollTop()
    expect(offsetBefore).toBeGreaterThanOrEqual(0)

    const next = [...items]
    next[anchorIndex] = diffItem(anchorId, 200)
    view.setItems(next)
    view.render(true)

    expect(view.getTopForItem(anchorId)! - view.getScrollTop()).toBe(offsetBefore)
    // The replacement is a real diff, not a row still reserving header height.
    expect(view.getTopForItem(items[anchorIndex + 1].id)! - view.getTopForItem(anchorId)!).toBeGreaterThan(HEADER)
  })

  /**
   * A viewport WIDTH change reflows owner-rendered rows — a wrapped comment
   * annotation, a media preview, the large-diff block — and the engine tracks
   * no width at all. It does not need to: the rows are flex children of the
   * sticky container, so a reflowed row grows that container's border box and
   * the browser delivers an entry for it. That branch of `handleResize` calls
   * `reconcileRenderedItems()` with no `updatedItems` restriction, which
   * re-measures every rendered row, and then re-anchors the scroll position.
   *
   * This is why the review surface keeps no width observer of its own. If a
   * later @pierre/diffs stops re-measuring or stops anchoring here, this fails.
   */
  it("re-measures rendered rows and holds the anchor when a row reflows taller", async () => {
    const items = Array.from({ length: 200 }, (_, index) => pending(`f${index}.ts`))
    const { view, bodies } = createHarness(items)
    expect(await settle(() => view.getRenderedItems().length > 0)).toBe(true)

    // Anchoring is only defined away from the top of the document:
    // `getScrollAnchor` returns nothing at scrollTop <= 0.
    view.scrollTo({ type: "item", id: "f100.ts", align: "start", behavior: "instant" })
    expect(await settle(() => view.getScrollTop() > 0 && view.getRenderedItemIds().length > 2)).toBe(true)

    const scrollTop = view.getScrollTop()
    const rendered = view.getRenderedItemIds()
    // The engine anchors on the first rendered item at or below the viewport
    // top; the rows before it are the overscan band above the viewport.
    const anchorIndex = rendered.findIndex((id) => view.getTopForItem(id)! >= scrollTop)
    expect(anchorIndex).toBeGreaterThan(0)
    const anchorId = rendered[anchorIndex]
    const anchorOffset = view.getTopForItem(anchorId)! - scrollTop
    const growingId = rendered[0]

    // The reflow: one row above the viewport is now twice as tall. Nothing
    // re-renders it — a width change never does — so the engine learns about it
    // only through the sticky container's own resize entry.
    bodies.get(growingId)!.dataset.testHeight = String(ROW * 2)
    reportResize(stickyContainerOf(view))

    // It re-measured the row it never re-rendered...
    expect(view.getTopForItem(rendered[1])! - view.getTopForItem(growingId)!).toBe(ROW * 2)
    // ...and corrected the scroll position, so the anchored row is still
    // exactly where the reader left it rather than pushed down by the growth.
    expect(view.getScrollTop()).toBeGreaterThan(scrollTop)
    expect(view.getTopForItem(anchorId)! - view.getScrollTop()).toBe(anchorOffset)
  })
})

describe("CodeView lifecycle", () => {
  it("grows its own rendered range when a zero-size root reports a real size", async () => {
    const items = Array.from({ length: 40 }, (_, index) => diffItem(`f${index}.ts`, 20))
    const { view, root } = createHarness(items, 0)
    expect(await settle(() => view.getRenderedItems().length > 0)).toBe(true)

    // A panel that animates open starts at zero height: only the engine's
    // overscroll band is rendered, and the viewport measures zero.
    const collapsed = view.getRenderedItemIds().length
    expect(view.getHeight()).toBe(0)

    root.dataset.testHeight = String(VIEWPORT)
    reportRootResize(root)

    // Nothing below re-renders the viewer; the engine's own root observation does.
    expect(await settle(() => view.getRenderedItemIds().length > collapsed)).toBe(true)
    expect(view.getHeight()).toBe(VIEWPORT)
  })

  // Identity is compared before `expect`, because a failed comparison of two
  // viewers would serialize the whole engine graph into the diff.
  it("publishes where a file sits in the document, including one nobody is rendering", async () => {
    let anchorTop: ((file: string) => number | undefined) | undefined
    render(() => (
      <ReviewCodeView
        diffs={[{ file: "a.ts", before: "", after: lines(400) }, { file: "z.ts" }]}
        diffStyle="unified"
        open={["a.ts"]}
        anchorTopRef={(resolve) => { anchorTop = resolve }}
      />
    ))
    const surface = document.querySelector("[data-component=session-review]")
    if (!(surface instanceof HTMLElement)) throw new Error("the surface did not mount")
    surface.dataset.testHeight = String(VIEWPORT)
    reportRootResize(surface)

    expect(await settle(() => !!anchorTop)).toBe(true)
    // `z.ts` is past the bottom of the viewport and has no element, yet the
    // engine still knows where it is.
    expect(document.querySelector("[data-review-file='z.ts']")).toBeNull()
    expect(anchorTop!("z.ts")).toBeGreaterThan(VIEWPORT)
    expect(anchorTop!("not-in-this-review.ts")).toBeUndefined()

    cleanup()
    expect(anchorTop).toBeUndefined()
  })

  it("holds a file reveal until CodeView has that item, including an unfetched one", async () => {
    const [corpus, setCorpus] = createSignal<ReviewCodeViewDiff[]>([{ file: "a.ts", before: "", after: lines(400) }])
    const revealed = vi.fn()
    const engine = captureSurfaceEngine()
    // Published for a file the document does not contain yet: the request that
    // a focus arriving before its changeset makes.
    render(() => (
      <ReviewCodeView
        diffs={corpus()}
        diffStyle="unified"
        open={["a.ts"]}
        revealTarget={{ file: "late.ts" }}
        onRevealed={revealed}
      />
    ))
    const surface = document.querySelector("[data-component=session-review]")
    if (!(surface instanceof HTMLElement)) throw new Error("the surface did not mount")
    surface.dataset.testHeight = String(VIEWPORT)
    reportRootResize(surface)

    const renderedCount = () => Number(surface.dataset.reviewRenderedFiles ?? 0)
    expect(await settle(() => renderedCount() > 0)).toBe(true)
    expect(revealed).not.toHaveBeenCalled()

    // It arrives as a summary row — no content, no lines — and a file reveal
    // still resolves, because reaching the row needs only the committed item.
    setCorpus([{ file: "a.ts", before: "", after: lines(400) }, { file: "late.ts" }])
    expect(await settle(() => revealed.mock.calls.length > 0)).toBe(true)
    expect(revealed).toHaveBeenCalledWith({ file: "late.ts" })
    expect(await settle(() => (engine()?.getScrollTop() ?? 0) > 0)).toBe(true)
  })

  it("applies one request once, and a new request for the same file again", async () => {
    const [target, setTarget] = createSignal<{ file: string } | null>({ file: "a.ts" })
    const revealed = vi.fn()
    render(() => (
      <ReviewCodeView
        diffs={[{ file: "a.ts", before: "", after: lines(40) }, { file: "b.ts", before: "", after: lines(40) }]}
        diffStyle="unified"
        open={["a.ts", "b.ts"]}
        revealTarget={target()}
        onRevealed={revealed}
      />
    ))
    const surface = document.querySelector("[data-component=session-review]")
    if (!(surface instanceof HTMLElement)) throw new Error("the surface did not mount")
    surface.dataset.testHeight = String(VIEWPORT)
    reportRootResize(surface)

    expect(await settle(() => revealed.mock.calls.length > 0)).toBe(true)
    expect(revealed).toHaveBeenCalledTimes(1)

    // The same request stays published across further commits: a reader who
    // scrolled away must not be dragged back.
    reportRootResize(surface)
    await quiet()
    expect(revealed).toHaveBeenCalledTimes(1)

    // A new request for the same file is a new object, and is applied again.
    setTarget({ file: "a.ts" })
    expect(await settle(() => revealed.mock.calls.length > 1)).toBe(true)
    expect(revealed).toHaveBeenCalledTimes(2)
  })

  it("holds a line reveal until CodeView has committed that file's diff", async () => {
    // `b.ts` is a summary row: Pierre can position it, but it owns no lines, so
    // a line target published now has nothing to resolve against.
    const [corpus, setCorpus] = createSignal<ReviewCodeViewDiff[]>([
      { file: "a.ts", before: "", after: lines(400) },
      { file: "b.ts" },
    ])
    const revealed = vi.fn()
    const engine = captureSurfaceEngine()
    render(() => (
      <ReviewCodeView
        diffs={corpus()}
        diffStyle="unified"
        open={["a.ts", "b.ts"]}
        revealTarget={{ file: "b.ts", lineNumber: 5, side: "additions" }}
        onRevealed={revealed}
      />
    ))
    const surface = document.querySelector("[data-component=session-review]")
    if (!(surface instanceof HTMLElement)) throw new Error("the surface did not mount")
    surface.dataset.testHeight = String(VIEWPORT)
    reportRootResize(surface)

    const renderedCount = () => Number(surface.dataset.reviewRenderedFiles ?? 0)
    expect(await settle(() => renderedCount() > 0)).toBe(true)
    expect(revealed).not.toHaveBeenCalled()
    expect(engine()!.getScrollTop()).toBe(0)

    setCorpus([{ file: "a.ts", before: "", after: lines(400) }, { file: "b.ts", before: "", after: lines(50) }])

    expect(await settle(() => revealed.mock.calls.length > 0)).toBe(true)
    expect(revealed).toHaveBeenCalledTimes(1)
    // The accepted target is applied in the engine's own next pass.
    expect(await settle(() => engine()!.getScrollTop() > 0)).toBe(true)
  })

  it("releases a file's comment owner when its row collapses while still rendered", async () => {
    const rendered: string[][] = []
    const [open, setOpen] = createSignal(["a.ts"])
    render(() => (
      <ReviewCodeView
        diffs={[{ file: "a.ts", before: "", after: "one\ntwo\n" }]}
        diffStyle="unified"
        open={open()}
        comments={{
          annotations: () => undefined,
          owner: () => ({
            renderAnnotation: () => undefined,
            renderGutterUtility: () => undefined,
            onLineSelected: () => undefined,
            onLineSelectionEnd: () => undefined,
          }),
          onRenderedFilesChange: (files) => rendered.push([...files]),
        }}
      />
    ))
    const surface = document.querySelector("[data-component=session-review]")
    if (!(surface instanceof HTMLElement)) throw new Error("the surface did not mount")
    surface.dataset.testHeight = String(VIEWPORT)
    reportRootResize(surface)

    expect(await settle(() => rendered.some((files) => files.includes("a.ts")))).toBe(true)

    // The row stays in the rendered range; only its body goes away.
    setOpen([])
    expect(await settle(() => rendered.at(-1)?.includes("a.ts") === false)).toBe(true)
  })

  it("drops the debug handles that retain a disposed viewer and its caller options", () => {
    const debug = window as Window & { __INSTANCE?: unknown; __TOGGLE?: unknown }
    const first = createHarness([pending("a.ts")])
    expect(debug.__INSTANCE === first.view).toBe(true)
    expect(typeof debug.__TOGGLE).toBe("function")

    const second = createHarness([pending("b.ts")])
    first.view.cleanUp()
    // A later viewer owns the handles; the earlier one must not clear them.
    expect(debug.__INSTANCE === second.view).toBe(true)
    expect(typeof debug.__TOGGLE).toBe("function")

    second.view.cleanUp()
    expect(debug.__INSTANCE === undefined).toBe(true)
    expect(debug.__TOGGLE === undefined).toBe(true)
  })
})
