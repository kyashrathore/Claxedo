import { describe, expect, test } from "bun:test"

import {
  AGENT_BROWSER_PARTITION,
  createWillAttachWebviewHandler,
  type WillAttachParams,
  type WillAttachWebPreferences,
} from "./will-attach-webview"

type Rejection = { reason: string; params: WillAttachParams }

function makeEvent() {
  let prevented = false
  return {
    event: {
      preventDefault: () => {
        prevented = true
      },
    },
    get prevented() {
      return prevented
    },
  }
}

function makeHandler() {
  const rejections: Rejection[] = []
  const handler = createWillAttachWebviewHandler({
    partition: AGENT_BROWSER_PARTITION,
    onReject: (reason, params) => rejections.push({ reason, params }),
  })
  return { handler, rejections }
}

describe("createWillAttachWebviewHandler", () => {
  test("accepts a valid http src on the agent-browser partition and hardens webPreferences", () => {
    const { handler, rejections } = makeHandler()
    const { event, prevented } = (() => {
      const e = makeEvent()
      return e
    })()

    const webPreferences: WillAttachWebPreferences = {
      // Embedder tried to inject a preload and weak security.
      preload: "/tmp/evil.js",
      preloadURL: "file:///tmp/evil.js",
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      experimentalFeatures: true,
      enableBlinkFeatures: "CSSPaintAPI",
    }
    const params: WillAttachParams = {
      src: "https://example.com/",
      partition: AGENT_BROWSER_PARTITION,
    }

    handler(event, webPreferences, params)

    expect(prevented).toBe(false)
    expect(rejections).toEqual([])

    // Dangerous fields stripped / forced.
    expect(webPreferences.preload).toBeUndefined()
    expect(webPreferences.preloadURL).toBeUndefined()
    expect(webPreferences.nodeIntegration).toBe(false)
    expect(webPreferences.nodeIntegrationInSubFrames).toBe(false)
    expect(webPreferences.nodeIntegrationInWorker).toBe(false)
    expect(webPreferences.contextIsolation).toBe(true)
    expect(webPreferences.sandbox).toBe(true)
    expect(webPreferences.webSecurity).toBe(true)
    expect(webPreferences.allowRunningInsecureContent).toBe(false)
    expect(webPreferences.experimentalFeatures).toBe(false)
    expect(webPreferences.enableBlinkFeatures).toBeUndefined()
    expect(webPreferences.partition).toBe(AGENT_BROWSER_PARTITION)
  })

  test("rejects a guest on a non-agent partition", () => {
    const { handler, rejections } = makeHandler()
    const ev = makeEvent()

    handler(ev.event, {}, { src: "https://example.com/", partition: "persist:something-else" })

    expect(ev.prevented).toBe(true)
    expect(rejections.length).toBe(1)
    expect(rejections[0].reason).toMatch(/partition/)
  })

  test("rejects a guest with no partition declared", () => {
    const { handler, rejections } = makeHandler()
    const ev = makeEvent()

    handler(ev.event, {}, { src: "https://example.com/" })

    expect(ev.prevented).toBe(true)
    expect(rejections.length).toBe(1)
  })

  test("rejects file:// src", () => {
    const { handler, rejections } = makeHandler()
    const ev = makeEvent()

    handler(ev.event, {}, { src: "file:///etc/passwd", partition: AGENT_BROWSER_PARTITION })

    expect(ev.prevented).toBe(true)
    expect(rejections.length).toBe(1)
    expect(rejections[0].reason).toMatch(/scheme/)
  })

  test("rejects javascript: src", () => {
    const { handler } = makeHandler()
    const ev = makeEvent()

    handler(
      ev.event,
      {},
      { src: "javascript:alert(1)", partition: AGENT_BROWSER_PARTITION },
    )

    expect(ev.prevented).toBe(true)
  })

  test("rejects data: src", () => {
    const { handler } = makeHandler()
    const ev = makeEvent()

    handler(
      ev.event,
      {},
      { src: "data:text/html,<script>1</script>", partition: AGENT_BROWSER_PARTITION },
    )

    expect(ev.prevented).toBe(true)
  })

  test("rejects custom-scheme src", () => {
    const { handler } = makeHandler()
    const ev = makeEvent()

    handler(ev.event, {}, { src: "claxedo://hack", partition: AGENT_BROWSER_PARTITION })

    expect(ev.prevented).toBe(true)
  })

  test("accepts http:// src", () => {
    const { handler } = makeHandler()
    const ev = makeEvent()

    handler(
      ev.event,
      {},
      { src: "http://localhost:5173/", partition: AGENT_BROWSER_PARTITION },
    )

    expect(ev.prevented).toBe(false)
  })

  test("accepts about:blank during initial attach", () => {
    const { handler } = makeHandler()
    const ev = makeEvent()

    handler(ev.event, {}, { src: "about:blank", partition: AGENT_BROWSER_PARTITION })

    expect(ev.prevented).toBe(false)
  })

  test("rejects webpreferences string with nodeIntegration", () => {
    const { handler } = makeHandler()
    const ev = makeEvent()

    handler(
      ev.event,
      {},
      {
        src: "https://example.com/",
        partition: AGENT_BROWSER_PARTITION,
        webpreferences: "nodeIntegration=yes",
      },
    )

    expect(ev.prevented).toBe(true)
  })

  test("rejects webpreferences string with contextIsolation=no", () => {
    const { handler } = makeHandler()
    const ev = makeEvent()

    handler(
      ev.event,
      {},
      {
        src: "https://example.com/",
        partition: AGENT_BROWSER_PARTITION,
        webpreferences: "contextIsolation=no",
      },
    )

    expect(ev.prevented).toBe(true)
  })

  test("rejects webpreferences string with webSecurity=no", () => {
    const { handler } = makeHandler()
    const ev = makeEvent()

    handler(
      ev.event,
      {},
      {
        src: "https://example.com/",
        partition: AGENT_BROWSER_PARTITION,
        webpreferences: "webSecurity=no",
      },
    )

    expect(ev.prevented).toBe(true)
  })

  test("rejects webpreferences string with allowRunningInsecureContent", () => {
    const { handler } = makeHandler()
    const ev = makeEvent()

    handler(
      ev.event,
      {},
      {
        src: "https://example.com/",
        partition: AGENT_BROWSER_PARTITION,
        webpreferences: "allowRunningInsecureContent=yes",
      },
    )

    expect(ev.prevented).toBe(true)
  })

  test("rejects webpreferences string with experimentalFeatures", () => {
    const { handler } = makeHandler()
    const ev = makeEvent()

    handler(
      ev.event,
      {},
      {
        src: "https://example.com/",
        partition: AGENT_BROWSER_PARTITION,
        webpreferences: "experimentalFeatures=yes",
      },
    )

    expect(ev.prevented).toBe(true)
  })

  test("strips dangerous attribute-style params", () => {
    const { handler } = makeHandler()
    const ev = makeEvent()

    const params: WillAttachParams = {
      src: "https://example.com/",
      partition: AGENT_BROWSER_PARTITION,
      preload: "/etc/shadow",
      preloadURL: "file:///etc/shadow",
      nodeintegration: "on",
      nodeIntegration: "on",
      nodeintegrationinsubframes: "on",
      enableremotemodule: "on",
      disablewebsecurity: "on",
      allowpopups: "on",
      webpreferences: "",
    }

    handler(ev.event, {}, params)

    expect(ev.prevented).toBe(false)
    expect(params.preload).toBeUndefined()
    expect(params.preloadURL).toBeUndefined()
    expect(params.nodeintegration).toBeUndefined()
    expect(params.nodeIntegration).toBeUndefined()
    expect(params.nodeintegrationinsubframes).toBeUndefined()
    expect(params.enableremotemodule).toBeUndefined()
    expect(params.disablewebsecurity).toBeUndefined()
    expect(params.allowpopups).toBeUndefined()
    expect(params.webpreferences).toBeUndefined()
  })

  test("partition mismatch via webPreferences is also rejected", () => {
    const { handler } = makeHandler()
    const ev = makeEvent()

    handler(
      ev.event,
      { partition: "persist:host-ui" },
      { src: "https://example.com/" },
    )

    expect(ev.prevented).toBe(true)
  })

  test("empty or missing src when partition matches is accepted (attach with loadURL later)", () => {
    const { handler } = makeHandler()
    const ev = makeEvent()

    handler(ev.event, {}, { src: "", partition: AGENT_BROWSER_PARTITION })

    expect(ev.prevented).toBe(false)
  })
})
