import { cleanup, render } from "@solidjs/testing-library"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { Loading } from "solid-js"
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

function mountMarkdown(input: { text: string; parse: (source: string) => Promise<string>; richAfterMs?: number }) {
  return render(() => (
    <Loading fallback={<div data-testid="markdown-suspense-fallback">Loading rich Markdown</div>}>
      <MarkedProvider nativeParser={input.parse}>
        <Markdown text={input.text} cacheKey={`stage-${crypto.randomUUID()}`} richAfterMs={input.richAfterMs ?? 80} />
      </MarkedProvider>
    </Loading>
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
})

describe("Markdown completed-body first paint", () => {
  test("shows canonical text with no rich pipeline work before activation, then upgrades", async () => {
    const traces: RendererTrace[] = []
    window.__claxedoPerfTrace = true
    window.__claxedoPerfRendererPhases = traces
    const parse = vi.fn(async () => "<p><strong>ready</strong></p>")
    const source = "**ready**\n\n```text\nconst value = 1\n```"
    // `scheduleCompletedMarkdownRichUpgrade` defers the rich stage on a plain
    // `setTimeout`, so virtual time — not a wall-clock sleep — is what proves
    // the body stays plain for the whole budget. A real sleep only holds while
    // the box is idle enough to wake it before the deadline.
    const richAfterMs = 80
    vi.useFakeTimers()
    const view = mountMarkdown({ text: source, parse, richAfterMs })
    const root = view.container.querySelector<HTMLElement>('[data-component="markdown"]')

    expect(root?.dataset.markdownStage).toBe("plain")
    expect(root?.textContent).toBe(source)
    expect(parse).not.toHaveBeenCalled()
    expect(
      traceNames().filter((name) => /markdown\.(project|parse|sanitize|highlight|decorate|block)/.test(name)),
    ).toEqual([])

    // Every scheduler turn strictly inside the budget, with microtasks flushed
    // between them: the pipeline must not have started at any of them.
    await vi.advanceTimersByTimeAsync(richAfterMs - 1)
    expect(root?.textContent).toBe(source)
    expect(parse).not.toHaveBeenCalled()
    expect(
      traceNames().filter((name) => /markdown\.(project|parse|sanitize|highlight|decorate|block)/.test(name)),
    ).toEqual([])

    // Cross the deadline in virtual time; the upgrade timer has to fire before
    // real timers come back, since restoring them discards pending fake ones.
    await vi.advanceTimersByTimeAsync(1)
    vi.useRealTimers()

    await until(() => !!root?.querySelector("strong") && !!root.querySelector("code"))
    expect(root?.dataset.markdownStage).toBeUndefined()
    expect(root?.querySelector("strong")?.textContent).toBe("ready")
    expect(root?.querySelector("code")?.textContent).toContain("const value = 1")
    expect(parse).toHaveBeenCalled()
    expect(traceNames().some((name) => name.startsWith("markdown.project."))).toBe(true)
    expect(traceNames().some((name) => name.startsWith("markdown.sanitize."))).toBe(true)
    expect(traceNames().some((name) => name.startsWith("markdown.highlight."))).toBe(true)
    expect(traceNames().some((name) => name.startsWith("markdown.decorate."))).toBe(true)
  })

  test("keeps plain text visible while an asynchronous rich parse is pending", async () => {
    let resolve!: (html: string) => void
    const pending = new Promise<string>((done) => {
      resolve = done
    })
    const source = "Complete response"
    const view = mountMarkdown({ text: source, parse: () => pending })
    const root = view.container.querySelector<HTMLElement>('[data-component="markdown"]')

    await wait(100)
    expect(root?.dataset.markdownStage).toBe("plain")
    expect(root?.textContent).toBe(source)
    expect(root?.isConnected).toBe(true)
    expect(view.container.querySelector('[data-component="markdown"]')).toBe(root)
    expect(view.queryByTestId("markdown-suspense-fallback")).toBeNull()

    resolve("<p>Complete response</p>")
    await until(() => !!root?.querySelector("p"))
    expect(root?.textContent).toBe(source)
  })

  test("unmount cancels the completed-body rich pipeline", async () => {
    const parse = vi.fn(async (source: string) => `<p>${source}</p>`)
    const view = mountMarkdown({ text: "Never project this", parse })
    view.unmount()

    await wait(100)
    expect(parse).not.toHaveBeenCalled()
  })
})
