import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { BrowserBridgeApi } from "../store/browser-pane-context"

vi.mock("@opencode-ai/ui/toast", () => ({ showToast: vi.fn() }))

import { BrowserPane, type BrowserPaneCommentPayload } from "./browser-pane"

const HOST_URL = "https://app.example.com/page"

function fakeBridge(): BrowserBridgeApi {
  return {
    enabled: async () => true,
    register: async () => ({ ok: true }),
    unregister: async () => ({ ok: true }),
    navigate: async () => ({ ok: true }),
    getConsoleLogs: async () => [],
    onConsoleEntry: () => () => {},
    captureScreenshot: async () => ({ ok: false, error: { code: "unsupported" } }),
    setInspectMode: async () => ({ ok: true }),
    onNodeSelected: () => () => {},
  }
}

type Harness = {
  webview: HTMLElement
  onPageComment: ReturnType<typeof vi.fn<(payload: BrowserPaneCommentPayload) => boolean>>
  inspectOn: () => void
  ipc: (channel: string, payload: unknown) => Promise<void>
  navigate: (type: string, fields: Record<string, unknown>) => void
  shield: () => Element | null
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

async function mountPane(): Promise<Harness> {
  Object.defineProperty(window, "api", { configurable: true, value: { browser: fakeBridge() } })
  // jsdom has no matchMedia; the webview host subscribes to the dark-scheme query on mount.
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
  const onPageComment = vi.fn<(payload: BrowserPaneCommentPayload) => boolean>(() => true)
  const view = render(() => (
    <BrowserPane paneId="pane-1" tabId="tab-1" initialUrl={HOST_URL} onPageComment={onPageComment} />
  ))
  const webview = await waitFor(() => {
    const el = view.container.querySelector("webview")
    if (!el) throw new Error("webview not mounted")
    return el as HTMLElement
  })
  const navigate = (type: string, fields: Record<string, unknown>) => {
    webview.dispatchEvent(Object.assign(new Event(type), fields))
  }
  navigate("did-navigate", { url: HOST_URL })
  return {
    webview,
    onPageComment,
    inspectOn: () => fireEvent.click(view.getByTestId("browser-pane-inspect-toggle")),
    ipc: async (channel, payload) => {
      webview.dispatchEvent(Object.assign(new Event("ipc-message"), { channel, args: [payload] }))
      await settle()
    },
    navigate,
    shield: () => view.container.querySelector("[data-testid='browser-pane-inspect-shield']"),
  }
}

const pick = (overrides: Record<string, unknown> = {}) => ({
  selector: "#hero > button.cta",
  frameUrl: HOST_URL,
  tagName: "button",
  outerHTML: '<button class="cta">Buy</button>',
  boundingBox: { x: 10, y: 20, width: 100, height: 40 },
  ...overrides,
})

const submit = (overrides: Record<string, unknown> = {}) => ({
  ...pick(),
  content: 'Make this bigger\n\n<button class="cta">Buy</button>',
  ...overrides,
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, "api")
})

