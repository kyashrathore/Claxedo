import { cleanup, render } from "@solidjs/testing-library"
import { createSignal, onCleanup } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ReviewCodeView } from "@opencode-ai/session-ui/review-code-view"

// Exercise the Solid boundary with Pierre's 1.4 slot-snapshot contract.
// Geometry and worker rendering require the browser acceptance gate.
const engine = vi.hoisted(() => {
  type Item = { id: string; type: "diff" | "custom"; fileDiff?: { name: string }; collapsed: boolean }
  type Options = {
    diffStyle?: string
    renderCustomHeader?: (diff: { name: string }) => HTMLElement
    renderCustomItem?: (item: Item) => HTMLElement
    onPostRender?: () => void
  }
  class Viewer {
    static current: Viewer
    options: Options
    items: Item[] = []
    root!: HTMLElement
    start = 0
    rendered: { id: string; type: "diff" | "custom"; element: HTMLElement }[] = []
    coordinator?: { onSnapshotChange: (snapshot: { items: { id: string; type: "diff" | "custom" }[] } | undefined) => void }
    constructor(options: Options) { this.options = options; Viewer.current = this }
    setup(root: HTMLElement) { this.root = root }
    // Both render, as @pierre/diffs 1.4.3 does: `setItems` renders from
    // appendItemsInternal/reconcileItems, and `setOptions` ends in `render()`
    // for a non-container-managed view with items. Pierre's skips (an append
    // entirely below the window, a no-op reconcile) leave the rendered set
    // unchanged, which is what this fake's `render` recomputes anyway.
    setItems(items: Item[]) { this.items = items; this.render() }
    setOptions(options: Options) { this.options = options; this.render() }
    setSlotCoordinator(coordinator: Viewer["coordinator"]) { this.coordinator = coordinator }
    subscribeToScroll() { return () => {} }
    getRenderedItems() { return this.rendered }
    getRenderedItemIds(extend?: { before?: number; after?: number }) {
      return this.items.slice(Math.max(0, this.start - (extend?.before ?? 0)), this.start + 2 + (extend?.after ?? 0)).map((item) => item.id)
    }
    scrollTo = vi.fn()
    render() {
      const retained = new Map(this.rendered.map((record) => [record.id, record]))
      this.rendered = this.items.slice(this.start, this.start + 2).map((item) => {
        const previous = retained.get(item.id)
        if (previous && previous.type !== item.type) previous.element.remove()
        const record = previous?.type === item.type ? previous : { id: item.id, type: item.type, element: document.createElement("div") }
        if (!record.element.shadowRoot) {
          const shadow = record.element.attachShadow({ mode: "open" })
          shadow.append(document.createElement("style"), document.createElement("slot"))
        }
        const header = item.type === "custom" ? this.options.renderCustomItem?.(item) : this.options.renderCustomHeader?.(item.fileDiff!)
        if (header) record.element.append(header)
        this.root.append(record.element)
        retained.delete(item.id)
        return record
      })
      for (const record of retained.values()) record.element.remove()
      this.coordinator?.onSnapshotChange({ items: this.rendered })
      this.options.onPostRender?.()
    }
    cleanUp() {
      for (const record of this.rendered) record.element.remove()
      this.rendered = []
      this.coordinator?.onSnapshotChange(undefined)
    }
  }
  return { Viewer }
})

vi.mock("../../../../../session-ui/node_modules/@pierre/diffs", async (original) => ({
  ...await original<typeof import("../../../../../session-ui/node_modules/@pierre/diffs")>(),
  CodeView: engine.Viewer,
}))
vi.mock("../../../../../session-ui/src/pierre/worker", () => ({ getWorkerPool: () => undefined }))

afterEach(cleanup)
const diffs = Array.from({ length: 100 }, (_, index) => ({ file: `${index}.ts`, before: "a\n", after: "b\n" }))

describe("ReviewCodeView rendered item ownership", () => {
  it("reports expanded rendered items before bounded neighboring prefetch targets", async () => {
    const required = vi.fn()
    render(() => <ReviewCodeView diffs={diffs} open={diffs.map((diff) => diff.file)} diffStyle="unified" onDiffContentRequired={required} />)
    engine.Viewer.current.start = 20
    engine.Viewer.current.render()
    await vi.waitFor(() => expect(required).toHaveBeenLastCalledWith(["20.ts", "21.ts", "18.ts", "19.ts", "22.ts", "23.ts"]))
  })

  it("pending UI is released on scroll and when the same item receives content", () => {
    const pending = diffs.map(({ file }) => ({ file }))
    const [items, setItems] = createSignal<typeof pending | typeof diffs>(pending)
    const live = new Set<string>()
    const Pending = (props: { file: string }) => {
      live.add(props.file)
      onCleanup(() => live.delete(props.file))
      return <span>Loading {props.file}</span>
    }
    const screen = render(() => <ReviewCodeView diffs={items()} open={pending.map((item) => item.file)} diffStyle="unified" renderCustomBody={(file) => <Pending file={file} />} />)
    expect([...live]).toEqual(["0.ts", "1.ts"])
    expect(engine.Viewer.current.items.every((item) => item.type === "custom")).toBe(true)
    engine.Viewer.current.start = 20
    engine.Viewer.current.render()
    expect([...live]).toEqual(["20.ts", "21.ts"])
    setItems(diffs)
    expect(live.size).toBe(0)
    expect(screen.queryByText("Loading 20.ts")).toBeNull()
    expect(engine.Viewer.current.items[20].type).toBe("diff")
  })

  it("expand all changes state without mounting offscreen headers; release disposes portals", () => {
    const [open, setOpen] = createSignal<string[]>([])
    const live = new Set<string>()
    const Header = (props: { file: string }) => {
      live.add(props.file)
      onCleanup(() => live.delete(props.file))
      return <span>{props.file}</span>
    }
    render(() => <ReviewCodeView diffs={diffs} open={open()} diffStyle="unified" renderHeader={(file) => <Header file={file} />} />)
    expect([...live]).toEqual(["0.ts", "1.ts"])
    setOpen(diffs.map((diff) => diff.file))
    expect(live.size).toBe(2)
    expect(engine.Viewer.current.items.every((item) => !item.collapsed)).toBe(true)
    for (const start of [20, 40, 80, 40, 0]) {
      engine.Viewer.current.start = start
      engine.Viewer.current.render()
      expect([...live]).toEqual([`${start}.ts`, `${start + 1}.ts`])
    }
    cleanup()
    expect(live.size).toBe(0)
  })

  it("mode switches retain header and post-render callbacks", () => {
    const [style, setStyle] = createSignal<"unified" | "split">("unified")
    const rendered = vi.fn()
    const screen = render(() => <ReviewCodeView diffs={diffs} open={[]} diffStyle={style()} onDiffRendered={rendered} renderHeader={(file) => <span>{file}</span>} />)
    const header = engine.Viewer.current.options.renderCustomHeader
    rendered.mockClear()
    setStyle("split")
    expect(engine.Viewer.current.options.diffStyle).toBe("split")
    expect(engine.Viewer.current.options.renderCustomHeader).toBe(header)
    expect(rendered).toHaveBeenCalled()
    expect(screen.getByText("0.ts")).toBeTruthy()
  })
})
