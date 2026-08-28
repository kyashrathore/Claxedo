import { cleanup, render } from "@solidjs/testing-library"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { clearCompletedMarkdownPaintCache } from "@opencode-ai/session-ui/markdown-rich-stage"
import { createSignal, Suspense } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"

type RendererTrace = { name: string; durationMs: number }

declare global {
  interface Window {
    __claxedoPerfTrace?: boolean
    __claxedoPerfRendererPhases?: RendererTrace[]
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function traceNames() {
  return (window.__claxedoPerfRendererPhases ?? []).map((entry) => entry.name)
}

function mountMarkdown(input: {
  text: string
  parse: (source: string) => Promise<string>
  richAfterMs?: number
  cacheKey?: string
  streaming?: boolean
}) {
  return render(() => (
    <Suspense fallback={<div data-testid="markdown-suspense-fallback">Loading rich Markdown</div>}>
      <MarkedProvider nativeParser={input.parse}>
        <Markdown
          text={input.text}
          cacheKey={input.cacheKey ?? `stage-${crypto.randomUUID()}`}
          richAfterMs={input.richAfterMs ?? 80}
          streaming={input.streaming}
        />
      </MarkedProvider>
    </Suspense>
  ))
}

async function until(check: () => boolean, timeoutMs = 1_000) {
  const end = performance.now() + timeoutMs
  while (!check()) {
    if (performance.now() >= end) throw new Error("timed out waiting for rich Markdown")
    await wait(10)
  }
}

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  window.__claxedoPerfTrace = false
  clearCompletedMarkdownPaintCache()
})

