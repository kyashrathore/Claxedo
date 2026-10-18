import { expect, test } from "bun:test"
import { $RAW, createStore } from "solid-js/store"
import { asRecord } from "@claxedo/helpers/guards"
import { createBridge, type BridgeHost } from "./bridge"
import { hostContext, type HostContext } from "./host-context"
import { rpcResult, rpcError, RPC_INVALID_PARAMS, RPC_INVALID_REQUEST, RPC_METHOD_NOT_FOUND, type OutboundMessage, type RequestAnswer } from "./jsonrpc"
import { MAX_FRAME_MESSAGE_BYTES, MAX_REQUESTS_IN_FLIGHT, type DisplayMode } from "./model"

const theme = { theme: "light" as const, variables: { "--color-background-primary": "#fff" } }

const contextInput = { theme, displayMode: "inline" as const, width: 600, viewportHeight: 900, locale: "en", platform: "web" as const }

function fakeHost(calls: string[], context: () => HostContext): BridgeHost {
  let mode: DisplayMode = "inline"
  return {
    hostContext: context,
    hostCapabilities: () => ({ openLinks: {} }),
    replay: () => [
      { method: "ui/notifications/tool-input", params: { arguments: { city: "Oslo" } } },
      { method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: "sunny" }] } },
    ],
    initialized: () => calls.push("initialized"),
    sizeChanged: (height) => calls.push(`size:${height}`),
    openLink: (url) => {
      calls.push(`link:${url}`)
      return rpcResult()
    },
    requestDisplayMode: (requested) => {
      if (requested) mode = requested
      return mode
    },
    callTool: async () => rpcResult({ content: [] }),
    readResource: async () => rpcResult({ contents: [] }),
    message: async () => rpcResult(),
    log: () => calls.push("log"),
  }
}

function harness(overrides: Partial<BridgeHost> = {}) {
  const frameWindow = { name: "app frame" }
  const posted: OutboundMessage[] = []
  const calls: string[] = []
  let context: HostContext = hostContext(contextInput)
  const host: BridgeHost = { ...fakeHost(calls, () => context), ...overrides }
  const bridge = createBridge({ frameWindow: () => frameWindow, post: (message) => posted.push(message), host, hostInfo: { name: "Claxedo", version: "1" } })
  const send = (data: unknown, source: unknown = frameWindow) => bridge.receive({ source, data })
  const request = (id: number, method: string, params: Record<string, unknown> = {}) => send({ jsonrpc: "2.0", id, method, params })
  const notify = (method: string, params: Record<string, unknown> = {}) => send({ jsonrpc: "2.0", method, params })
  const open = async () => {
    request(1, "ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "app", version: "1" }, appCapabilities: {} })
    notify("ui/notifications/initialized")
    await flush()
    posted.length = 0
  }
  const setContext = (next: Partial<Parameters<typeof hostContext>[0]>) => {
    context = hostContext({ ...contextInput, ...next })
  }
  return { bridge, posted, calls, send, request, notify, open, setContext, frameWindow }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const errorOf = (message: OutboundMessage | undefined) => (message && "error" in message ? message.error : undefined)

test("the bridge ignores messages from any window but the frame's own", async () => {
  const h = harness()
  h.send({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} }, { name: "another window" })
  h.send({ jsonrpc: "2.0", id: 2, method: "ui/initialize", params: {} }, null)
  await flush()
  expect(h.posted).toEqual([])
})

test("the bridge answers initialize, then sends nothing until the app says it is initialized", async () => {
  const h = harness()
  h.request(1, "ui/initialize")
  await flush()
  expect(h.posted).toHaveLength(1)
  expect(h.posted[0]).toMatchObject({ id: 1, result: { protocolVersion: "2026-01-26", hostInfo: { name: "Claxedo" }, hostCapabilities: { openLinks: {} }, hostContext: { theme: "light", displayMode: "inline" } } })
  h.setContext({ displayMode: "fullscreen" })
  h.bridge.contextChanged()
  expect(h.posted).toHaveLength(1)
  h.notify("ui/notifications/initialized")
  expect(h.posted.slice(1).map((message) => ("method" in message ? message.method : undefined))).toEqual([
    "ui/notifications/tool-input",
    "ui/notifications/tool-result",
    "ui/notifications/host-context-changed",
  ])
  expect(h.posted[3]).toMatchObject({ params: { displayMode: "fullscreen", containerDimensions: { width: 600, height: 900 } } })
  expect(h.calls).toEqual(["initialized"])
})

test("the bridge replays the tool call once, however often the app repeats itself", async () => {
  const h = harness()
  await h.open()
  h.notify("ui/notifications/initialized")
  h.request(9, "ui/initialize")
  await flush()
  expect(h.posted).toEqual([{ jsonrpc: "2.0", id: 9, error: { code: RPC_INVALID_REQUEST, message: "The app is already initialized" } }])
})

test("the bridge refuses requests before initialize but answers ping", async () => {
  const h = harness()
  h.request(1, "tools/call", { name: "x" })
  h.request(2, "ping")
  await flush()
  expect(errorOf(h.posted[0])?.code).toBe(RPC_INVALID_REQUEST)
  expect(h.posted[1]).toEqual({ jsonrpc: "2.0", id: 2, result: {} })
})

test("the bridge sends only the changed keys of the host context", async () => {
  const h = harness()
  await h.open()
  h.bridge.contextChanged()
  expect(h.posted).toEqual([])
  h.setContext({ width: 480 })
  h.bridge.contextChanged()
  expect(h.posted).toEqual([{ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { containerDimensions: { width: 480, maxHeight: 2000 } } }])
})

test("the bridge answers method-not-found for what the host does not offer", async () => {
  const h = harness()
  await h.open()
  for (const [id, method] of ["ui/update-model-context", "sampling/createMessage", "ui/download-file", "ui/notifications/tool-input-partial"].entries()) h.request(id, method)
  await flush()
  expect(h.posted.map((message) => errorOf(message)?.code)).toEqual([RPC_METHOD_NOT_FOUND, RPC_METHOD_NOT_FOUND, RPC_METHOD_NOT_FOUND, RPC_METHOD_NOT_FOUND])
})

test("the bridge drops a message over the size limit and refuses it when it is a request", async () => {
  const h = harness()
  await h.open()
  const huge = "x".repeat(MAX_FRAME_MESSAGE_BYTES)
  h.request(5, "ui/open-link", { url: `https://example.com/?q=${huge}` })
  h.notify("ui/notifications/size-changed", { height: 500, padding: huge })
  await flush()
  expect(h.posted).toEqual([{ jsonrpc: "2.0", id: 5, error: { code: RPC_INVALID_REQUEST, message: `Messages are limited to ${MAX_FRAME_MESSAGE_BYTES} bytes` } }])
  expect(h.calls).toEqual(["initialized"])
})

test("the bridge refuses requests past the in-flight limit until earlier ones settle", async () => {
  const waiting: ((answer: RequestAnswer) => void)[] = []
  const h = harness({ callTool: () => new Promise((resolve) => waiting.push(resolve)) })
  await h.open()
  for (let id = 1; id <= MAX_REQUESTS_IN_FLIGHT + 1; id++) h.request(id, "tools/call", { name: "slow" })
  await flush()
  expect(h.posted).toEqual([{ jsonrpc: "2.0", id: MAX_REQUESTS_IN_FLIGHT + 1, error: { code: -32000, message: `More than ${MAX_REQUESTS_IN_FLIGHT} requests are in flight` } }])
  waiting[0]?.(rpcResult({ content: [] }))
  await flush()
  h.request(100, "tools/call", { name: "slow" })
  await flush()
  expect(waiting).toHaveLength(MAX_REQUESTS_IN_FLIGHT + 1)
})

test("the bridge opens http and https links only", async () => {
  const h = harness()
  await h.open()
  h.request(1, "ui/open-link", { url: "https://example.com/a" })
  for (const [index, url] of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "not a url", 7].entries()) h.request(10 + index, "ui/open-link", { url })
  await flush()
  expect(h.calls).toEqual(["initialized", "link:https://example.com/a"])
  expect(h.posted.slice(1).map((message) => errorOf(message)?.code)).toEqual([RPC_INVALID_PARAMS, RPC_INVALID_PARAMS, RPC_INVALID_PARAMS, RPC_INVALID_PARAMS, RPC_INVALID_PARAMS])
})

