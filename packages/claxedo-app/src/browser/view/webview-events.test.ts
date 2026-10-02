import { afterEach, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import type { PlacementId } from "@/server"
import type { BrowserBridge, BrowserResult, BrowserWebview } from "../bridge"
import { createBrowserTab } from "../tab"
import { attachWebviewEvents } from "./webview-events"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function setup() {
  const registration = Promise.withResolvers<BrowserResult>()
  const bridge: BrowserBridge = {
    register: mock(() => registration.promise),
    unregister: mock(async () => ({ ok: true })),
    navigate: mock(async () => ({ ok: true })),
    onConsoleEntry: () => () => undefined,
    captureScreenshot: async () => ({ ok: false, error: { code: "unused" } }),
    getNavigationState: mock(async () => ({ ok: true as const, url: "", canGoBack: false, canGoForward: false })),
    goBack: async () => ({ ok: true }),
    goForward: async () => ({ ok: true }),
    reload: async () => ({ ok: true }),
    openDevTools: async () => ({ ok: true }),
    clearStorage: async () => ({ ok: true }),
  }
  const tab = createRoot((dispose) => {
    cleanups.push(dispose)
    return createBrowserTab("placement" as PlacementId, bridge)
  })
  const element = Object.assign(new EventTarget(), { getWebContentsId: () => 17 }) as BrowserWebview
  tab.attachWebview(element)
  const detach = attachWebviewEvents({ tab, element, bridge, deliver: () => true })
  cleanups.push(detach)
  const emit = (name: string, values = {}) => element.dispatchEvent(Object.assign(new Event(name), values))
  return { tab, bridge, registration, emit, detach }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

test("initial blank-page navigation preserves the requested link and waits for registration before reading history", async () => {
  const { tab, bridge, registration, emit } = setup()
  tab.navigateOnce("http://localhost:4445/first", 1)
  emit("did-navigate", { url: "about:blank" })
  expect(tab.state().url).toBe("http://localhost:4445/first")
  expect(bridge.getNavigationState).not.toHaveBeenCalled()
  emit("dom-ready")
  expect(bridge.navigate).not.toHaveBeenCalled()
  registration.resolve({ ok: true })
  await settle()
  expect(bridge.navigate).toHaveBeenCalledWith(tab.paneId, "http://localhost:4445/first")
})

test("a second link while registration is pending is the page loaded when registration completes", async () => {
  const { tab, bridge, registration, emit } = setup()
  tab.navigateOnce("http://localhost:4445/first", 1)
  emit("dom-ready")
  tab.navigateOnce("http://localhost:4445/second", 2)
  registration.resolve({ ok: true })
  await settle()
  expect(bridge.navigate).toHaveBeenCalledTimes(1)
  expect(bridge.navigate).toHaveBeenCalledWith(tab.paneId, "http://localhost:4445/second")
  emit("did-navigate", { url: "http://localhost:4445/redirected" })
  emit("dom-ready")
  await settle()
  expect(tab.state()).toEqual({ kind: "ready", url: "http://localhost:4445/redirected" })
  expect(bridge.getNavigationState).toHaveBeenCalled()
  tab.navigateOnce("http://localhost:4445/third", 3)
  expect(bridge.navigate).toHaveBeenCalledWith(tab.paneId, "http://localhost:4445/third")
})
