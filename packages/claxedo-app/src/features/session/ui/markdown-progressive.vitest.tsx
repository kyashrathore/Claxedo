import { cleanup, render } from "@solidjs/testing-library"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { createSignal, Suspense } from "solid-js"
import { afterEach, describe, expect, test } from "vitest"

const rows = 40
const listSource = (count: number) => Array.from({ length: count }, (_, index) => `- row ${index + 1}`).join("\n")
const listHtml = (count: number) =>
  `<ul>${Array.from({ length: count }, (_, index) => `<li>row ${index + 1}</li>`).join("")}</ul>`

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check: () => boolean, timeoutMs = 1_000) {
  const end = performance.now() + timeoutMs
  while (!check()) {
    if (performance.now() >= end) throw new Error("timed out waiting for the list to paint")
    await wait(10)
  }
}

// A row removed after the block has painted is the defect itself: the block's
// height changes under a reader. Polling the row count cannot see it, because a
// staged block restores its rows on a timer and the count is whole again by the
// next sample.
function watchRemovedRows(root: HTMLElement) {
  let removed = 0
  const observer = new MutationObserver((records) => {
    for (const record of records)
      record.removedNodes.forEach((node) => {
        if (node instanceof HTMLLIElement) removed++
      })
  })
  observer.observe(root, { childList: true, subtree: true })
  return { removed: () => removed, stop: () => observer.disconnect() }
}

afterEach(cleanup)

function mount(input: { text: () => string; streaming?: () => boolean; cacheKey: string }) {
  const view = render(() => (
    <Suspense fallback={<div data-testid="markdown-suspense-fallback">Loading rich Markdown</div>}>
      <MarkedProvider nativeParser={async (source: string) => listHtml(source.split("\n").length)}>
        <Markdown text={input.text()} cacheKey={input.cacheKey} streaming={input.streaming?.()} />
      </MarkedProvider>
    </Suspense>
  ))
  const root = view.container.querySelector<HTMLElement>('[data-component="markdown"]')
  if (!root) throw new Error("Markdown root never mounted")
  return { view, root }
}

describe("Markdown long-list paint", () => {
  test("a settled 40-row list paints every row and never grows afterwards", async () => {
    const { view, root } = mount({ text: () => listSource(rows), cacheKey: `settled-${crypto.randomUUID()}` })

    await until(() => root.querySelectorAll("li").length > 0)
    expect(root.querySelectorAll("li")).toHaveLength(rows)
    expect(view.container.querySelector("[data-markdown-progressive]")).toBeNull()

    const watch = watchRemovedRows(root)
    await wait(400)
    watch.stop()
    expect(watch.removed()).toBe(0)
    expect(root.querySelectorAll("li")).toHaveLength(rows)
  })

  test("a list keeps every row through a streaming delta and the settled commit", async () => {
    const [count, setCount] = createSignal(rows)
    const [streaming, setStreaming] = createSignal(true)
    const { view, root } = mount({
      text: () => listSource(count()),
      streaming,
      cacheKey: `stream-${crypto.randomUUID()}`,
    })

    await until(() => root.querySelectorAll("li").length > 0)
    expect(root.querySelectorAll("li")).toHaveLength(rows)

    const watch = watchRemovedRows(root)
    setCount(rows + 1)
    await until(() => root.querySelectorAll("li").length === rows + 1)
    setStreaming(false)
    await wait(400)
    watch.stop()

    expect(watch.removed()).toBe(0)
    expect(root.querySelectorAll("li")).toHaveLength(rows + 1)
    expect(view.container.querySelector("[data-markdown-progressive]")).toBeNull()
  })
})