describe("browser pane guest IPC", () => {
  test("inspect on, pick, submit routes one comment stamped with the host URL", async () => {
    const h = await mountPane()
    h.inspectOn()
    await h.ipc("claxedo-browser-pick", pick())
    await h.ipc("claxedo-browser-comment-submit", submit())

    expect(h.onPageComment).toHaveBeenCalledTimes(1)
    expect(h.onPageComment.mock.calls[0][0]).toMatchObject({
      tabId: "tab-1",
      pageUrl: HOST_URL,
      selector: "#hero > button.cta",
      comment: "Make this bigger",
    })
  })

  test("submit is dropped while inspect mode is off", async () => {
    const h = await mountPane()
    await h.ipc("claxedo-browser-pick", pick())
    await h.ipc("claxedo-browser-comment-submit", submit())
    expect(h.onPageComment).not.toHaveBeenCalled()
  })

  test("submit is dropped without a prior pick", async () => {
    const h = await mountPane()
    h.inspectOn()
    await h.ipc("claxedo-browser-comment-submit", submit())
    expect(h.onPageComment).not.toHaveBeenCalled()
  })

  test("submit is dropped when its selector differs from the picked one", async () => {
    const h = await mountPane()
    h.inspectOn()
    await h.ipc("claxedo-browser-pick", pick())
    await h.ipc("claxedo-browser-comment-submit", submit({ selector: "#hero > a.other" }))
    expect(h.onPageComment).not.toHaveBeenCalled()
  })

  test("a full load after the pick drops the submit and disarms inspect", async () => {
    const h = await mountPane()
    h.inspectOn()
    await h.ipc("claxedo-browser-pick", pick())
    h.navigate("did-navigate", { url: "https://app.example.com/next" })
    await h.ipc("claxedo-browser-comment-submit", submit())
    expect(h.onPageComment).not.toHaveBeenCalled()
    expect(h.shield()).toBeNull()
  })

  test("an in-page navigation after the pick drops the submit but keeps inspect armed", async () => {
    const h = await mountPane()
    h.inspectOn()
    await h.ipc("claxedo-browser-pick", pick())
    h.navigate("did-navigate-in-page", { url: `${HOST_URL}#step-2`, isMainFrame: true })
    await h.ipc("claxedo-browser-comment-submit", submit())
    expect(h.onPageComment).not.toHaveBeenCalled()
    expect(h.shield()).not.toBeNull()

    await h.ipc("claxedo-browser-pick", pick())
    await h.ipc("claxedo-browser-comment-submit", submit())
    expect(h.onPageComment).toHaveBeenCalledTimes(1)
  })

  test("a subframe in-page navigation leaves the pick intact", async () => {
    const h = await mountPane()
    h.inspectOn()
    await h.ipc("claxedo-browser-pick", pick())
    h.navigate("did-navigate-in-page", { url: "https://ads.example.net/frame#x", isMainFrame: false })
    await h.ipc("claxedo-browser-comment-submit", submit())
    expect(h.onPageComment).toHaveBeenCalledTimes(1)
  })

  test("a frameUrl on another origin is dropped, on pick and on submit", async () => {
    const h = await mountPane()
    h.inspectOn()
    await h.ipc("claxedo-browser-pick", pick({ frameUrl: "https://evil.example.net/page" }))
    await h.ipc("claxedo-browser-comment-submit", submit())
    expect(h.onPageComment).not.toHaveBeenCalled()

    await h.ipc("claxedo-browser-pick", pick())
    await h.ipc("claxedo-browser-comment-submit", submit({ frameUrl: "https://evil.example.net/page" }))
    expect(h.onPageComment).not.toHaveBeenCalled()
  })

  test("the page URL is the host-observed one even when the guest reports a same-origin path", async () => {
    const h = await mountPane()
    h.inspectOn()
    await h.ipc("claxedo-browser-pick", pick())
    await h.ipc("claxedo-browser-comment-submit", submit({ frameUrl: "https://app.example.com/somewhere-else" }))
    expect(h.onPageComment).toHaveBeenCalledTimes(1)
    expect(h.onPageComment.mock.calls[0][0].pageUrl).toBe(HOST_URL)
  })

  test("oversized fields are dropped", async () => {
    const h = await mountPane()
    h.inspectOn()
    await h.ipc("claxedo-browser-pick", pick())
    await h.ipc("claxedo-browser-comment-submit", submit({ content: "x".repeat(8193) }))
    await h.ipc("claxedo-browser-comment-submit", submit({ outerHTML: "<b>".repeat(1000) }))
    expect(h.onPageComment).not.toHaveBeenCalled()

    await h.ipc("claxedo-browser-pick", pick({ selector: "#" + "a".repeat(3000) }))
    await h.ipc("claxedo-browser-comment-submit", submit({ selector: "#" + "a".repeat(3000) }))
    expect(h.onPageComment).not.toHaveBeenCalled()
  })

  test("a non-object or mistyped payload is dropped", async () => {
    const h = await mountPane()
    h.inspectOn()
    await h.ipc("claxedo-browser-pick", "not-an-object")
    await h.ipc("claxedo-browser-pick", pick({ boundingBox: "10,20" }))
    await h.ipc("claxedo-browser-comment-submit", submit())
    expect(h.onPageComment).not.toHaveBeenCalled()
  })
})
