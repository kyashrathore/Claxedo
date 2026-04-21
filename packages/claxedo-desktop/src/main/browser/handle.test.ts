import { describe, expect, test } from "bun:test"

import { AgentAuditLog } from "./agent-audit-log"
import { MAX_CONSOLE_ENTRIES, sanitizeConsoleString } from "./console-buffer"
import { BrowserHandle, type BrowserWc } from "./handle"

/**
 * Handle.test.ts — unit coverage for the CDP state machine, console buffer
 * routing, sanitization, screenshot size caps, evaluate gating, and the
 * crash / cross-origin / DevTools reattach paths.
 *
 * No Electron runtime; a `makeFakeWc()` factory stubs the thin
 * `BrowserWc` surface the handle actually touches.
 */

type EventListener = (...args: unknown[]) => void

function makeFakeWc(options: { initialUrl?: string } = {}): {
  wc: BrowserWc
  emitWc: (event: string, ...args: unknown[]) => void
  emitDebugger: (event: "message" | "detach", ...args: unknown[]) => void
  sendCommandCalls: Array<{ method: string; params: unknown; sessionId?: string }>
  responses: Map<string, unknown>
  attached: { value: boolean }
  attachCalls: number
  detachCalls: number
  setUrl: (url: string) => void
  setLoadError: (err: Error | null) => void
  sendCommandError: { value: Error | null }
} {
  const wcListeners = new Map<string, Set<EventListener>>()
  const dbgListeners = new Map<string, Set<EventListener>>()
  const responses = new Map<string, unknown>()
  const sendCommandCalls: Array<{ method: string; params: unknown; sessionId?: string }> = []
  const attached = { value: false }
  const counters = { attach: 0, detach: 0 }
  let currentUrl = options.initialUrl ?? ""
  let loadError: Error | null = null
  const sendCommandError: { value: Error | null } = { value: null }
  let destroyed = false

  const add = (map: Map<string, Set<EventListener>>, event: string, fn: EventListener) => {
    let set = map.get(event)
    if (!set) {
      set = new Set()
      map.set(event, set)
    }
    set.add(fn)
  }
  const remove = (map: Map<string, Set<EventListener>>, event: string, fn: EventListener) => {
    map.get(event)?.delete(fn)
  }
  const emit = (map: Map<string, Set<EventListener>>, event: string, ...args: unknown[]) => {
    const listeners = map.get(event)
    if (!listeners) return
    for (const fn of Array.from(listeners)) {
      try {
        fn(...args)
      } catch {
        // ignore
      }
    }
  }

  const wc = {
    id: 42,
    isDestroyed: () => destroyed,
    loadURL: async (url: string) => {
      currentUrl = url
    },
    getURL: () => currentUrl,
    on: ((event: string, fn: EventListener) => {
      add(wcListeners, event, fn)
      return wc
    }) as unknown as BrowserWc["on"],
    off: ((event: string, fn: EventListener) => {
      remove(wcListeners, event, fn)
      return wc
    }) as unknown as BrowserWc["off"],
    removeAllListeners: (() => {
      wcListeners.clear()
      return wc
    }) as unknown as BrowserWc["removeAllListeners"],
    debugger: {
      attach: (_v?: string) => {
        counters.attach++
        attached.value = true
      },
      detach: () => {
        counters.detach++
        attached.value = false
      },
      isAttached: () => attached.value,
      sendCommand: async (method: string, params?: unknown, sessionId?: string) => {
        sendCommandCalls.push({ method, params, sessionId })
        if (sendCommandError.value) {
          throw sendCommandError.value
        }
        const key = `${method}|${sessionId ?? ""}`
        if (responses.has(key)) return responses.get(key)
        if (responses.has(method)) return responses.get(method)
        return {}
      },
      on: (event: string, fn: EventListener) => {
        add(dbgListeners, event, fn)
      },
      off: (event: string, fn: EventListener) => {
        remove(dbgListeners, event, fn)
      },
    },
  } as unknown as BrowserWc

  return {
    wc,
    emitWc: (event, ...args) => emit(wcListeners, event, ...args),
    emitDebugger: (event, ...args) => emit(dbgListeners, event, ...args),
    sendCommandCalls,
    responses,
    attached,
    get attachCalls() {
      return counters.attach
    },
    get detachCalls() {
      return counters.detach
    },
    setUrl: (u: string) => {
      currentUrl = u
    },
    setLoadError: (err: Error | null) => {
      loadError = err
      void loadError // eslint-disable-line @typescript-eslint/no-unused-expressions
    },
    sendCommandError,
  }
}

