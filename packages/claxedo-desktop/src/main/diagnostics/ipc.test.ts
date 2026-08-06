import { describe, expect, mock, test } from "bun:test"

import { registerProcessDiagnosticsIpc, type DiagnosticsIpcRouter, type DiagnosticsWebContents } from "./ipc"

type Listener = (...args: unknown[]) => void

function harness(options: {
  profiler?: object
  scanSessionMemory?: (request: unknown) => Promise<unknown>
  confirmAction?: (input: {
    webContents: DiagnosticsWebContents
    action: "stop" | "kill"
    ownerLabel: string
  }) => Promise<boolean>
} = {}) {
  const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>()
  const router: DiagnosticsIpcRouter = {
    handle: (channel, handler) => {
      handlers.set(channel, handler)
    },
    removeHandler: (channel) => {
      handlers.delete(channel)
    },
  }
  const subscribers = new Set<(snapshot: ReturnType<typeof snapshot>) => void>()
  const profiler = {
    getSnapshot: snapshot,
    getGeneration: () => "generation-1",
    prepareAction: (request: { action: "stop" | "kill" }) => ({
      ok: false as const,
      result: { ok: false as const, action: request.action, code: "invalid-token" as const },
    }),
    cancelAction: (claim: { action: "stop" | "kill" }, code = "user-cancelled" as const) => ({
      ok: false as const,
      action: claim.action,
      code,
    }),
    executeAction: async (claim: { action: "stop" | "kill" }) => ({
      ok: false as const,
      action: claim.action,
      code: "not-eligible" as const,
    }),
    subscribe(listener: (value: ReturnType<typeof snapshot>) => void) {
      subscribers.add(listener)
      return () => subscribers.delete(listener)
    },
  }
  const listeners = new Map<string, Set<Listener>>()
  const sent: Array<{ channel: string; value: unknown }> = []
  const mainFrame = { url: "app://claxedo/index.html" }
  let currentUrl = mainFrame.url
  let destroyed = false
  const webContents: DiagnosticsWebContents = {
    id: 1,
    mainFrame,
    getURL: () => currentUrl,
    isDestroyed: () => destroyed,
    send: (channel, value) => sent.push({ channel, value }),
    on(event, listener) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return webContents
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener)
      return webContents
    },
  }
  const emit = (event: string, ...args: unknown[]) =>
    listeners.get(event)?.forEach((listener) => listener(...args))
  const invoke = (channel: string, senderFrame: unknown = mainFrame, input?: unknown) =>
    handlers.get(channel)?.({ sender: webContents, senderFrame }, input)
  const controller = registerProcessDiagnosticsIpc(router, {
    profiler: (options.profiler ?? profiler) as never,
    scanSessionMemory: options.scanSessionMemory ?? (async (request) => scanResult(request)),
    isAllowedUrl: (url) => url === "app://claxedo/index.html",
    confirmAction: options.confirmAction ?? (async () => false),
  })
  controller.registerWebContents(webContents)
  return {
    controller,
    handlers,
    subscribers,
    sent,
    mainFrame,
    webContents,
    emit,
    invoke,
    setUrl(value: string) {
      currentUrl = value
      mainFrame.url = value
    },
    destroy() {
      destroyed = true
      emit("destroyed")
    },
  }
}

function snapshot() {
  return {
    version: 1 as const,
    generation: "generation-1",
    capturedAt: 10,
    retainedFromAt: 0,
    targetWindowMs: 100,
    retention: { state: "complete" as const },
    owners: [],
    processes: [],
    samples: [],
    sources: [],
    markers: [],
    interval: {
      startAt: 0,
      endAt: 10,
      sampleCount: 0,
      totals: {
        currentCpuMachinePercent: { state: "unavailable" as const, reason: "not-sampled" as const },
        peakCpuMachinePercent: { state: "unavailable" as const, reason: "not-sampled" as const },
        currentRssBytes: { state: "unavailable" as const, reason: "not-sampled" as const },
        peakRssBytes: { state: "unavailable" as const, reason: "not-sampled" as const },
        rssChangeBytes: { state: "unavailable" as const, reason: "not-sampled" as const },
      },
      contributors: [],
      churn: [],
    },
  }
}