describe("Markdown completed-body first paint", () => {
  test("a cold completed body never paints plain text; it commits rich once parse finishes", async () => {
    const traces: RendererTrace[] = []
    window.__claxedoPerfTrace = true
    window.__claxedoPerfRendererPhases = traces
    const parse = vi.fn(async () => "<p><strong>ready</strong></p>")
    const source = "**ready**\n\n```text\nconst value = 1\n```"
    const view = mountMarkdown({ text: source, parse, richAfterMs: 80 })
    const root = view.container.querySelector<HTMLElement>('[data-component="markdown"]')

    expect(root?.dataset.markdownStage).toBeUndefined()
    expect(root?.textContent).not.toBe(source)
    expect(view.queryByTestId("markdown-suspense-fallback")).toBeNull()

    await until(() => !!root?.querySelector("strong") && !!root.querySelector("code"))
    expect(root?.dataset.markdownStage).toBeUndefined()
    expect(root?.querySelector("strong")?.textContent).toBe("ready")
    expect(root?.querySelector("code")?.textContent).toContain("const value = 1")
    await until(() => parse.mock.calls.length > 0)
    await until(() => traceNames().some((name) => name.startsWith("markdown.highlight.")))
    await until(() => traceNames().some((name) => name.startsWith("markdown.decorate.")))
    expect(parse).toHaveBeenCalled()
    expect(traceNames().some((name) => name.startsWith("markdown.project."))).toBe(true)
    expect(traceNames().some((name) => name.startsWith("markdown.highlight."))).toBe(true)
    expect(traceNames().some((name) => name.startsWith("markdown.decorate."))).toBe(true)
  })

  test("keeps the session surface mounted while an asynchronous rich parse is pending", async () => {
    let resolve!: (html: string) => void
    const pending = new Promise<string>((done) => {
      resolve = done
    })
    const source = "Complete response"
    const view = mountMarkdown({ text: source, parse: () => pending })
    const root = view.container.querySelector<HTMLElement>('[data-component="markdown"]')

    await wait(50)
    expect(root?.dataset.markdownStage).toBeUndefined()
    expect(root?.textContent?.trim()).toBe(source)
    expect(root?.isConnected).toBe(true)
    expect(view.container.querySelector('[data-component="markdown"]')).toBe(root)
    expect(view.queryByTestId("markdown-suspense-fallback")).toBeNull()

    resolve("<p>Complete response</p>")
    await until(() => !!root?.querySelector("p"))
    expect(root?.textContent?.trim()).toBe(source)
  })

  test("unmount does not throw if the rich parse settles after the body is gone", async () => {
    let resolve!: (html: string) => void
    const parse = vi.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done
        }),
    )
    const view = mountMarkdown({ text: "Never project this", parse })
    await Promise.resolve()
    view.unmount()
    resolve?.("<p>Never project this</p>")
    await wait(30)
  })

  test("remount of a completed body paints rich immediately without a plain stage", async () => {
    const parse = vi.fn(async () => "<p><strong>ready</strong></p>")
    const source = "**ready**"
    const cacheKey = `remount-${crypto.randomUUID()}`
    const first = mountMarkdown({ text: source, parse, cacheKey })
    const firstRoot = first.container.querySelector<HTMLElement>('[data-component="markdown"]')
    expect(firstRoot?.dataset.markdownStage).toBeUndefined()

    await until(() => !!firstRoot?.querySelector("strong"))
    const parseCalls = parse.mock.calls.length
    expect(parseCalls).toBeGreaterThan(0)
    first.unmount()

    const second = mountMarkdown({ text: source, parse, cacheKey })
    const secondRoot = second.container.querySelector<HTMLElement>('[data-component="markdown"]')
    expect(secondRoot?.dataset.markdownStage).toBeUndefined()
    expect(secondRoot?.querySelector("strong")?.textContent).toBe("ready")
    expect(parse).toHaveBeenCalledTimes(parseCalls)
  })

  test("a streaming body paints tokens immediately while parse is pending", async () => {
    let resolve!: (html: string) => void
    const pending = new Promise<string>((done) => {
      resolve = done
    })
    const source = "# Hello from the stream"
    const view = mountMarkdown({
      text: source,
      parse: () => pending,
      cacheKey: "stream-live",
      streaming: true,
    })
    const root = view.container.querySelector<HTMLElement>('[data-component="markdown"]')
    expect(root?.querySelector("h1")?.textContent).toBe("Hello from the stream")
    expect(view.queryByTestId("markdown-suspense-fallback")).toBeNull()

    resolve("<h1>Hello from the stream</h1>")
    await until(() => !!root?.querySelector("h1"))
    expect(root?.querySelector("h1")?.textContent).toBe("Hello from the stream")
  })

  test("streaming markdown grows as tokens arrive before parse completes", async () => {
    const pending = new Promise<string>(() => {})
    const [text, setText] = createSignal("Hel")
    const view = render(() => (
      <Suspense fallback={<div data-testid="markdown-suspense-fallback">Loading rich Markdown</div>}>
        <MarkedProvider nativeParser={() => pending}>
          <Markdown text={text()} cacheKey="stream-grow" streaming={true} />
        </MarkedProvider>
      </Suspense>
    ))
    const root = view.container.querySelector<HTMLElement>('[data-component="markdown"]')
    expect(root?.textContent).toContain("Hel")
    expect(root?.querySelector("strong")).toBeNull()
    setText("Hello **world**")
    await until(() => root?.querySelector("strong")?.textContent === "world")
    expect(view.queryByTestId("markdown-suspense-fallback")).toBeNull()
  })

  test("flipping streaming off keeps visible tokens until the completed parse commits", async () => {
    let resolve!: (html: string) => void
    const pending = new Promise<string>((done) => {
      resolve = done
    })
    const parse = vi.fn(() => pending)
    const source = "Streamed **bold** tokens"
    const [streaming, setStreaming] = createSignal(true)
    const view = render(() => (
      <Suspense fallback={<div data-testid="markdown-suspense-fallback">Loading rich Markdown</div>}>
        <MarkedProvider nativeParser={parse}>
          <Markdown text={source} cacheKey="stream-then-complete" streaming={streaming()} />
        </MarkedProvider>
      </Suspense>
    ))
    const root = view.container.querySelector<HTMLElement>('[data-component="markdown"]')
    expect(root?.querySelector("strong")?.textContent).toBe("bold")

    setStreaming(false)
    expect(root?.querySelector("strong")?.textContent).toBe("bold")

    resolve("<p>Streamed <strong>bold</strong> tokens</p>")
    await until(() => !!root?.querySelector("strong"))
    expect(root?.querySelector("strong")?.textContent).toBe("bold")
  })

  test("a later never-seen body also skips the plain stage", async () => {
    const parse = vi.fn(async (source: string) => `<p><strong>${source}</strong></p>`)
    const firstSource = "**first**"
    const laterSource = "**later**"
    const first = mountMarkdown({ text: firstSource, parse, cacheKey: "first-fold" })
    const firstRoot = first.container.querySelector<HTMLElement>('[data-component="markdown"]')
    expect(firstRoot?.dataset.markdownStage).toBeUndefined()
    await until(() => !!firstRoot?.querySelector("strong"))
    const parseCalls = parse.mock.calls.length
    first.unmount()

    const later = mountMarkdown({ text: laterSource, parse, cacheKey: "cold-switch" })
    const laterRoot = later.container.querySelector<HTMLElement>('[data-component="markdown"]')
    expect(laterRoot?.dataset.markdownStage).toBeUndefined()
    expect(laterRoot?.textContent).not.toBe(laterSource)
    expect(laterRoot?.querySelector("strong")?.textContent).toBe("later")
    await until(() => parse.mock.calls.length > parseCalls)
  })
})