describe("BrowserHandle state machine", () => {
  test("starts Detached; attaches on dom-ready and enables domains", async () => {
    const fake = makeFakeWc()
    const handle = new BrowserHandle(fake.wc)
    expect(handle.state).toBe("detached")

    fake.emitWc("dom-ready")
    // Let all microtasks flush (async attach path).
    await new Promise((r) => setTimeout(r, 0))

    expect(handle.state).toBe("attached")
    expect(fake.attachCalls).toBe(1)
    const methods = fake.sendCommandCalls.map((c) => c.method)
    expect(methods).toContain("Target.setAutoAttach")
    expect(methods).toContain("Runtime.enable")
    expect(methods).toContain("Page.enable")
    expect(methods).toContain("Log.enable")
    expect(methods).toContain("Overlay.enable")
    expect(methods).toContain("DOM.enable")
  })

  test("did-navigate on main frame re-enables domains + re-subscribes auto-attach", async () => {
    const fake = makeFakeWc()
    const handle = new BrowserHandle(fake.wc)
    fake.emitWc("dom-ready")
    await new Promise((r) => setTimeout(r, 0))

    const before = fake.sendCommandCalls.length
    // isMainFrame = true
    fake.emitWc("did-navigate", {}, "https://b.com", 200, "OK", true)
    await new Promise((r) => setTimeout(r, 0))
    const after = fake.sendCommandCalls.slice(before).map((c) => c.method)
    expect(after).toContain("Target.setAutoAttach")
    expect(after).toContain("Runtime.enable")
    expect(handle.state).toBe("attached")
  })

  test("did-navigate on subframe does nothing", async () => {
    const fake = makeFakeWc()
    new BrowserHandle(fake.wc)
    fake.emitWc("dom-ready")
    await new Promise((r) => setTimeout(r, 0))

    const before = fake.sendCommandCalls.length
    fake.emitWc("did-navigate", {}, "https://sub.example.com", 200, "OK", false)
    await new Promise((r) => setTimeout(r, 0))
    expect(fake.sendCommandCalls.length).toBe(before)
  })

  test("render-process-gone clears state and reattaches on next dom-ready", async () => {
    const fake = makeFakeWc()
    const handle = new BrowserHandle(fake.wc)
    fake.emitWc("dom-ready")
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.state).toBe("attached")

    // Simulate a crash — Electron would auto-detach the debugger.
    fake.attached.value = false
    fake.emitWc("render-process-gone")
    expect(handle.state).toBe("detached")

    // And now we reattach:
    fake.emitWc("dom-ready")
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.state).toBe("attached")
    expect(fake.attachCalls).toBe(2)
  })

  test("debugger 'detach' event (DevTools opened) marks Detached; devtools-closed reattaches", async () => {
    const fake = makeFakeWc()
    const handle = new BrowserHandle(fake.wc)
    fake.emitWc("dom-ready")
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.state).toBe("attached")

    fake.attached.value = false // mirror Electron's automatic detach
    fake.emitDebugger("detach", {}, "canceled by user")
    expect(handle.state).toBe("detached")

    fake.emitWc("devtools-closed")
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.state).toBe("attached")
    expect(fake.attachCalls).toBe(2)
  })

  test("webContents 'destroyed' triggers a best-effort detach", async () => {
    const fake = makeFakeWc()
    const handle = new BrowserHandle(fake.wc)
    fake.emitWc("dom-ready")
    await new Promise((r) => setTimeout(r, 0))
    expect(handle.state).toBe("attached")

    fake.emitWc("destroyed")
    expect(handle.state).toBe("detached")
  })
})

