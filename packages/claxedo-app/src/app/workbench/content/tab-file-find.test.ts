/**
 * Cmd/Ctrl+F in a file tab finds the whole file, not the rendered window.
 *
 * The file tab's viewer materializes a window of rows, so the rendered DOM is
 * not the file. These drive the real `createFileFind`
 * (`@opencode-ai/session-ui/pierre/file-find`) against the DOM shape a windowed
 * viewer produces — a scroller holding a shadow root with
 * `[data-content] [data-line]` rows for part of the file — and assert the four
 * things the window must not be allowed to decide: how many matches there are,
 * that a match below the window is reachable, that reaching it scrolls to it
 * once its row arrives, and that scrolling a match in paints it.
 *
 * They live here rather than beside `file-find.ts` because `claxedo-app` is the
 * package with a DOM test environment (`happydom.ts`), and the file tab is the
 * surface whose find contract this is. The match arithmetic itself is covered
 * without a DOM in `session-ui/src/pierre/file-find-content.test.ts`.
 */
import { beforeEach, describe, expect, test } from "bun:test"
import { createRoot, flush } from "solid-js"
import { createFileFind } from "@opencode-ai/session-ui/pierre/file-find"

/**
 * happy-dom ships no CSS Custom Highlight API, and that API is exactly where a
 * match becomes visible. This is the browser's shape, recording what was
 * painted: `new Highlight(...ranges)` plus a `CSS.highlights` registry.
 */
class StubHighlight {
  ranges: Range[]
  constructor(...ranges: Range[]) {
    this.ranges = ranges
  }
}
const highlights = new Map<string, StubHighlight>()
// Both are defined rather than assigned: happy-dom exposes `CSS` as a
// read-only accessor, and `Highlight` does not exist there at all.
Object.defineProperty(globalThis, "Highlight", { value: StubHighlight, configurable: true, writable: true })
Object.defineProperty(globalThis, "CSS", {
  value: { ...(globalThis.CSS ?? {}), highlights },
  configurable: true,
  writable: true,
})

const paintedActive = () => highlights.get("opencode-find-current")?.ranges.length ?? 0
const paintedRest = () => highlights.get("opencode-find")?.ranges.length ?? 0

const FILE_LINES = Array.from({ length: 40 }, (_, index) => {
  if (index === 2) return "  const needle = 1"
  if (index === 29) return "  return needle"
  return `  line ${index + 1}`
})

function mountViewer(renderedLines: number[]) {
  // The viewer's rows are a window over a scroller; find listens to that
  // scroller, so the test has to have one.
  const scroller = document.createElement("div")
  scroller.style.overflowY = "scroll"
  document.body.append(scroller)
  const wrapper = document.createElement("div")
  const overlay = document.createElement("div")
  wrapper.append(overlay)
  scroller.append(wrapper)

  const host = document.createElement("div")
  wrapper.append(host)
  const root = host.attachShadow({ mode: "open" })
  const content = document.createElement("div")
  content.setAttribute("data-content", "")
  root.append(content)

  const rows = new Map<number, HTMLElement>()
  const render = (line: number) => {
    const row = document.createElement("div")
    row.setAttribute("data-line", String(line))
    row.textContent = FILE_LINES[line - 1]
    // Rows sit in line order, which is the order find reads them in.
    const after = [...rows.keys()].filter((at) => at < line).length
    content.insertBefore(row, content.children[after] ?? null)
    rows.set(line, row)
    return row
  }
  for (const line of renderedLines) render(line)

  return { scroller, wrapper, overlay, root, rows, render }
}

function createFind(
  viewer: ReturnType<typeof mountViewer>,
  options: { lines?: boolean; revealLine?: (line: number) => void } = {},
) {
  return createRoot(() =>
    createFileFind({
      wrapper: () => viewer.wrapper,
      overlay: () => viewer.overlay,
      getRoot: () => viewer.root,
      lines: options.lines === false ? undefined : () => FILE_LINES,
      revealLine: options.revealLine,
    }),
  )
}

const frames = async (count = 3) => {
  for (let at = 0; at < count; at++) await new Promise((resolve) => setTimeout(resolve, 1))
}

/** Rows arrive frames after the scroll that asked for them; wait for that. */
const settle = async (done: () => boolean) => {
  for (let at = 0; at < 200 && !done(); at++) await new Promise((resolve) => setTimeout(resolve, 1))
}

async function search(find: ReturnType<typeof createFind>, query: string) {
  find.focus()
  await frames()
  find.setQuery(query)
  await frames()
}

beforeEach(() => {
  highlights.clear()
  document.body.innerHTML = ""
})

describe("file tab find over a windowed viewer", () => {
  test("counts every match in the file, not the ones the window rendered", async () => {
    const viewer = mountViewer([1, 2, 3, 4, 5])
    const find = createFind(viewer)
    await search(find, "needle")

    expect(viewer.root.querySelectorAll("[data-line]").length).toBe(5)
    expect(find.count()).toBe(2)
    // Only the rendered one can be painted; the other is still counted.
    expect(paintedActive()).toBe(1)
    expect(paintedRest()).toBe(0)
  })

  test("stepping onto a match below the window asks for its row", async () => {
    const revealed: number[] = []
    const viewer = mountViewer([1, 2, 3, 4, 5])
    const find = createFind(viewer, { revealLine: (line) => revealed.push(line) })
    await search(find, "needle")

    expect(find.index()).toBe(0)
    find.next(1)
    // A keypress is its own task, and find keeps its position in a store, whose
    // writes Solid 2 commits at the end of it. The browser reads the new
    // position on the paint that follows; the test reads it after that commit.
    flush()
    expect(find.index()).toBe(1)
    expect(revealed).toEqual([30])
  })

  test("the revealed row is scrolled to and painted once the window renders it", async () => {
    const viewer = mountViewer([1, 2, 3, 4, 5])
    const scrolled: number[] = []
    const find = createFind(viewer, {
      revealLine: (line) => {
        const row = viewer.render(line)
        row.scrollIntoView = () => scrolled.push(line)
      },
    })
    await search(find, "needle")

    find.next(1)
    await settle(() => scrolled.length > 0)
    expect(scrolled).toEqual([30])
    expect(paintedActive()).toBe(1)
  })

  test("scrolling a match into the window paints it without stealing the scroll", async () => {
    const viewer = mountViewer([1, 2, 3, 4, 5])
    const find = createFind(viewer)
    await search(find, "needle")
    expect(paintedRest()).toBe(0)

    // No reveal hook: the user scrolled, as they do in a windowed file.
    const row = viewer.render(30)
    let stolen = 0
    row.scrollIntoView = () => {
      stolen += 1
    }
    viewer.scroller.dispatchEvent(new Event("scroll"))
    await settle(() => paintedRest() > 0)

    expect(paintedRest()).toBe(1)
    expect(stolen).toBe(0)
  })

  test("without a line source the rendered rows still decide, as a diff needs", async () => {
    const viewer = mountViewer([1, 2, 3, 4, 5])
    const find = createFind(viewer, { lines: false })
    await search(find, "needle")

    expect(find.count()).toBe(1)
  })

  test("a query with no match anywhere in the file counts zero", async () => {
    const viewer = mountViewer([1, 2, 3, 4, 5])
    const find = createFind(viewer)
    await search(find, "haystack")

    expect(find.count()).toBe(0)
    expect(paintedActive()).toBe(0)
  })
})
