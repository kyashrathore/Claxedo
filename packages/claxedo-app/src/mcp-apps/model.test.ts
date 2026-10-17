import { describe, expect, test } from "bun:test"
import { MCP_APP_MIME, type AgentFilePart, type AgentToolPart } from "@claxedo/agent-runtime-contract"
import { hostContext, hostContextChanges } from "./host-context"
import { appFrameTransition, bridgeTransition, clampAppHeight, type AppFrameEvent, type AppFrameState } from "./model"
import { appDocumentOf, isMcpAppPart, toolReplay } from "./part"
import { createAppHeights } from "./store"

function run(events: AppFrameEvent[]): AppFrameState {
  return events.reduce(appFrameTransition, { kind: "loading" } as AppFrameState)
}

describe("the app frame machine", () => {
  test("loads, becomes ready, goes unavailable and recovers", () => {
    expect(run([{ type: "initialized" }])).toEqual({ kind: "ready" })
    expect(run([{ type: "initialized" }, { type: "operationUnavailable" }])).toEqual({ kind: "unavailable" })
    expect(run([{ type: "initialized" }, { type: "operationUnavailable" }, { type: "operationAnswered" }])).toEqual({ kind: "ready" })
  })

  test("a navigation stops the app from any state, for good", () => {
    expect(run([{ type: "navigated" }])).toEqual({ kind: "stopped" })
    expect(run([{ type: "initialized" }, { type: "operationUnavailable" }, { type: "navigated" }, { type: "initialized" }, { type: "operationAnswered" }])).toEqual({ kind: "stopped" })
  })

  test("ignores events that do not apply to the state", () => {
    expect(run([{ type: "operationUnavailable" }, { type: "operationAnswered" }])).toEqual({ kind: "loading" })
    expect(run([{ type: "initialized" }, { type: "initialized" }])).toEqual({ kind: "ready" })
  })

  test("the bridge phase opens once and closes for good", () => {
    let phase = bridgeTransition({ kind: "waiting" }, { type: "initializedReceived" })
    expect(phase).toEqual({ kind: "waiting" })
    phase = bridgeTransition(phase, { type: "initializeAnswered" })
    phase = bridgeTransition(phase, { type: "initializedReceived" })
    expect(phase).toEqual({ kind: "open" })
    expect(bridgeTransition(phase, { type: "initializeAnswered" })).toEqual({ kind: "open" })
    expect(bridgeTransition(bridgeTransition(phase, { type: "closed" }), { type: "initializeAnswered" })).toEqual({ kind: "closed" })
  })

  test("clamps heights", () => {
    expect([0, 80, 319.6, 2000, 5000].map(clampAppHeight)).toEqual([80, 80, 320, 2000, 2000])
  })
})

describe("the host context", () => {
  const base = { theme: { theme: "light" as const, variables: { "--color-text-primary": "#111" } }, displayMode: "inline" as const, width: 640, viewportHeight: 900, locale: "en", platform: "desktop" as const }

  test("describes inline and fullscreen containers", () => {
    expect(hostContext(base)).toEqual({
      theme: "light",
      styles: { variables: { "--color-text-primary": "#111" } },
      displayMode: "inline",
      availableDisplayModes: ["inline", "fullscreen"],
      containerDimensions: { width: 640, maxHeight: 2000 },
      locale: "en",
      platform: "desktop",
    })
    expect(hostContext({ ...base, displayMode: "fullscreen" }).containerDimensions).toEqual({ width: 640, height: 900 })
  })

  test("a change carries only the keys that changed", () => {
    const before = hostContext(base)
    expect(hostContextChanges(before, hostContext(base))).toBeUndefined()
    const dark = hostContext({ ...base, theme: { theme: "dark", variables: { "--color-text-primary": "#eee" } } })
    expect(hostContextChanges(before, dark)).toEqual({ theme: "dark", styles: { variables: { "--color-text-primary": "#eee" } } })
    expect(hostContextChanges(before, hostContext({ ...base, displayMode: "fullscreen" }))).toEqual({ displayMode: "fullscreen", containerDimensions: { width: 640, height: 900 } })
  })
})

function toolPart(state: AgentToolPart["state"], headerOnly?: true): AgentToolPart {
  return { id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "tool", callID: "call_1", tool: "mcp__weather__forecast", state, ...(headerOnly ? { headerOnly } : {}) }
}

const appMetadata = { mcp: { server: "weather", tool: "forecast", structuredContent: { temp: 4 }, resultMeta: { trace: "t1" }, app: { resourceUri: "ui://weather/app" } } }
const time = { start: 1, end: 2 }
const document: AgentFilePart = { id: "prt_f", sessionID: "ses_1", messageID: "msg_1", type: "file", mime: MCP_APP_MIME, url: `data:${MCP_APP_MIME};base64,${btoa("<p>app</p>")}` }

describe("an MCP App tool part", () => {
  test("is an app only when completed with an app reference", () => {
    expect(isMcpAppPart(toolPart({ status: "completed", input: {}, output: "x", title: "", metadata: appMetadata, time }))).toBe(true)
    expect(isMcpAppPart(toolPart({ status: "running", input: {}, metadata: appMetadata, time: { start: 1 } }))).toBe(false)
    expect(isMcpAppPart(toolPart({ status: "completed", input: {}, output: "x", title: "", metadata: { mcp: { server: "weather", tool: "forecast" } }, time }))).toBe(false)
  })

  test("its document is pending while only the header is read, then ready or invalid", () => {
    const completed = (attachments: AgentFilePart[]) =>
      toolPart({ status: "completed", input: {}, output: "x", title: "", metadata: appMetadata, time, attachments })
    expect(appDocumentOf(toolPart({ status: "completed", input: {}, output: "", title: "", metadata: appMetadata, time }, true))).toEqual({ kind: "pending" })
    expect(appDocumentOf(completed([document]))).toEqual({ kind: "ready", html: "<p>app</p>" })
    expect(appDocumentOf(completed([]))).toEqual({ kind: "invalid" })
    expect(appDocumentOf(completed([{ ...document, mime: "text/html" }]))).toEqual({ kind: "invalid" })
    expect(appDocumentOf(completed([{ ...document, url: "data:text/html,<p>" }]))).toEqual({ kind: "invalid" })
  })

  test("replays its input and result, or its cancellation", () => {
    expect(toolReplay(toolPart({ status: "completed", input: { city: "Oslo" }, output: "4°", title: "", metadata: appMetadata, time }))).toEqual([
      { method: "ui/notifications/tool-input", params: { arguments: { city: "Oslo" } } },
      { method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: "4°" }], structuredContent: { temp: 4 }, _meta: { trace: "t1" } } },
    ])
    expect(toolReplay(toolPart({ status: "error", input: { city: "Oslo" }, error: "Interrupted", metadata: appMetadata, time }))).toEqual([
      { method: "ui/notifications/tool-input", params: { arguments: { city: "Oslo" } } },
      { method: "ui/notifications/tool-cancelled", params: { reason: "Interrupted" } },
    ])
  })
})

test("remembered app heights keep the most recent apps up to the cap", () => {
  const heights = createAppHeights(2)
  heights.remember("a", 100)
  heights.remember("b", 200)
  heights.remember("a", 150)
  heights.remember("c", 300)
  expect([heights.read("a"), heights.read("b"), heights.read("c")]).toEqual([150, undefined, 300])
})