describe("BrowserHandle console buffer routing", () => {
  test("dispatches Runtime.consoleAPICalled into the ring buffer", async () => {
    const fake = makeFakeWc()
    const handle = new BrowserHandle(fake.wc)
    fake.emitWc("dom-ready")
    await new Promise((r) => setTimeout(r, 0))

    fake.emitDebugger("message", {}, "Runtime.consoleAPICalled", {
      type: "warning",
      args: [{ type: "string", value: "hello world" }],
    })
    const entries = handle.getConsoleLogs()
    expect(entries.length).toBe(1)
    expect(entries[0].level).toBe("warn")
    expect(entries[0].args).toEqual(["hello world"])
    expect(entries[0].source).toBe("console")
  })

  test("dispatches Runtime.exceptionThrown as error", async () => {
    const fake = makeFakeWc()
    const handle = new BrowserHandle(fake.wc)
    fake.emitWc("dom-ready")
    await new Promise((r) => setTimeout(r, 0))

    fake.emitDebugger("message", {}, "Runtime.exceptionThrown", {
      exceptionDetails: {
        text: "Uncaught",
        exception: { description: "TypeError: boom" },
      },
    })
    const entries = handle.getConsoleLogs()
    expect(entries.length).toBe(1)
    expect(entries[0].level).toBe("error")
    expect(entries[0].source).toBe("exception")
    expect(entries[0].args[0]).toBe("TypeError: boom")
  })

  test("dispatches Log.entryAdded with level mapping", async () => {
    const fake = makeFakeWc()
    const handle = new BrowserHandle(fake.wc)
    fake.emitWc("dom-ready")
    await new Promise((r) => setTimeout(r, 0))

    fake.emitDebugger("message", {}, "Log.entryAdded", {
      entry: { level: "warning", text: "CORS", url: "https://a.com/x" },
    })
    const entries = handle.getConsoleLogs()
    expect(entries.length).toBe(1)
    expect(entries[0].level).toBe("warn")
    expect(entries[0].source).toBe("log")
  })

  test("live listener receives appended entries", async () => {
    const fake = makeFakeWc()
    const handle = new BrowserHandle(fake.wc)
    fake.emitWc("dom-ready")
    await new Promise((r) => setTimeout(r, 0))

    const seen: string[] = []
    const off = handle.onConsoleEntry((e) => seen.push(e.args.join(" ")))

    fake.emitDebugger("message", {}, "Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "tick" }],
    })
    off()
    fake.emitDebugger("message", {}, "Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "tock" }],
    })
    expect(seen).toEqual(["tick"])
  })

  test("ring buffer caps at 2000 with FIFO eviction", async () => {
    const fake = makeFakeWc()
    const handle = new BrowserHandle(fake.wc)
    fake.emitWc("dom-ready")
    await new Promise((r) => setTimeout(r, 0))

    for (let i = 0; i < MAX_CONSOLE_ENTRIES + 50; i++) {
      fake.emitDebugger("message", {}, "Runtime.consoleAPICalled", {
        type: "log",
        args: [{ type: "string", value: `m${i}` }],
      })
    }
    const entries = handle.getConsoleLogs()
    expect(entries.length).toBe(MAX_CONSOLE_ENTRIES)
    // Oldest 50 evicted.
    expect(entries[0].args[0]).toBe("m50")
    expect(entries[entries.length - 1].args[0]).toBe(`m${MAX_CONSOLE_ENTRIES + 49}`)
  })

  test("sanitizes ANSI / zero-width / unicode-tag characters at append", async () => {
    const fake = makeFakeWc()
    const handle = new BrowserHandle(fake.wc)
    fake.emitWc("dom-ready")
    await new Promise((r) => setTimeout(r, 0))

    // ANSI + zero-width joiner + unicode tag "A" (U+E0041)
    const dirty = "[31mhi[0m​‍󠁁end"
    fake.emitDebugger("message", {}, "Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: dirty }],
    })
    const entries = handle.getConsoleLogs()
    expect(entries[0].args[0]).toBe("hiend")
  })
})

describe("sanitizeConsoleString", () => {
  test("strips ANSI CSI sequences", () => {
    expect(sanitizeConsoleString("[31mred[0m")).toBe("red")
  })
  test("strips zero-width chars", () => {
    expect(sanitizeConsoleString("a​b‍c﻿d⁠e")).toBe("abcde")
  })
  test("strips unicode-tag characters (U+E0000..U+E007F)", () => {
    // Tag "ABC" + plain "x"
    const tagged = "󠁁󠁂󠁃x"
    expect(sanitizeConsoleString(tagged)).toBe("x")
  })
  test("preserves ordinary supplementary-plane chars", () => {
    // U+1F600 grinning face
    expect(sanitizeConsoleString("hi😀")).toBe("hi😀")
  })
})