test("the bridge clamps the reported height to 80–2000 pixels", async () => {
  const h = harness()
  await h.open()
  for (const height of [10, 450.4, 99999, Number.NaN]) h.notify("ui/notifications/size-changed", { height })
  h.notify("ui/notifications/size-changed", { width: 300 })
  expect(h.calls).toEqual(["initialized", "size:80", "size:450", "size:2000"])
})

test("the bridge answers display-mode requests with the mode the host settled on", async () => {
  const h = harness()
  await h.open()
  h.request(1, "ui/request-display-mode", { mode: "fullscreen" })
  h.request(2, "ui/request-display-mode", { mode: "pip" })
  await flush()
  expect(h.posted).toEqual([
    { jsonrpc: "2.0", id: 1, result: { mode: "fullscreen" } },
    { jsonrpc: "2.0", id: 2, result: { mode: "fullscreen" } },
  ])
})

test("the bridge asks the app to tear down and closes after its answer or two seconds", async () => {
  const h = harness()
  await h.open()
  const teardown = h.bridge.teardown()
  const sent = h.posted[0]
  expect(sent).toMatchObject({ method: "ui/resource-teardown" })
  h.send({ jsonrpc: "2.0", id: sent && "id" in sent ? sent.id : 0, result: {} })
  await teardown
  h.request(3, "ping")
  await flush()
  expect(h.posted).toHaveLength(1)
})

test("the bridge reports a failing host handler as an internal error", async () => {
  const h = harness({ readResource: async () => Promise.reject(new Error("boom")) })
  await h.open()
  h.request(1, "resources/read", { uri: "ui://x" })
  h.request(2, "tools/call", { name: "x" })
  await flush()
  const byId = (id: number) => h.posted.find((message) => "id" in message && message.id === id)
  expect(errorOf(byId(1))?.code).toBe(-32603)
  expect(byId(2)).toEqual({ jsonrpc: "2.0", id: 2, result: { content: [] } })
})

test("the bridge passes a refusal through as a JSON-RPC error", async () => {
  const h = harness({ message: async () => rpcError("no") })
  await h.open()
  h.request(1, "ui/message", { role: "user", content: [{ type: "text", text: "hi" }] })
  await flush()
  expect(h.posted).toEqual([{ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "no" } }])
})

test("the bridge posts plain data, never a store proxy the frame's postMessage cannot clone", async () => {
  const [part] = createStore({ metadata: { structuredContent: { city: "Oslo", days: [1, 2] } } })
  const h = harness({ replay: () => [{ method: "ui/notifications/tool-result", params: { content: [], structuredContent: part.metadata.structuredContent } }] })
  h.request(1, "ui/initialize")
  h.notify("ui/notifications/initialized")
  await flush()
  const replayed = h.posted.find((message) => "method" in message && message.method === "ui/notifications/tool-result")
  const structured = replayed && "params" in replayed ? asRecord(replayed.params?.structuredContent) : undefined
  expect(structured).toEqual({ city: "Oslo", days: [1, 2] })
  expect(structured && $RAW in structured).toBe(false)
})