function scanResult(request: unknown) {
  const warmSessions = (request as { warmSessions?: unknown[] }).warmSessions ?? []
  const buckets = { chatBytes: 0, imageBytes: 0, compactionBytes: 0, totalBytes: 0 }
  return {
    version: 1 as const,
    scannedAt: 20,
    durationMs: 10,
    stored: buckets,
    resident: buckets,
    sources: [],
    sessions: [],
    warmSessions,
  }
}

describe("process diagnostics IPC", () => {
  test("runs a validated session-memory scan only for the trusted main frame", async () => {
    const requests: unknown[] = []
    const fake = harness({
      scanSessionMemory: async (request) => {
        requests.push(request)
        return scanResult(request)
      },
    })
    const request = {
      warmSessions: [{
        sessionId: "ses_warm",
        mounted: false,
        recency: 0,
        messageCount: 2,
        buckets: { chatBytes: 10, imageBytes: 20, compactionBytes: 30, totalBytes: 60 },
      }],
    }

    await expect(fake.invoke("process-diagnostics:scan-session-memory", fake.mainFrame, request)).resolves.toMatchObject({
      warmSessions: [{ sessionId: "ses_warm" }],
    })
    expect(requests).toEqual([request])
    expect(() => fake.invoke("process-diagnostics:scan-session-memory", fake.mainFrame, { warmSessions: [{ sessionId: "bad" }] })).toThrow()
    fake.controller.dispose()
  })

  test("records validated main-frame context without exposing profiler internals", () => {
    const contexts: unknown[] = []
    const fake = harness({
      profiler: {
        getSnapshot: snapshot,
        getGeneration: () => "generation-1",
        subscribe: () => () => undefined,
        recordContext: (context: unknown) => contexts.push(context),
      },
    })

    expect(fake.invoke("process-diagnostics:context", fake.mainFrame, {
      screen: "workspace-session",
      route: "/w/workspace-1/session/session-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      workbench: {
        focusedSurface: "session",
        focusedPaneId: "pane-1",
        paneCount: 1,
        surfaceCount: 2,
        stashedSurfaceCount: 1,
        paneSurfaceTypes: ["session"],
      },
      terminalTabs: { total: 1, paneBound: 0, stashed: 1 },
      workspacePanel: { open: false },
    })).toEqual({ ok: true })
    expect(contexts).toEqual([expect.objectContaining({ screen: "workspace-session", sessionId: "session-1" })])
    expect(() => fake.invoke("process-diagnostics:context", fake.mainFrame, { screen: "home" })).toThrow()
    fake.controller.dispose()
  })

  test("accepts only the registered current main frame and exact allowed URL", () => {
    const fake = harness()
    expect(fake.invoke("process-diagnostics:get-snapshot")).toEqual(snapshot())
    expect(() => fake.invoke("process-diagnostics:get-snapshot", { url: fake.mainFrame.url })).toThrow()
    fake.setUrl("https://attacker.invalid/")
    expect(() => fake.invoke("process-diagnostics:get-snapshot")).toThrow()
    fake.controller.dispose()
  })

  test("allows one subscription per navigation generation and revokes on navigation", () => {
    const fake = harness()
    expect(fake.invoke("process-diagnostics:subscribe")).toEqual({ kind: "full", snapshot: snapshot() })
    expect(() => fake.invoke("process-diagnostics:subscribe")).toThrow()
    fake.subscribers.forEach((listener) => listener(snapshot()))
    expect(fake.sent).toHaveLength(1)
    expect(fake.sent[0]?.value).toMatchObject({
      kind: "delta",
      delta: { generation: "generation-1", baseCapturedAt: 10 },
    })

    fake.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false })
    fake.subscribers.forEach((listener) => listener(snapshot()))
    expect(fake.sent).toHaveLength(1)
    expect(() => fake.invoke("process-diagnostics:subscribe")).toThrow()
    fake.emit("did-finish-load")
    expect(fake.invoke("process-diagnostics:subscribe")).toEqual({ kind: "full", snapshot: snapshot() })
    fake.controller.dispose()
  })

  test("revokes on renderer loss and WebContents destruction", () => {
    const fake = harness()
    fake.invoke("process-diagnostics:subscribe")
    fake.emit("render-process-gone")
    expect(fake.subscribers.size).toBe(0)
    fake.emit("did-finish-load")
    fake.invoke("process-diagnostics:subscribe")
    fake.destroy()
    expect(fake.subscribers.size).toBe(0)
    expect(() => fake.invoke("process-diagnostics:get-snapshot")).toThrow()
    fake.controller.dispose()
  })

  test("keeps actions opaque and rejects unknown tokens before confirmation", async () => {
    const fake = harness()
    await expect(
      fake.invoke("process-diagnostics:stop", fake.mainFrame, {
        action: "stop",
        token: "opaque-diagnostics-token-0001",
      }),
    ).resolves.toEqual({ ok: false, action: "stop", code: "invalid-token" })
    expect(() =>
      fake.invoke("process-diagnostics:kill", fake.mainFrame, {
        action: "kill",
        token: "opaque-diagnostics-token-0002",
        pid: 42,
      }),
    ).toThrow()
    fake.controller.dispose()
  })

  test("binds native confirmation to the current navigation and never dispatches after replacement", async () => {
    let resolveConfirmation: ((value: boolean) => void) | undefined
    const executeAction = mock(async () => ({
      ok: true as const,
      action: "stop" as const,
      completedAt: 20,
      markerId: "marker-complete",
    }))
    const cancelAction = mock((claim: { action: "stop" }, code = "user-cancelled" as const) => ({
      ok: false as const,
      action: claim.action,
      code,
    }))
    const claim = {
      action: "stop",
      ownerId: "owner-managed",
      ownerGeneration: "owner-generation",
      ownerOperationId: "owner-operation",
      ownerLabel: "Development server",
      identity: {
        id: "host:42:100",
        domain: "host",
        pid: 42,
        creation: { state: "available", value: "100", source: "linux-proc" },
        launchId: "launch-managed",
      },
      profilerGeneration: "generation-1",
    } as const
    const confirmations: Array<{ action: string; ownerLabel: string; webContentsId: number }> = []
    const fake = harness({
      profiler: {
        getSnapshot: snapshot,
        getGeneration: () => "generation-1",
        subscribe: () => () => undefined,
        prepareAction: () => ({ ok: true as const, claim }),
        cancelAction,
        executeAction,
      },
      confirmAction: (input) => {
        confirmations.push({
          action: input.action,
          ownerLabel: input.ownerLabel,
          webContentsId: input.webContents.id,
        })
        return new Promise((resolve) => {
          resolveConfirmation = resolve
        })
      },
    })
    const result = fake.invoke("process-diagnostics:stop", fake.mainFrame, {
      action: "stop",
      token: "opaque-diagnostics-token-0001",
    })
    await Promise.resolve()
    expect(confirmations).toEqual([{
      action: "stop",
      ownerLabel: "Development server",
      webContentsId: 1,
    }])

    fake.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false })
    resolveConfirmation?.(true)
    await expect(result).resolves.toEqual({
      ok: false,
      action: "stop",
      code: "stale-generation",
    })
    expect(cancelAction).toHaveBeenCalledWith(claim, "stale-generation")
    expect(executeAction).not.toHaveBeenCalled()
    fake.controller.dispose()
  })
})