describe("BrowserHandle.screenshot", () => {
  test("returns no-page error when URL is about:blank", async () => {
    const fake = makeFakeWc({ initialUrl: "about:blank" })
    const handle = new BrowserHandle(fake.wc)
    fake.emitWc("dom-ready")
    await new Promise((r) => setTimeout(r, 0))
    const r = await handle.screenshot()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("no-page")
  })

  test("returns not-attached when handle is detached", async () => {
    const fake = makeFakeWc({ initialUrl: "https://example.com" })
    const handle = new BrowserHandle(fake.wc)
    const r = await handle.screenshot()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("not-attached")
  })

  test("returns a PNG data URL when under the size cap", async () => {
    const fake = makeFakeWc({ initialUrl: "https://example.com" })
    fake.responses.set("Page.captureScreenshot", { data: "aGVsbG8=" }) // "hello"
    const handle = new BrowserHandle(fake.wc)
    fake.emitWc("dom-ready")
    await new Promise((r) => setTimeout(r, 0))
    const r = await handle.screenshot()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.mimeType).toBe("image/png")
      expect(r.dataUrl.startsWith("data:image/png;base64,")).toBe(true)
    }
  })

  test("re-encodes to JPEG when PNG exceeds 1 MB", async () => {
    const fake = makeFakeWc({ initialUrl: "https://example.com" })
    // > 1 MB worth of base64 (≈ 0.75 bytes per char → 2M chars).
    const big = "A".repeat(2_000_000)
    fake.responses.set("Page.captureScreenshot", { data: big })
    let recompressCalls = 0
    const handle = new BrowserHandle(fake.wc, {
      recompress: async (pngBase64, opts) => {
        recompressCalls++
        // First call: JPEG at quality 80, no long-edge cap.
        // Second call (if size still >1MB): downscale.
        if (opts.maxLongEdge) {
          return { mimeType: "image/jpeg", base64: "ZmFrZUppZGVzY2FsZWQ=" }
        }
        return { mimeType: "image/jpeg", base64: "ZmFrZUpwZw==" }
      },
    })
    fake.emitWc("dom-ready")
    await new Promise((r) => setTimeout(r, 0))
    const r = await handle.screenshot()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.mimeType).toBe("image/jpeg")
    expect(recompressCalls).toBe(1)
  })

  test("downscales when JPEG re-encode is still > 1 MB", async () => {
    const fake = makeFakeWc({ initialUrl: "https://example.com" })
    const big = "A".repeat(2_000_000)
    fake.responses.set("Page.captureScreenshot", { data: big })
    let lastOpts: { toJpegQuality?: number; maxLongEdge?: number } | undefined
    const handle = new BrowserHandle(fake.wc, {
      recompress: async (pngBase64, opts) => {
        lastOpts = opts
        if (opts.maxLongEdge) {
          return { mimeType: "image/jpeg", base64: "c21hbGw=" }
        }
        // Still over 1 MB even as "jpeg".
        return { mimeType: "image/jpeg", base64: "A".repeat(2_000_000) }
      },
    })
    fake.emitWc("dom-ready")
    await new Promise((r) => setTimeout(r, 0))
    const r = await handle.screenshot()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.mimeType).toBe("image/jpeg")
    expect(lastOpts?.maxLongEdge).toBe(1920)
  })
})

describe("BrowserHandle.evaluate", () => {
  test("refuses when agentAllowed is false — no CDP call made", async () => {
    const fake = makeFakeWc({ initialUrl: "https://example.com" })
    const handle = new BrowserHandle(fake.wc, { auditLog: new AgentAuditLog() })
    fake.emitWc("dom-ready")
    await new Promise((r) => setTimeout(r, 0))

    const before = fake.sendCommandCalls.length
    const r = await handle.evaluate("1 + 1")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe("eval-denied")
    // No Runtime.evaluate call issued.
    const evalCalls = fake.sendCommandCalls.slice(before).filter((c) => c.method === "Runtime.evaluate")
    expect(evalCalls.length).toBe(0)
  })

  test("returns result when agentAllowed is true", async () => {
    const fake = makeFakeWc({ initialUrl: "https://example.com" })
    fake.responses.set("Runtime.evaluate", { result: { value: 2 } })
    const handle = new BrowserHandle(fake.wc, { auditLog: new AgentAuditLog() })
    fake.emitWc("dom-ready")
    await new Promise((r) => setTimeout(r, 0))
    handle.setAgentAllowed(true)

    const r = await handle.evaluate("1 + 1")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result).toBe(2)
  })

  test("wraps exceptionDetails as a script-error", async () => {
    const fake = makeFakeWc({ initialUrl: "https://example.com" })
    fake.responses.set("Runtime.evaluate", {
      exceptionDetails: {
        text: "Uncaught",
        exception: { description: "ReferenceError: x is not defined" },
      },
    })
    const handle = new BrowserHandle(fake.wc, { auditLog: new AgentAuditLog() })
    fake.emitWc("dom-ready")
    await new Promise((r) => setTimeout(r, 0))
    handle.setAgentAllowed(true)

    const r = await handle.evaluate("x.y")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe("script-error")
      expect(r.error.message).toBe("ReferenceError: x is not defined")
    }
  })

  test("audit log records denial and allowed calls", async () => {
    const fake = makeFakeWc({ initialUrl: "https://example.com" })
    fake.responses.set("Runtime.evaluate", { result: { value: 7 } })
    const audit = new AgentAuditLog()
    const handle = new BrowserHandle(fake.wc, { auditLog: audit })
    fake.emitWc("dom-ready")
    await new Promise((r) => setTimeout(r, 0))

    await handle.evaluate("boom") // denied
    handle.setAgentAllowed(true)
    await handle.evaluate("ok") // allowed
    const entries = audit.snapshot()
    expect(entries.length).toBe(2)
    expect(entries[0].result).toBe("denied")
    expect(entries[1].result).toBe("allowed")
  })
})
