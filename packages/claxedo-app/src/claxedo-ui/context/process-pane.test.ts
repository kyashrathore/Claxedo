/**
 * Process Pane UI Integration Tests
 *
 * Tests observable behavior of the ProcessPane context: config fetching,
 * SSE event processing, lifecycle actions, scroll navigation, pane width
 * management, and tab integration.
 *
 * Strategy: mock createSimpleContext, persisted, SDK, globalSDK, platform,
 * and claxedoLayout — then exercise the captured init() inside createRoot.
 *
 * The mock fetch uses shared mutable state (`fetchState`) so the same fetch
 * function reference captured at init time reads the latest test-supplied
 * responses and records calls for assertion.
 */
import { beforeAll, beforeEach, describe, expect, test, mock } from "bun:test"
import { createRoot } from "solid-js"

// ── Mock infrastructure ────────────────────────────────────────────────

type Listener = (event: any) => void

/** Fake SSE emitter mimicking createGlobalEmitter from @solid-primitives/event-bus */
function createMockEmitter() {
  const listeners = new Map<string, Set<Listener>>()
  return {
    on(key: string, fn: Listener) {
      if (!listeners.has(key)) listeners.set(key, new Set())
      listeners.get(key)!.add(fn)
      return () => listeners.get(key)?.delete(fn)
    },
    emit(key: string, payload: any) {
      const fns = listeners.get(key)
      if (!fns) return
      for (const fn of fns) fn(payload)
    },
    _listeners: listeners,
  }
}

/**
 * Shared mutable state for the mock fetch.
 * The fetchFn reference never changes — it always reads from this object.
 * Tests configure `responses` and assert on `calls`.
 */
type FetchCall = { url: string; method: string; body?: any; headers?: Record<string, string> }

const fetchState = {
  responses: {} as Record<string, () => any>,
  calls: [] as FetchCall[],
}

async function mockFetchFn(url: string, opts?: RequestInit): Promise<Response> {
  const method = opts?.method ?? "GET"
  const body = opts?.body ? JSON.parse(opts.body as string) : undefined
  const headers: Record<string, string> = {}
  if (opts?.headers) {
    const h = opts.headers as Record<string, string>
    for (const [k, v] of Object.entries(h)) headers[k] = v
  }
  fetchState.calls.push({ url, method, body, headers })

  const key = `${method} ${url}`
  const handler = Object.entries(fetchState.responses).find(([pattern]) => key.includes(pattern))
  const data = handler ? handler[1]() : {}

  // Support __fail sentinel for retry tests
  if (data && (data as any).__fail) {
    return {
      ok: false,
      status: 503,
      json: async () => ({}),
    } as unknown as Response
  }

  // Support __hang sentinel for deadlock tests — fetch never resolves
  // (but respects AbortSignal so postAction's timeout can break out)
  if (data && (data as any).__hang) {
    const signal = opts?.signal
    if (signal) {
      return new Promise<Response>((_, reject) => {
        const onAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"))
        if (signal.aborted) { onAbort(); return }
        signal.addEventListener("abort", onAbort)
      })
    }
    return new Promise<Response>(() => {})
  }

  return {
    ok: true,
    status: 200,
    json: async () => data,
  } as unknown as Response
}

type MockTab = { id: string; type: string; terminalId?: string }
type MockGroup = { id: string; tabs: MockTab[] }

// Mock terminal context (upstream TerminalProvider)
const removedStalePtyIds: string[] = []
function createMockTerminalCtx() {
  return {
    removeStale(ids: Set<string>) {
      for (const id of ids) removedStalePtyIds.push(id)
    },
  }
}
let mockTerminalCtx = createMockTerminalCtx()

function createMockClaxedoLayout() {
  let isOpen = false
  let toggleVer = 0
  let pendingOpen = false
  const addedTerminals: Array<{ dir: string; ptyId: string; title: string }> = []
  let activeTabId: string | null = null
  const ownedPtys = new Map<string, string>()
  // Start at 1 to match real terminal.ts behavior: assume processes may exist
  // until ProcessPaneProvider calls resolveInitialProcessPty().
  let pendingProcessPtys = 1

  let crashedWhileClosed = false

  // Mutable groups array for testing deferred tab cleanup
  let groups: MockGroup[] = []
  const closedTabs: string[] = []

  // ClaxedoLayout persistence readiness — starts true by default (sync storage)
  let layoutReady = true

  return {
    ready: () => layoutReady,
    processPane: {
      isActive: () => isOpen,
      requestToggle() {
        isOpen = !isOpen
      },
      requestOpen() {
        isOpen = true
      },
      targetDirectory: () => null,
      setTargetDirectory(_dir: string | null) {},
      crashedWhileClosed: () => crashedWhileClosed,
      setCrashedWhileClosed(v: boolean) {
        crashedWhileClosed = v
      },
      pendingAction: () => null,
      clearPendingAction() {},
    },
    split: {
      focusedId: () => undefined,
      orderedGroups: () => groups,
    },
    terminal: {
      own(tab: string, id: string) {
        ownedPtys.set(id, tab)
      },
      disown(id: string) {
        ownedPtys.delete(id)
      },
      owner(id: string) {
        return ownedPtys.get(id)
      },
      /** Return all PTY IDs currently owned by a process (owner starts with "process:"). */
      processOwnedPtyIds(): string[] {
        const result: string[] = []
        for (const [ptyId, owner] of ownedPtys) {
          if (owner.startsWith("process:")) result.push(ptyId)
        }
        return result
      },
      expectProcessPty() {
        pendingProcessPtys++
      },
      resolveProcessPty() {
        pendingProcessPtys = Math.max(0, pendingProcessPtys - 1)
      },
      resolveInitialProcessPty() {
        pendingProcessPtys = Math.max(0, pendingProcessPtys - 1)
      },
      pendingProcessStarts: () => pendingProcessPtys,
    },
    topTabs: {
      addTerminal(dir: string, ptyId: string, title: string) {
        const tabId = `tab-${ptyId}`
        addedTerminals.push({ dir, ptyId, title })
        return tabId
      },
      setActive(id: string) {
        activeTabId = id
      },
    },
    groupTabs: (groupId: string) => ({
      items: () => groups.find((g) => g.id === groupId)?.tabs ?? [],
      close(tabId: string) {
        closedTabs.push(tabId)
        const group = groups.find((g) => g.id === groupId)
        if (group) {
          group.tabs = group.tabs.filter((t) => t.id !== tabId)
        }
      },
    }),
    select: {
      visibleGroups: () => groups,
      multiPaneLeafView: () => [],
    },
    multiPane: {
      initTabWithContent: () => {},
      setContent: () => {},
      splitLeaf: () => undefined,
      closeLeaf: () => {},
      getState: () => undefined,
      leafIds: () => [],
    },
    // test helpers
    _addedTerminals: addedTerminals,
    _getActiveTab: () => activeTabId,
    _getIsOpen: () => isOpen,
    _getCrashedWhileClosed: () => crashedWhileClosed,
    _ownedPtys: ownedPtys,
    _setGroups(g: MockGroup[]) { groups = g },
    _getGroups: () => groups,
    _closedTabs: closedTabs,
    _setReady(v: boolean) { layoutReady = v },
    _getReady: () => layoutReady,
  }
}

// ── Capture init function ──────────────────────────────────────────────

let _initProcessPane: ((deps?: any) => any) | undefined
let mockEmitter: ReturnType<typeof createMockEmitter>
let mockLayout: ReturnType<typeof createMockClaxedoLayout>

const DEFAULT_DIRECTORY = "/test/workspace"
let currentDirectory = DEFAULT_DIRECTORY
const SDK_URL = "http://localhost:4096"

beforeAll(async () => {
  mockEmitter = createMockEmitter()
  mockLayout = createMockClaxedoLayout()
  fetchState.responses = { "GET": () => ({ configs: [], processes: [] }) }
  fetchState.calls = []

  mock.module("@opencode-ai/ui/context", () => ({
    createSimpleContext: (config: any) => {
      if (config.name === "ProcessPane") _initProcessPane = config.init
      return { use: () => {}, provider: () => {} }
    },
  }))

  mock.module("@/utils/persist", () => ({
    Persist: {
      workspace: () => ({}),
      global: () => ({}),
    },
    persisted: (_target: any, storeResult: any) => {
      return [...storeResult, undefined, () => true]
    },
  }))

  mock.module("@/context/sdk", () => ({
    useSDK: () => ({
      url: SDK_URL,
      get directory() { return currentDirectory },
    }),
  }))

  // globalSDK mock reads from the mutable `mockEmitter` reference
  mock.module("@/context/global-sdk", () => ({
    useGlobalSDK: () => ({
      get event() {
        return mockEmitter
      },
    }),
  }))

  // Platform mock uses the shared fetchState — the reference never changes
  mock.module("@/context/platform", () => ({
    usePlatform: () => ({
      fetch: mockFetchFn,
    }),
  }))

  mock.module("./claxedo-layout", () => ({
    get useClaxedoLayout() {
      return () => mockLayout
    },
  }))

  mock.module("@/context/terminal", () => ({
    get useTerminal() {
      return () => mockTerminalCtx
    },
    get useOptionalTerminal() {
      return () => mockTerminalCtx
    },
  }))

  mock.module("@opencode-ai/ui/context/dialog", () => ({
    useDialog: () => ({
      show: () => {},
      close: () => {},
    }),
  }))

  mock.module("../components/add-process-dialog", () => ({
    AddProcessDialog: () => null,
  }))

  await import("./process-pane")
})

beforeEach(() => {
  // Reset shared state between tests
  currentDirectory = DEFAULT_DIRECTORY
  mockEmitter = createMockEmitter()
  mockLayout = createMockClaxedoLayout()
  mockTerminalCtx = createMockTerminalCtx()
  removedStalePtyIds.length = 0
  fetchState.responses = { "GET": () => ({ configs: [], processes: [] }) }
  fetchState.calls = []
  // Reset visibilityState to prevent cross-test contamination
  Object.defineProperty(document, "visibilityState", {
    value: "visible",
    writable: true,
    configurable: true,
  })
})

function getInit(): () => any {
  if (!_initProcessPane) throw new Error("init not captured — import failed")
  return _initProcessPane
}

/**
 * Mock fetch that can fail a configurable number of times before succeeding.
 * Used by retry tests. When `failCount` > 0, returns `ok: false`.
 */
function createFailThenSuccessFetch(failCount: number, successData: any) {
  let calls = 0
  return () => {
    calls++
    if (calls <= failCount) {
      return { __fail: true }
    }
    return successData
  }
}

function createTestProcessPane(fetchResponses?: Record<string, () => any>) {
  if (fetchResponses) {
    fetchState.responses = fetchResponses
  }

  let dispose!: () => void
  const api = createRoot((d) => {
    dispose = d
    return getInit()()
  })
  return { api, dispose }
}

// ── Wake / visibility helpers ─────────────────────────────────────────

function simulateVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    value: state,
    writable: true,
    configurable: true,
  })
  document.dispatchEvent(new Event("visibilitychange"))
}

function simulateWake() {
  simulateVisibility("visible")
}

function simulateHide() {
  simulateVisibility("hidden")
}

// ── Helpers ────────────────────────────────────────────────────────────

const SAMPLE_CONFIG = {
  id: "proc_abc123",
  name: "Dev Server",
  command: "npm run dev",
  args: [] as string[],
  autoStart: false,
  restartPolicy: "never" as const,
  maxRestarts: 3,
}

const SAMPLE_CONFIG_2 = {
  id: "proc_def456",
  name: "Database",
  command: "docker compose up",
  args: [] as string[],
  autoStart: true,
  restartPolicy: "always" as const,
  maxRestarts: 5,
}

function emitSSE(type: string, properties: Record<string, any>, directory?: string) {
  mockEmitter.emit(directory ?? currentDirectory, { type, properties })
}

// Wait for async operations (fetch, effects) to flush
const tick = () => new Promise<void>((r) => setTimeout(r, 50))

// ── Tests ──────────────────────────────────────────────────────────────

describe("initial state", () => {
  test("loaded flips true after initial boot fetch settles", async () => {
    const { api, dispose } = createTestProcessPane()
    try {
      expect(api.loaded()).toBe(false)
      await tick()
      expect(api.loaded()).toBe(true)
    } finally {
      dispose()
    }
  })

  test("configs returns empty array when server has no configs", async () => {
    const { api, dispose } = createTestProcessPane()
    try {
      await tick()
      expect(api.configs()).toEqual([])
    } finally {
      dispose()
    }
  })

  test("configs populates from server GET /process/ on mount", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()
      expect(api.configs()).toHaveLength(1)
      expect(api.configs()[0].name).toBe("Dev Server")
    } finally {
      dispose()
    }
  })

  test("processForConfig returns managed process after fetch", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()
      const proc = api.processForConfig("proc_abc123")
      expect(proc).toBeDefined()
      expect(proc!.status).toBe("running")
      expect(proc!.ptyId).toBe("pty_1")
    } finally {
      dispose()
    }
  })

  test("processForConfig returns undefined for unknown configId", async () => {
    const { api, dispose } = createTestProcessPane()
    try {
      await tick()
      expect(api.processForConfig("nonexistent")).toBeUndefined()
    } finally {
      dispose()
    }
  })
})

describe("pane visibility", () => {
  test("isOpen starts closed (not persisted)", () => {
    const { api, dispose } = createTestProcessPane()
    try {
      expect(api.isOpen()).toBe(false)
    } finally {
      dispose()
    }
  })

  test("toggle flips the pane open/closed state", () => {
    const { api, dispose } = createTestProcessPane()
    try {
      expect(api.isOpen()).toBe(false)
      api.toggle()
      expect(api.isOpen()).toBe(true)
      api.toggle()
      expect(api.isOpen()).toBe(false)
    } finally {
      dispose()
    }
  })
})

describe("pane sizing", () => {
  test("paneHeight returns at least minimum height", () => {
    const { api, dispose } = createTestProcessPane()
    try {
      api.setPaneHeight(50) // below minimum
      expect(api.paneHeight()).toBeGreaterThanOrEqual(100)
    } finally {
      dispose()
    }
  })

  test("setPaneHeight persists the value", () => {
    const { api, dispose } = createTestProcessPane()
    try {
      api.setPaneHeight(400)
      expect(api.paneHeight()).toBe(400)
    } finally {
      dispose()
    }
  })

})

describe("SSE event processing", () => {
  test("process.started event creates process entry with ptyId", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [],
      }),
    })
    try {
      await tick()

      emitSSE("process.started", { configId: "proc_abc123", ptyId: "pty_99" })

      const proc = api.processForConfig("proc_abc123")
      expect(proc).toBeDefined()
      expect(proc!.ptyId).toBe("pty_99")
      expect(proc!.status).toBe("running")
      expect(proc!.startedAt).toBeDefined()
    } finally {
      dispose()
    }
  })

  test("process.stopped event sets status to stopped with exitCode", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()

      emitSSE("process.stopped", { configId: "proc_abc123", exitCode: 0 })

      const proc = api.processForConfig("proc_abc123")
      expect(proc).toBeDefined()
      expect(proc!.status).toBe("stopped")
      expect(proc!.exitCode).toBe(0)
      expect(proc!.exitedAt).toBeDefined()
    } finally {
      dispose()
    }
  })

  test("process.crashed event sets status to crashed with restartCount", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()

      emitSSE("process.crashed", { configId: "proc_abc123", exitCode: 1, restartCount: 2 })

      const proc = api.processForConfig("proc_abc123")
      expect(proc).toBeDefined()
      expect(proc!.status).toBe("crashed")
      expect(proc!.exitCode).toBe(1)
      expect(proc!.restartCount).toBe(2)
    } finally {
      dispose()
    }
  })

  test("process.status event updates existing process status", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()

      emitSSE("process.status", { configId: "proc_abc123", status: "stopping" })

      const proc = api.processForConfig("proc_abc123")
      expect(proc).toBeDefined()
      expect(proc!.status).toBe("stopping")
    } finally {
      dispose()
    }
  })

  test("process.status event creates minimal entry for unknown configId", async () => {
    const { api, dispose } = createTestProcessPane()
    try {
      await tick()

      emitSSE("process.status", { configId: "proc_new", status: "starting" })

      const proc = api.processForConfig("proc_new")
      expect(proc).toBeDefined()
      expect(proc!.status).toBe("starting")
      expect(proc!.restartCount).toBe(0)
    } finally {
      dispose()
    }
  })

  test("process.config.changed event replaces configs array", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [],
      }),
    })
    try {
      await tick()
      expect(api.configs()).toHaveLength(1)

      emitSSE("process.config.changed", {
        configs: [SAMPLE_CONFIG, SAMPLE_CONFIG_2],
      })

      expect(api.configs()).toHaveLength(2)
      expect(api.configs()[1].name).toBe("Database")
    } finally {
      dispose()
    }
  })

  test("process.config.changed drops process entries for removed configs", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG, SAMPLE_CONFIG_2],
        processes: [
          { configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 },
          { configId: "proc_def456", ptyId: "pty_2", status: "running", restartCount: 0 },
        ],
      }),
    })
    try {
      await tick()
      expect(api.processForConfig("proc_def456")).toBeDefined()

      // Remove the second config
      emitSSE("process.config.changed", { configs: [SAMPLE_CONFIG] })

      expect(api.processForConfig("proc_abc123")).toBeDefined()
      expect(api.processForConfig("proc_def456")).toBeUndefined()
    } finally {
      dispose()
    }
  })
})

describe("derived state", () => {
  test("hasRunning returns false when no processes exist", async () => {
    const { api, dispose } = createTestProcessPane()
    try {
      await tick()
      expect(api.hasRunning()).toBe(false)
    } finally {
      dispose()
    }
  })

  test("hasRunning returns true when a process is running", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()
      expect(api.hasRunning()).toBe(true)
    } finally {
      dispose()
    }
  })

  test("hasRunning returns true for starting or restarting processes", async () => {
    const { api, dispose } = createTestProcessPane()
    try {
      await tick()

      emitSSE("process.status", { configId: "proc_x", status: "starting" })
      expect(api.hasRunning()).toBe(true)
    } finally {
      dispose()
    }
  })

  test("hasCrashed returns true when a process has crashed", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", status: "crashed", restartCount: 3, exitCode: 1 }],
      }),
    })
    try {
      await tick()
      expect(api.hasCrashed()).toBe(true)
    } finally {
      dispose()
    }
  })

  test("hasStopping returns true when a process is stopping", async () => {
    const { api, dispose } = createTestProcessPane()
    try {
      await tick()

      emitSSE("process.status", { configId: "proc_x", status: "stopping" })
      expect(api.hasStopping()).toBe(true)
    } finally {
      dispose()
    }
  })

  test("hasStopping returns false when no processes are stopping", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()
      expect(api.hasStopping()).toBe(false)
    } finally {
      dispose()
    }
  })

  test("hasCrashed returns false when all processes are healthy", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()
      expect(api.hasCrashed()).toBe(false)
    } finally {
      dispose()
    }
  })
})

describe("lifecycle actions", () => {
  test("start posts to /process/{configId}/start", async () => {
    const { api, dispose } = createTestProcessPane()
    try {
      await tick()
      await api.start("proc_abc123")

      const startCall = fetchState.calls.find((c) => c.url.includes("/start"))
      expect(startCall).toBeDefined()
      expect(startCall!.method).toBe("POST")
      expect(startCall!.url).toContain("/process/proc_abc123/start")
    } finally {
      dispose()
    }
  })

  test("stop posts to /process/{configId}/stop", async () => {
    const { api, dispose } = createTestProcessPane()
    try {
      await tick()
      await api.stop("proc_abc123")

      const stopCall = fetchState.calls.find((c) => c.url.includes("/stop"))
      expect(stopCall).toBeDefined()
      expect(stopCall!.method).toBe("POST")
      expect(stopCall!.url).toContain("/process/proc_abc123/stop")
    } finally {
      dispose()
    }
  })

  test("restart posts to /process/{configId}/restart when running", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()
      fetchState.calls = []
      await api.restart("proc_abc123")

      const call = fetchState.calls.find((c) => c.url.includes("/restart"))
      expect(call).toBeDefined()
      expect(call!.method).toBe("POST")
      expect(call!.url).toContain("/process/proc_abc123/restart")
    } finally {
      dispose()
    }
  })

  test("startAll posts individual /process/{id}/start for each config", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG, SAMPLE_CONFIG_2],
        processes: [],
      }),
    })
    try {
      await tick()
      fetchState.calls = [] // clear initial fetch calls
      await api.startAll()

      const startCalls = fetchState.calls.filter((c) => c.url.includes("/start"))
      expect(startCalls).toHaveLength(2)
      expect(startCalls[0].method).toBe("POST")
      expect(startCalls[0].url).toContain("/process/proc_abc123/start")
      expect(startCalls[1].url).toContain("/process/proc_def456/start")
    } finally {
      dispose()
    }
  })

  test("stopAll posts individual /stop for each running process", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG, SAMPLE_CONFIG_2],
        processes: [
          { configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 },
          { configId: "proc_def456", ptyId: "pty_2", status: "running", restartCount: 0 },
        ],
      }),
    })
    try {
      await tick()
      fetchState.calls = []
      await api.stopAll()

      const stopCalls = fetchState.calls.filter((c) => c.url.includes("/stop"))
      expect(stopCalls).toHaveLength(2)
      expect(stopCalls[0].method).toBe("POST")
      expect(stopCalls[0].url).toContain("/process/proc_abc123/stop")
      expect(stopCalls[1].url).toContain("/process/proc_def456/stop")
    } finally {
      dispose()
    }
  })
})

describe("tab integration", () => {
  test("openInTab creates terminal tab when process has ptyId", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_42", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()

      api.openInTab("proc_abc123")

      expect(mockLayout._addedTerminals).toHaveLength(1)
      expect(mockLayout._addedTerminals[0].ptyId).toBe("pty_42")
      expect(mockLayout._addedTerminals[0].title).toBe("Dev Server")
    } finally {
      dispose()
    }
  })

  test("openInTab starts process and opens tab on process.started event when no ptyId", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [],
      }),
    })
    try {
      await tick()

      // No process running — openInTab should start and defer tab creation
      api.openInTab("proc_abc123")

      // A start POST was sent
      const startCall = fetchState.calls.find((c) => c.url.includes("/start"))
      expect(startCall).toBeDefined()

      // Wait for the async openInTab chain to resolve (postAction → applyProcess
      // → pendingTabOpens.add) before emitting SSE
      await tick()

      // No tab yet (waiting for process.started)
      expect(mockLayout._addedTerminals).toHaveLength(0)

      // Simulate server responding with process.started
      emitSSE("process.started", { configId: "proc_abc123", ptyId: "pty_new" })

      // Now the tab should be created
      expect(mockLayout._addedTerminals).toHaveLength(1)
      expect(mockLayout._addedTerminals[0].ptyId).toBe("pty_new")
    } finally {
      dispose()
    }
  })
})

describe("refresh", () => {
  test("refresh fetches fresh data from server", async () => {
    let callCount = 0
    const { api, dispose } = createTestProcessPane({
      "GET": () => {
        callCount++
        if (callCount === 1) return { configs: [], processes: [] }
        return {
          configs: [SAMPLE_CONFIG],
          processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
        }
      },
    })
    try {
      await tick()
      expect(api.configs()).toHaveLength(0)

      await api.refresh()
      await tick()

      expect(api.configs()).toHaveLength(1)
      expect(api.configs()[0].name).toBe("Dev Server")
    } finally {
      dispose()
    }
  })
})

// pane width sync tests removed — multi-pane system handles layout now

describe("state machine transitions", () => {
  test("stop clears ptyId immediately and transitions to stopped", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()
      expect(api.processForConfig("proc_abc123")!.ptyId).toBe("pty_1")

      await api.stop("proc_abc123")

      const proc = api.processForConfig("proc_abc123")!
      expect(proc.ptyId).toBeUndefined()
      expect(proc.status).toBe("stopped")
    } finally {
      dispose()
    }
  })

  test("stopAll clears all ptyIds immediately", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG, SAMPLE_CONFIG_2],
        processes: [
          { configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 },
          { configId: "proc_def456", ptyId: "pty_2", status: "running", restartCount: 0 },
        ],
      }),
    })
    try {
      await tick()
      expect(api.processForConfig("proc_abc123")!.ptyId).toBe("pty_1")
      expect(api.processForConfig("proc_def456")!.ptyId).toBe("pty_2")

      await api.stopAll()

      expect(api.processForConfig("proc_abc123")!.ptyId).toBeUndefined()
      expect(api.processForConfig("proc_def456")!.ptyId).toBeUndefined()
      expect(api.hasStopping()).toBe(false)
    } finally {
      dispose()
    }
  })

  test("process.crashed SSE preserves ptyId so terminal stays visible", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()

      emitSSE("process.crashed", { configId: "proc_abc123", exitCode: 1, restartCount: 1 })

      const proc = api.processForConfig("proc_abc123")!
      expect(proc.status).toBe("crashed")
      // ptyId preserved — even if the PTY is dead, the Terminal component
      // shows a "Connection lost" message which is better than nothing.
      expect(proc.ptyId).toBe("pty_1")
    } finally {
      dispose()
    }
  })

  test("process.stopped SSE clears ptyId", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()

      emitSSE("process.stopped", { configId: "proc_abc123", exitCode: 0 })

      const proc = api.processForConfig("proc_abc123")!
      expect(proc.status).toBe("stopped")
      expect(proc.ptyId).toBeUndefined()
    } finally {
      dispose()
    }
  })

  test("pty.exited does not affect process ptyId", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()

      emitSSE("pty.exited", { id: "pty_1" })

      const proc = api.processForConfig("proc_abc123")!
      expect(proc.ptyId).toBe("pty_1")
    } finally {
      dispose()
    }
  })

  test("restart when dormant calls /start not /restart", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", status: "idle", restartCount: 0 }],
      }),
    })
    try {
      await tick()
      fetchState.calls = []

      await api.restart("proc_abc123")

      const startCall = fetchState.calls.find((c) => c.url.includes("/start"))
      const restartCall = fetchState.calls.find((c) => c.url.includes("/restart"))
      expect(startCall).toBeDefined()
      expect(restartCall).toBeUndefined()
    } finally {
      dispose()
    }
  })

  test("restart when running gets new ptyId from response", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_old", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()
      // Mock restart response with new ptyId
      fetchState.responses["/restart"] = () => ({
        configId: "proc_abc123",
        ptyId: "pty_new",
        status: "running",
        restartCount: 0,
      })

      await api.restart("proc_abc123")

      const proc = api.processForConfig("proc_abc123")!
      expect(proc.ptyId).toBe("pty_new")
    } finally {
      dispose()
    }
  })

  test("hasRunning is false after stopAll", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG, SAMPLE_CONFIG_2],
        processes: [
          { configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 },
          { configId: "proc_def456", ptyId: "pty_2", status: "running", restartCount: 0 },
        ],
      }),
    })
    try {
      await tick()
      expect(api.hasRunning()).toBe(true)

      await api.stopAll()

      expect(api.hasRunning()).toBe(false)
      expect(api.hasStopping()).toBe(false)
    } finally {
      dispose()
    }
  })
})

describe("fetchProcesses registers PTY ownership", () => {
  // fetchProcesses() owns each running process's PTY so the terminal
  // detection effect skips them and doesn't create competing tabs.

  test("fetchProcesses registers ownership for all process PTYs", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG, SAMPLE_CONFIG_2],
        processes: [
          { configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 },
          { configId: "proc_def456", ptyId: "pty_2", status: "running", restartCount: 0 },
        ],
      }),
    })
    try {
      await tick()

      // Both PTYs should be owned by their respective process
      expect(mockLayout._ownedPtys.get("pty_1")).toBe("process:proc_abc123")
      expect(mockLayout._ownedPtys.get("pty_2")).toBe("process:proc_def456")
    } finally {
      dispose()
    }
  })

  test("fetchProcesses does not own PTYs for stopped processes without ptyId", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", status: "stopped", restartCount: 0 }],
      }),
    })
    try {
      await tick()

      expect(mockLayout._ownedPtys.size).toBe(0)
    } finally {
      dispose()
    }
  })

  test("refresh re-owns PTYs from server response", async () => {
    let callCount = 0
    const { api, dispose } = createTestProcessPane({
      "GET": () => {
        callCount++
        if (callCount === 1) return { configs: [SAMPLE_CONFIG], processes: [] }
        return {
          configs: [SAMPLE_CONFIG],
          processes: [{ configId: "proc_abc123", ptyId: "pty_99", status: "running", restartCount: 0 }],
        }
      },
    })
    try {
      await tick()
      expect(mockLayout._ownedPtys.size).toBe(0)

      await api.refresh()
      await tick()

      expect(mockLayout._ownedPtys.get("pty_99")).toBe("process:proc_abc123")
    } finally {
      dispose()
    }
  })
})

describe("start lifecycle defers terminal detection", () => {
  // start/restart/startAll/openInTab signal pendingProcessStarts so the
  // terminal detection effect skips unowned PTYs during the POST window.

  test("start() defers terminal detection during POST", async () => {
    let pendingDuringPost = -1
    const { api, dispose } = createTestProcessPane()
    try {
      await tick()
      // Set custom handler AFTER createTestProcessPane (which replaces responses)
      fetchState.responses["/start"] = () => {
        pendingDuringPost = mockLayout.terminal.pendingProcessStarts()
        return { configId: "proc_abc123", ptyId: "pty_new", status: "running", restartCount: 0 }
      }
      expect(mockLayout.terminal.pendingProcessStarts()).toBe(0)

      await api.start("proc_abc123")

      expect(pendingDuringPost).toBe(1)
      // After start resolves, counter is back to 0
      expect(mockLayout.terminal.pendingProcessStarts()).toBe(0)
    } finally {
      dispose()
    }
  })

  test("start() re-enables terminal detection after POST failure", async () => {
    const { api, dispose } = createTestProcessPane()
    try {
      await tick()
      fetchState.responses["/start"] = () => {
        throw new Error("network failure")
      }

      await api.start("proc_abc123")

      // Counter must be 0 even after failure (finally block)
      expect(mockLayout.terminal.pendingProcessStarts()).toBe(0)
    } finally {
      dispose()
    }
  })

  test("restart() defers terminal detection during POST", async () => {
    let pendingDuringPost = -1
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", status: "stopped", restartCount: 0 }],
      }),
    })
    try {
      await tick()
      fetchState.responses["/start"] = () => {
        pendingDuringPost = mockLayout.terminal.pendingProcessStarts()
        return { configId: "proc_abc123", ptyId: "pty_new", status: "running", restartCount: 0 }
      }

      await api.restart("proc_abc123")

      expect(pendingDuringPost).toBe(1)
      expect(mockLayout.terminal.pendingProcessStarts()).toBe(0)
    } finally {
      dispose()
    }
  })

  test("restart() of running process defers terminal detection during POST", async () => {
    let pendingDuringPost = -1
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_old", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()
      fetchState.responses["/restart"] = () => {
        pendingDuringPost = mockLayout.terminal.pendingProcessStarts()
        return { configId: "proc_abc123", ptyId: "pty_new", status: "running", restartCount: 0 }
      }

      await api.restart("proc_abc123")

      expect(pendingDuringPost).toBe(1)
      expect(mockLayout.terminal.pendingProcessStarts()).toBe(0)
    } finally {
      dispose()
    }
  })

  test("startAll() defers terminal detection across all POSTs", async () => {
    let maxPendingDuringPosts = 0
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG, SAMPLE_CONFIG_2],
        processes: [],
      }),
    })
    try {
      await tick()
      fetchState.responses["/start"] = () => {
        const current = mockLayout.terminal.pendingProcessStarts()
        if (current > maxPendingDuringPosts) maxPendingDuringPosts = current
        return { configId: "any", status: "running", restartCount: 0 }
      }

      await api.startAll()

      // The counter was 1 during all POSTs (single bracket around the loop)
      expect(maxPendingDuringPosts).toBe(1)
      expect(mockLayout.terminal.pendingProcessStarts()).toBe(0)
    } finally {
      dispose()
    }
  })

  test("openInTab() defers terminal detection when starting", async () => {
    let pendingDuringPost = -1
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [],
      }),
    })
    try {
      await tick()
      fetchState.responses["/start"] = () => {
        pendingDuringPost = mockLayout.terminal.pendingProcessStarts()
        return { configId: "proc_abc123", ptyId: "pty_new", status: "running", restartCount: 0 }
      }

      api.openInTab("proc_abc123")
      await tick()

      expect(pendingDuringPost).toBe(1)
      expect(mockLayout.terminal.pendingProcessStarts()).toBe(0)
    } finally {
      dispose()
    }
  })
})

describe("start auto-opens pane", () => {
  test("start() opens pane when process returns ptyId", async () => {
    const { api, dispose } = createTestProcessPane()
    try {
      await tick()
      fetchState.responses["/start"] = () => ({
        configId: "proc_abc123",
        ptyId: "pty_new",
        status: "running",
        restartCount: 0,
      })
      expect(api.isOpen()).toBe(false)

      await api.start("proc_abc123")

      expect(api.isOpen()).toBe(true)
    } finally {
      dispose()
    }
  })

  test("start() keeps pane closed when POST returns no ptyId", async () => {
    const { api, dispose } = createTestProcessPane()
    try {
      await tick()
      expect(api.isOpen()).toBe(false)

      await api.start("proc_abc123")

      // No ptyId in response → pane stays closed
      expect(api.isOpen()).toBe(false)
    } finally {
      dispose()
    }
  })
})

describe("process.started SSE registers ownership", () => {
  test("process.started SSE owns the PTY", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [],
      }),
    })
    try {
      await tick()

      emitSSE("process.started", { configId: "proc_abc123", ptyId: "pty_99" })

      expect(mockLayout._ownedPtys.get("pty_99")).toBe("process:proc_abc123")
    } finally {
      dispose()
    }
  })

  test("process.started SSE without ptyId does not crash", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [],
      }),
    })
    try {
      await tick()

      // Should not throw
      emitSSE("process.started", { configId: "proc_abc123" })

      const proc = api.processForConfig("proc_abc123")
      expect(proc).toBeDefined()
      expect(proc!.status).toBe("running")
    } finally {
      dispose()
    }
  })
})

describe("stop clears ptyId before POST resolves", () => {
  test("stop() clears ptyId before awaiting the POST", async () => {
    let ptyIdDuringPost: string | undefined = "not-checked"
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()
      fetchState.responses["/stop"] = () => {
        ptyIdDuringPost = api.processForConfig("proc_abc123")?.ptyId
        return true
      }

      await api.stop("proc_abc123")

      // ptyId was already cleared before the POST resolved
      expect(ptyIdDuringPost).toBeUndefined()
    } finally {
      dispose()
    }
  })

  test("stopAll() clears all ptyIds before awaiting POSTs", async () => {
    const ptyIdsDuringPost: Record<string, string | undefined> = {}
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG, SAMPLE_CONFIG_2],
        processes: [
          { configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 },
          { configId: "proc_def456", ptyId: "pty_2", status: "running", restartCount: 0 },
        ],
      }),
    })
    try {
      await tick()
      fetchState.responses["/stop"] = () => {
        ptyIdsDuringPost["proc_abc123"] = api.processForConfig("proc_abc123")?.ptyId
        ptyIdsDuringPost["proc_def456"] = api.processForConfig("proc_def456")?.ptyId
        return true
      }

      await api.stopAll()

      expect(ptyIdsDuringPost["proc_abc123"]).toBeUndefined()
      expect(ptyIdsDuringPost["proc_def456"]).toBeUndefined()
    } finally {
      dispose()
    }
  })
})

// ── Cross-workspace isolation (regression: keyed Show remount) ──────
//
// When the user switches workspaces, the ProcessPaneProvider must be
// destroyed and re-created (via <Show keyed> in rail-layout.tsx).
// Without keyed, the provider stays mounted and stale configs from
// workspace A leak into workspace B.
//
// These tests verify the observable consequence: each fresh mount
// fetches with the correct directory header and starts with clean state.

describe("cross-workspace isolation", () => {
  const DIR_A = "/workspace/projectA"
  const DIR_B = "/workspace/projectB"

  const THIRD_CONFIG = {
    id: "proc_third",
    name: "Worker",
    command: "node worker.js",
    args: [] as string[],
    autoStart: false,
    restartPolicy: "never" as const,
    maxRestarts: 3,
  }

  test("separate provider mounts for different directories get independent configs", async () => {
    // Mount provider for directory A — server returns 3 configs
    currentDirectory = DIR_A
    fetchState.responses = {
      "GET": () => ({
        configs: [SAMPLE_CONFIG, SAMPLE_CONFIG_2, THIRD_CONFIG],
        processes: [],
      }),
    }

    const { api: apiA, dispose: disposeA } = createTestProcessPane()
    await tick()
    expect(apiA.configs()).toHaveLength(3)
    disposeA()

    // Mount provider for directory B — server returns 0 configs
    currentDirectory = DIR_B
    fetchState.calls = []
    fetchState.responses = {
      "GET": () => ({ configs: [], processes: [] }),
    }

    const { api: apiB, dispose: disposeB } = createTestProcessPane()
    await tick()

    // B must NOT inherit A's 3 configs — that was the regression
    expect(apiB.configs()).toHaveLength(0)
    disposeB()
  })

  test("fetch sends correct x-opencode-directory header per mount", async () => {
    // Mount for directory A
    currentDirectory = DIR_A
    const { dispose: d1 } = createTestProcessPane()
    await tick()

    const callA = fetchState.calls.find((c) => c.url.includes("/process"))
    expect(callA).toBeDefined()
    expect(callA!.headers?.["x-opencode-directory"]).toBe(DIR_A)
    d1()

    // Mount for directory B
    fetchState.calls = []
    currentDirectory = DIR_B
    const { dispose: d2 } = createTestProcessPane()
    await tick()

    const callB = fetchState.calls.find((c) => c.url.includes("/process"))
    expect(callB).toBeDefined()
    expect(callB!.headers?.["x-opencode-directory"]).toBe(DIR_B)
    d2()
  })

  test("SSE events for old directory do not affect new provider mount", async () => {
    // Mount for directory A with configs
    currentDirectory = DIR_A
    fetchState.responses = {
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
      }),
    }

    const { api: apiA, dispose: disposeA } = createTestProcessPane()
    await tick()
    expect(apiA.configs()).toHaveLength(1)
    disposeA()

    // Mount for directory B (empty)
    currentDirectory = DIR_B
    fetchState.responses = {
      "GET": () => ({ configs: [], processes: [] }),
    }

    const { api: apiB, dispose: disposeB } = createTestProcessPane()
    await tick()
    expect(apiB.configs()).toHaveLength(0)

    // Emit an SSE event targeted at directory A — must not affect B's provider
    emitSSE("process.config.changed", {
      configs: [SAMPLE_CONFIG, SAMPLE_CONFIG_2],
    }, DIR_A)

    expect(apiB.configs()).toHaveLength(0)
    disposeB()
  })

  test("SSE events for current directory do reach the provider", async () => {
    currentDirectory = DIR_B
    fetchState.responses = {
      "GET": () => ({ configs: [], processes: [] }),
    }

    const { api, dispose } = createTestProcessPane()
    await tick()
    expect(api.configs()).toHaveLength(0)

    // Emit on B's directory — should be received
    emitSSE("process.config.changed", { configs: [SAMPLE_CONFIG] }, DIR_B)

    expect(api.configs()).toHaveLength(1)
    expect(api.configs()[0].name).toBe("Dev Server")
    dispose()
  })
})

// ── Stale persisted state ──────────────────────────────────────────────

describe("stale persisted state cleared on mount", () => {
  test("stale 'stopping' cleared on mount when fetch returns idle", async () => {
    // The store starts with processes={} on mount (reset line), then fetch
    // populates with fresh server state. Simulate: server says idle.
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", status: "idle", restartCount: 0 }],
      }),
    })
    try {
      await tick()
      expect(api.hasStopping()).toBe(false)
      const proc = api.processForConfig("proc_abc123")
      expect(proc).toBeDefined()
      expect(proc!.status).toBe("idle")
    } finally {
      dispose()
    }
  })

  test("stale state cleared even when fetch fails — processes empty", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({ __fail: true }),
    })
    try {
      // The store is reset to {} synchronously on mount, BEFORE the
      // async retry loop starts. So after a single tick the store is
      // empty regardless of whether the fetch eventually succeeds.
      await tick()
      expect(api.hasStopping()).toBe(false)
      expect(api.hasRunning()).toBe(false)
      expect(api.processForConfig("proc_abc123")).toBeUndefined()
    } finally {
      dispose()
    }
  })

  test("layout (paneHeight) preserved — only processes cleared", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [],
      }),
    })
    try {
      await tick()
      // Set custom layout values
      api.setPaneHeight(500)

      // Values should survive — only processes are cleared on mount
      expect(api.paneHeight()).toBe(500)
    } finally {
      dispose()
    }
  })
})

// ── Fetch retry on mount ───────────────────────────────────────────────

describe("fetch retry on mount", () => {
  test("first fetch fails, second succeeds — processes populated", async () => {
    const handler = createFailThenSuccessFetch(1, {
      configs: [SAMPLE_CONFIG],
      processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
    })
    const { api, dispose } = createTestProcessPane({
      "GET": handler,
    })
    try {
      // First attempt fails immediately, second fires after ~1s backoff
      await new Promise((r) => setTimeout(r, 2000))
      expect(api.configs()).toHaveLength(1)
      expect(api.processForConfig("proc_abc123")).toBeDefined()
      expect(api.processForConfig("proc_abc123")!.status).toBe("running")
    } finally {
      dispose()
    }
  })

  test("all retries fail — processes stay empty, no crash", async () => {
    // Use a persistent __fail handler. We only need to verify that after
    // the first two retries (1s + 2s = 3s), processes are still empty.
    // We don't need to wait for the third retry (4s more) to validate.
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({ __fail: true }),
    })
    try {
      await new Promise((r) => setTimeout(r, 3500))
      expect(api.configs()).toEqual([])
      expect(api.hasRunning()).toBe(false)
    } finally {
      dispose()
    }
  })
})

// ── Wake re-sync ───────────────────────────────────────────────────────

describe("wake re-sync via visibilitychange", () => {
  test("visibilitychange 'visible' triggers fetchProcesses", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({ configs: [], processes: [] }),
    })
    try {
      await tick()
      // Record GET calls after initial mount fetch completes
      const callsBefore = fetchState.calls.filter((c) => c.url.includes("/process")).length

      simulateWake()
      await tick()

      const callsAfter = fetchState.calls.filter((c) => c.url.includes("/process")).length
      // At least one new GET /process call from the wake
      expect(callsAfter).toBeGreaterThan(callsBefore)
    } finally {
      dispose()
    }
  })

  test("visibilitychange 'hidden' does NOT trigger fetchProcesses", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({ configs: [], processes: [] }),
    })
    try {
      await tick()
      const callsBefore = fetchState.calls.filter((c) => c.url.includes("/process")).length

      simulateHide()
      await tick()

      const callsAfter = fetchState.calls.filter((c) => c.url.includes("/process")).length
      expect(callsAfter).toBe(callsBefore)
    } finally {
      dispose()
    }
  })

  test("wake fetch updates stale frontend state", async () => {
    let fetchCount = 0
    const { api, dispose } = createTestProcessPane({
      "GET": () => {
        fetchCount++
        if (fetchCount <= 1) {
          return {
            configs: [SAMPLE_CONFIG],
            processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
          }
        }
        // After wake: server says process crashed
        return {
          configs: [SAMPLE_CONFIG],
          processes: [{ configId: "proc_abc123", status: "crashed", restartCount: 2, exitCode: 1 }],
        }
      },
    })
    try {
      await tick()
      expect(api.processForConfig("proc_abc123")!.status).toBe("running")

      simulateWake()
      await tick()

      const proc = api.processForConfig("proc_abc123")!
      expect(proc.status).toBe("crashed")
      expect(proc.exitCode).toBe(1)
    } finally {
      dispose()
    }
  })
})

// ── Time-jump detection ────────────────────────────────────────────────

describe("time-jump sleep detection", () => {
  test("normal interval tick does NOT trigger extra fetchProcesses", async () => {
    const DIR = "/test/time-jump-no-fetch"
    currentDirectory = DIR
    // The interval fires every 10s. With real timers, the gap is always
    // ~10s which is below the 30s threshold. Verify no extra fetches
    // happen from the timer. (Testing the >30s gap path requires mocking
    // Date.now or setInterval, which is fragile in integration tests.)
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({ configs: [], processes: [] }),
    })
    try {
      await tick()
      const callsBefore = fetchState.calls.filter((c) =>
        c.url.includes("/process") && c.headers?.["x-opencode-directory"] === DIR,
      ).length

      // Wait 1s — well within the 10s interval, no timer fires
      await new Promise((r) => setTimeout(r, 1000))

      const callsAfter = fetchState.calls.filter((c) =>
        c.url.includes("/process") && c.headers?.["x-opencode-directory"] === DIR,
      ).length
      expect(callsAfter).toBe(callsBefore)
    } finally {
      dispose()
    }
  })

  test("cleanup removes interval and visibilitychange listener", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({ configs: [], processes: [] }),
    })
    await tick()
    const callsBefore = fetchState.calls.filter((c) => c.url.includes("/process")).length

    // Dispose the root — should clean up interval and listener
    dispose()

    // Trigger visibilitychange — should NOT cause a fetch
    simulateWake()
    await tick()

    const callsAfter = fetchState.calls.filter((c) => c.url.includes("/process")).length
    expect(callsAfter).toBe(callsBefore)
  })
})

// ── Stuck "stopping" dead-lock regressions ───────────────────────────
//
// These tests guard previously fixed failures where "stopping" became a
// terminal dead-lock state: action buttons disappeared, Start All stayed
// disabled, and recovery required a page reload.

describe("regression: stopAll recovers processes stuck in stopping", () => {
  test("stopAll should force stopping processes to stopped", async () => {
    // Scenario: SSE delivered process.status "stopping" but process.stopped
    // was missed (SSE dropped during the stop). Process stuck in "stopping".
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()

      // Simulate stuck state: SSE sets "stopping", no "stopped" follows
      emitSSE("process.status", { configId: "proc_abc123", status: "stopping" })
      expect(api.processForConfig("proc_abc123")!.status).toBe("stopping")
      expect(api.hasStopping()).toBe(true)

      // User's only recourse: click "Stop All"
      await api.stopAll()

      // stopAll force-recovers stuck entries before issuing network stops.
      expect(api.processForConfig("proc_abc123")!.status).toBe("stopped")
      expect(api.hasStopping()).toBe(false)
    } finally {
      dispose()
    }
  })

  test("stopAll should recover mix of running + stuck-stopping processes", async () => {
    // One process stuck in "stopping", another still running.
    // stopAll should handle both.
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG, SAMPLE_CONFIG_2],
        processes: [
          { configId: "proc_abc123", status: "stopping", restartCount: 0 },
          { configId: "proc_def456", ptyId: "pty_2", status: "running", restartCount: 0 },
        ],
      }),
    })
    try {
      await tick()
      expect(api.hasStopping()).toBe(true)
      expect(api.hasRunning()).toBe(true)

      await api.stopAll()

      // Both processes should now be stopped
      expect(api.processForConfig("proc_abc123")!.status).toBe("stopped")
      expect(api.processForConfig("proc_def456")!.status).toBe("stopped")
      expect(api.hasStopping()).toBe(false)
    } finally {
      dispose()
    }
  })

  test("stopAll should clear hasStopping after recovering stuck process", async () => {
    // hasStopping() gates the Start All button. If stopAll can't clear it,
    // Start All is permanently disabled.
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [],
      }),
    })
    try {
      await tick()

      // Put process in "stopping" via SSE (no prior "running" — simulates
      // state from a stale localStorage or a reconnection gap)
      emitSSE("process.status", { configId: "proc_abc123", status: "stopping" })
      expect(api.hasStopping()).toBe(true)

      await api.stopAll()

      expect(api.hasStopping()).toBe(false)
      // Process should be in a startable state
      const status = api.processForConfig("proc_abc123")!.status
      expect(["idle", "stopped", "crashed"]).toContain(status)
    } finally {
      dispose()
    }
  })
})

describe("regression: late SSE stopping cannot revert confirmed stop", () => {
  test("late SSE stopping after stop() should not revert to stopping", async () => {
    // Scenario: User stops process. Belt-and-suspenders confirms "stopped".
    // A stale SSE process.status "stopping" arrives (was in-flight before
    // the HTTP response, or from a stale SSE reconnection). The SSE handler
    // at line 230-244 blindly sets status — no guard for recently-stopped.
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()

      // stop() → optimistic "stopping" → POST → belt-and-suspenders → "stopped"
      await api.stop("proc_abc123")
      expect(api.processForConfig("proc_abc123")!.status).toBe("stopped")

      // Late/stale SSE event arrives
      emitSSE("process.status", { configId: "proc_abc123", status: "stopping" })

      // Process should stay "stopped" — the stop was already confirmed
      expect(api.processForConfig("proc_abc123")!.status).toBe("stopped")
      expect(api.hasStopping()).toBe(false)
    } finally {
      dispose()
    }
  })

  test("late SSE stopping after stopAll should not revert any process", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG, SAMPLE_CONFIG_2],
        processes: [
          { configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 },
          { configId: "proc_def456", ptyId: "pty_2", status: "running", restartCount: 0 },
        ],
      }),
    })
    try {
      await tick()

      await api.stopAll()
      expect(api.processForConfig("proc_abc123")!.status).toBe("stopped")
      expect(api.processForConfig("proc_def456")!.status).toBe("stopped")

      // Late SSE events for both processes
      emitSSE("process.status", { configId: "proc_abc123", status: "stopping" })
      emitSSE("process.status", { configId: "proc_def456", status: "stopping" })

      // Neither should revert
      expect(api.processForConfig("proc_abc123")!.status).toBe("stopped")
      expect(api.processForConfig("proc_def456")!.status).toBe("stopped")
      expect(api.hasStopping()).toBe(false)
    } finally {
      dispose()
    }
  })
})

describe("regression: hanging stop request still recoverable via stopAll", () => {
  test("stop with hanging server leaves process in stopping, stopAll cannot rescue", async () => {
    // Scenario: User clicks Stop, server accepts connection but never
    // responds (gateway up, sandbox hung). postAction hangs forever,
    // belt-and-suspenders never runs. Process stuck in "stopping".
    // User tries "Stop All" to recover — but stopAll ignores "stopping".
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()

      // Make stop endpoint hang indefinitely (server accepts, never responds)
      fetchState.responses["/stop"] = () => ({ __hang: true })

      // Fire stop — don't await (it would hang forever)
      void api.stop("proc_abc123")
      await tick()

      // Optimistic update fired: status = "stopping", ptyId = undefined
      expect(api.processForConfig("proc_abc123")!.status).toBe("stopping")
      expect(api.processForConfig("proc_abc123")!.ptyId).toBeUndefined()

      // Belt-and-suspenders is still blocked (postAction in-flight).
      // User clicks "Stop All" as last resort.
      // Clear the hanging handler so stopAll's own POSTs don't hang too.
      fetchState.responses = {
        "GET": () => ({ configs: [SAMPLE_CONFIG], processes: [] }),
      }
      await api.stopAll()

      // stopAll force-recovers the stuck local state even while the original
      // stop request is still hung.
      expect(api.processForConfig("proc_abc123")!.status).toBe("stopped")
    } finally {
      dispose()
    }
  })
})

// ── Crashed-while-closed workspace dot alert ────────────────────────
//
// When a process crashes and the process pane is closed, the
// crashedWhileClosed flag on the claxedo facade is set to true.
// This drives a red pulsing ring on the workspace dot indicator.
// Opening the pane clears the flag.

describe("crashedWhileClosed workspace dot alert", () => {
  test("process.crashed SSE sets crashedWhileClosed when pane is closed", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()
      expect(api.isOpen()).toBe(false)
      expect(mockLayout._getCrashedWhileClosed()).toBe(false)

      emitSSE("process.crashed", { configId: "proc_abc123", exitCode: 1, restartCount: 0 })

      expect(mockLayout._getCrashedWhileClosed()).toBe(true)
    } finally {
      dispose()
    }
  })

  test("process.crashed SSE does NOT set crashedWhileClosed when pane is open", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()
      // Open the pane first
      api.toggle()
      expect(api.isOpen()).toBe(true)

      emitSSE("process.crashed", { configId: "proc_abc123", exitCode: 1, restartCount: 0 })

      expect(mockLayout._getCrashedWhileClosed()).toBe(false)
    } finally {
      dispose()
    }
  })

  test("opening pane clears crashedWhileClosed", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()
      expect(api.isOpen()).toBe(false)

      // Crash while closed
      emitSSE("process.crashed", { configId: "proc_abc123", exitCode: 1, restartCount: 0 })
      expect(mockLayout._getCrashedWhileClosed()).toBe(true)

      // Open the pane — flag should clear
      api.toggle()
      expect(api.isOpen()).toBe(true)
      expect(mockLayout._getCrashedWhileClosed()).toBe(false)
    } finally {
      dispose()
    }
  })

  test("multiple crashes while closed — single open clears the flag", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG, SAMPLE_CONFIG_2],
        processes: [
          { configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 },
          { configId: "proc_def456", ptyId: "pty_2", status: "running", restartCount: 0 },
        ],
      }),
    })
    try {
      await tick()
      expect(api.isOpen()).toBe(false)

      // Two crashes while closed
      emitSSE("process.crashed", { configId: "proc_abc123", exitCode: 1, restartCount: 0 })
      emitSSE("process.crashed", { configId: "proc_def456", exitCode: 137, restartCount: 0 })
      expect(mockLayout._getCrashedWhileClosed()).toBe(true)

      // Opening once clears it
      api.toggle()
      expect(mockLayout._getCrashedWhileClosed()).toBe(false)
    } finally {
      dispose()
    }
  })

  test("crash → open → close → crash sets flag again", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()

      // First crash while closed
      emitSSE("process.crashed", { configId: "proc_abc123", exitCode: 1, restartCount: 0 })
      expect(mockLayout._getCrashedWhileClosed()).toBe(true)

      // Open clears
      api.toggle()
      expect(mockLayout._getCrashedWhileClosed()).toBe(false)

      // Close again
      api.toggle()
      expect(api.isOpen()).toBe(false)

      // Second crash while closed — flag should re-activate
      emitSSE("process.crashed", { configId: "proc_abc123", exitCode: 2, restartCount: 1 })
      expect(mockLayout._getCrashedWhileClosed()).toBe(true)
    } finally {
      dispose()
    }
  })

  test("crash always preserves ptyId regardless of commandExit flag", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()
      expect(api.processForConfig("proc_abc123")!.ptyId).toBe("pty_1")

      // Command-exit crash (shell alive) — ptyId preserved
      emitSSE("process.crashed", { configId: "proc_abc123", exitCode: 1, restartCount: 0, commandExit: true })
      expect(api.processForConfig("proc_abc123")!.ptyId).toBe("pty_1")

      // Reset to running for second test
      emitSSE("process.started", { configId: "proc_abc123", ptyId: "pty_2" })
      expect(api.processForConfig("proc_abc123")!.ptyId).toBe("pty_2")

      // PTY-death crash (no commandExit) — ptyId STILL preserved so the
      // Terminal component can show a "Connection lost" message
      emitSSE("process.crashed", { configId: "proc_abc123", exitCode: 1, restartCount: 0 })
      expect(api.processForConfig("proc_abc123")!.ptyId).toBe("pty_2")
    } finally {
      dispose()
    }
  })

  test("process.stopped SSE does NOT set crashedWhileClosed", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()
      expect(api.isOpen()).toBe(false)

      emitSSE("process.stopped", { configId: "proc_abc123", exitCode: 0 })

      // Stopped is intentional — no alert
      expect(mockLayout._getCrashedWhileClosed()).toBe(false)
    } finally {
      dispose()
    }
  })
})

// ── Reload: process PTY detection deferral ──────────────────────────
//
// On app reload, process-owned PTYs arrive via SSE before fetchProcesses()
// registers ownership. Without deferral, the terminal detection effect
// creates tabs for these PTYs. The process pane calls expectProcessPty()
// on mount and resolveProcessPty() after fetchProcesses() completes
// (or fails) to gate detection during this window.

describe("reload defers terminal detection until fetch completes", () => {
  test("expectProcessPty called on mount, resolveProcessPty after fetch", async () => {
    let pendingDuringFetch = -1
    fetchState.responses = {
      "GET": () => {
        pendingDuringFetch = mockLayout.terminal.pendingProcessStarts()
        return { configs: [SAMPLE_CONFIG], processes: [] }
      },
    }

    const { api, dispose } = createTestProcessPane()
    try {
      // Before fetch completes, pending should be > 0
      expect(mockLayout.terminal.pendingProcessStarts()).toBeGreaterThan(0)

      await tick()

      // During fetch, pending was still > 0
      expect(pendingDuringFetch).toBeGreaterThan(0)
      // After fetch, pending is back to 0
      expect(mockLayout.terminal.pendingProcessStarts()).toBe(0)
    } finally {
      dispose()
    }
  })

  test("resolveProcessPty called even when all fetch retries fail", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({ __fail: true }),
    })
    try {
      // Pending during retry window
      expect(mockLayout.terminal.pendingProcessStarts()).toBeGreaterThan(0)

      // Wait for all 3 retries (1s + 2s + 4s = 7s) plus margin
      await new Promise((r) => setTimeout(r, 8000))

      // Must be resolved even after total failure
      expect(mockLayout.terminal.pendingProcessStarts()).toBe(0)
    } finally {
      dispose()
    }
  }, 10000)
})

// ── fetchProcesses preserves crashed ptyId across reconcile ─────────
//
// When a process crashes via PTY-death, the server clears ptyId. But the
// client preserves it so the Terminal component stays mounted showing the
// crash output. fetchProcesses() (called on wake/visibility change) must
// NOT overwrite the client-preserved ptyId with the server's undefined.

describe("fetchProcesses preserves crashed ptyId across reconcile", () => {
  test("wake fetch does not overwrite client-preserved ptyId for crashed process", async () => {
    let fetchCount = 0
    const { api, dispose } = createTestProcessPane({
      "GET": () => {
        fetchCount++
        if (fetchCount <= 1) {
          // Initial: process is running with ptyId
          return {
            configs: [SAMPLE_CONFIG],
            processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
          }
        }
        // After wake: server says crashed WITHOUT ptyId (PTY-death)
        return {
          configs: [SAMPLE_CONFIG],
          processes: [{ configId: "proc_abc123", status: "crashed", restartCount: 1, exitCode: 1 }],
        }
      },
    })
    try {
      await tick()
      expect(api.processForConfig("proc_abc123")!.ptyId).toBe("pty_1")

      // Crash via SSE (preserves ptyId client-side)
      emitSSE("process.crashed", { configId: "proc_abc123", exitCode: 1, restartCount: 1 })
      expect(api.processForConfig("proc_abc123")!.status).toBe("crashed")
      expect(api.processForConfig("proc_abc123")!.ptyId).toBe("pty_1")

      // Wake triggers fetchProcesses — server returns ptyId: undefined
      simulateWake()
      await tick()

      // Client should STILL have ptyId preserved
      const proc = api.processForConfig("proc_abc123")!
      expect(proc.status).toBe("crashed")
      expect(proc.ptyId).toBe("pty_1")
    } finally {
      dispose()
    }
  })

  test("fetchProcesses does NOT restore ptyId for non-crashed processes", async () => {
    let fetchCount = 0
    const { api, dispose } = createTestProcessPane({
      "GET": () => {
        fetchCount++
        if (fetchCount <= 1) {
          return {
            configs: [SAMPLE_CONFIG],
            processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
          }
        }
        // After wake: server says stopped (no ptyId)
        return {
          configs: [SAMPLE_CONFIG],
          processes: [{ configId: "proc_abc123", status: "stopped", restartCount: 0, exitCode: 0 }],
        }
      },
    })
    try {
      await tick()
      expect(api.processForConfig("proc_abc123")!.ptyId).toBe("pty_1")

      // Stop clears ptyId → server returns stopped without ptyId
      simulateWake()
      await tick()

      // Stopped process should NOT have ptyId restored
      const proc = api.processForConfig("proc_abc123")!
      expect(proc.status).toBe("stopped")
      expect(proc.ptyId).toBeUndefined()
    } finally {
      dispose()
    }
  })

  test("fetchProcesses preserves ptyId for multiple crashed processes", async () => {
    let fetchCount = 0
    const { api, dispose } = createTestProcessPane({
      "GET": () => {
        fetchCount++
        if (fetchCount <= 1) {
          return {
            configs: [SAMPLE_CONFIG, SAMPLE_CONFIG_2],
            processes: [
              { configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 },
              { configId: "proc_def456", ptyId: "pty_2", status: "running", restartCount: 0 },
            ],
          }
        }
        return {
          configs: [SAMPLE_CONFIG, SAMPLE_CONFIG_2],
          processes: [
            { configId: "proc_abc123", status: "crashed", restartCount: 1, exitCode: 1 },
            { configId: "proc_def456", status: "crashed", restartCount: 2, exitCode: 137 },
          ],
        }
      },
    })
    try {
      await tick()

      // Crash both via SSE
      emitSSE("process.crashed", { configId: "proc_abc123", exitCode: 1, restartCount: 1 })
      emitSSE("process.crashed", { configId: "proc_def456", exitCode: 137, restartCount: 2 })
      expect(api.processForConfig("proc_abc123")!.ptyId).toBe("pty_1")
      expect(api.processForConfig("proc_def456")!.ptyId).toBe("pty_2")

      // Wake fetch returns both crashed without ptyId
      simulateWake()
      await tick()

      expect(api.processForConfig("proc_abc123")!.ptyId).toBe("pty_1")
      expect(api.processForConfig("proc_def456")!.ptyId).toBe("pty_2")
    } finally {
      dispose()
    }
  })
})

// ── Stale process tab cleanup on reload ──────────────────────────────
//
// On reload, the persisted terminalOwner map has OLD ptyIds → "process:*".
// After fetchProcesses owns CURRENT ptyIds, cleanupStaleProcessTabs finds
// stale process-owned ptyIds and removes their persisted terminal tabs.

describe("stale process tab cleanup", () => {
  test("fetchProcesses removes stale process tabs from previous session", async () => {
    // Simulate: previous session owned pty_old for process, current server has pty_new.
    // The persisted groups have a tab for pty_old.
    mockLayout._setGroups([{
      id: "group_1",
      tabs: [
        { id: "tab_old", type: "terminal", terminalId: "pty_old" },
        { id: "tab_other", type: "terminal", terminalId: "pty_other" },
      ],
    }])
    // Simulate persisted terminalOwner from previous session
    mockLayout._ownedPtys.set("pty_old", "process:proc_abc123")

    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_new", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()

      // pty_new should be owned by the process
      expect(mockLayout._ownedPtys.get("pty_new")).toBe("process:proc_abc123")
      // pty_old should REMAIN owned (belt-and-suspenders protection)
      expect(mockLayout._ownedPtys.has("pty_old")).toBe(true)
      // Stale PTY should be removed from terminal.all() (primary defense)
      expect(removedStalePtyIds).toContain("pty_old")
      // The stale tab should have been closed
      expect(mockLayout._closedTabs).toContain("tab_old")
      // Non-process tabs should remain
      const group = mockLayout._getGroups()[0]
      const otherTab = group.tabs.find((t: MockTab) => t.id === "tab_other")
      expect(otherTab).toBeDefined()
    } finally {
      dispose()
    }
  })

  test("current process PTYs are NOT affected by stale cleanup", async () => {
    // Stale cleanup should keep OLD ptyIds owned and NOT touch current ones.
    mockLayout._setGroups([{
      id: "group_1",
      tabs: [
        { id: "tab_old", type: "terminal", terminalId: "pty_old" },
      ],
    }])
    mockLayout._ownedPtys.set("pty_old", "process:proc_abc123")

    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_new", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()
      // Current ptyId should be owned by the process
      expect(mockLayout._ownedPtys.get("pty_new")).toBe("process:proc_abc123")
      // Old ptyId should REMAIN owned (belt-and-suspenders protection)
      expect(mockLayout._ownedPtys.has("pty_old")).toBe(true)
      // Stale PTY should be removed from terminal.all()
      expect(removedStalePtyIds).toContain("pty_old")
      // Current PTY should NOT be removed
      expect(removedStalePtyIds).not.toContain("pty_new")
    } finally {
      dispose()
    }
  })

  test("cleanup handles multiple stale process PTYs", async () => {
    mockLayout._setGroups([{
      id: "group_1",
      tabs: [
        { id: "tab_old1", type: "terminal", terminalId: "pty_old1" },
        { id: "tab_old2", type: "terminal", terminalId: "pty_old2" },
      ],
    }])
    // Simulate persisted ownership from previous session
    mockLayout._ownedPtys.set("pty_old1", "process:proc_abc123")
    mockLayout._ownedPtys.set("pty_old2", "process:proc_def456")

    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG, SAMPLE_CONFIG_2],
        processes: [
          { configId: "proc_abc123", ptyId: "pty_new1", status: "running", restartCount: 0 },
          { configId: "proc_def456", ptyId: "pty_new2", status: "running", restartCount: 0 },
        ],
      }),
    })
    try {
      await tick()
      // Both stale tabs should be closed
      expect(mockLayout._closedTabs).toContain("tab_old1")
      expect(mockLayout._closedTabs).toContain("tab_old2")
      // Both old PTYs should REMAIN owned (belt-and-suspenders)
      expect(mockLayout._ownedPtys.has("pty_old1")).toBe(true)
      expect(mockLayout._ownedPtys.has("pty_old2")).toBe(true)
      // Both stale PTYs should be removed from terminal.all()
      expect(removedStalePtyIds).toContain("pty_old1")
      expect(removedStalePtyIds).toContain("pty_old2")
      // New PTYs should be owned and NOT removed
      expect(mockLayout._ownedPtys.get("pty_new1")).toBe("process:proc_abc123")
      expect(mockLayout._ownedPtys.get("pty_new2")).toBe("process:proc_def456")
      expect(removedStalePtyIds).not.toContain("pty_new1")
      expect(removedStalePtyIds).not.toContain("pty_new2")
    } finally {
      dispose()
    }
  })
})

// ── Crash handler receives ptyId from event ─────────────────────────

describe("crash handler ptyId from event", () => {
  test("process.crashed SSE with ptyId sets it even when store was cleared", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()
      expect(api.processForConfig("proc_abc123")!.ptyId).toBe("pty_1")

      // Crash with ptyId in event (command-exit)
      emitSSE("process.crashed", { configId: "proc_abc123", exitCode: 1, restartCount: 1, ptyId: "pty_1" })

      const proc = api.processForConfig("proc_abc123")!
      expect(proc.status).toBe("crashed")
      expect(proc.ptyId).toBe("pty_1")
      // PTY should still be owned
      expect(mockLayout._ownedPtys.get("pty_1")).toBe("process:proc_abc123")
    } finally {
      dispose()
    }
  })

  test("process.crashed SSE creates entry with ptyId even if no existing entry", async () => {
    // Start with empty processes — simulate race where store was just cleared
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [],
      }),
    })
    try {
      await tick()

      // Crash event arrives with ptyId but no existing store entry
      emitSSE("process.crashed", { configId: "proc_abc123", exitCode: 1, restartCount: 0, ptyId: "pty_1" })

      const proc = api.processForConfig("proc_abc123")!
      expect(proc).toBeDefined()
      expect(proc.status).toBe("crashed")
      expect(proc.ptyId).toBe("pty_1")
      expect(mockLayout._ownedPtys.get("pty_1")).toBe("process:proc_abc123")
    } finally {
      dispose()
    }
  })

  test("process.crashed SSE without ptyId preserves existing ptyId", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()
      // Crash without ptyId in event (PTY-death) — should preserve from existing
      emitSSE("process.crashed", { configId: "proc_abc123", exitCode: 1, restartCount: 1 })

      const proc = api.processForConfig("proc_abc123")!
      expect(proc.status).toBe("crashed")
      expect(proc.ptyId).toBe("pty_1")
    } finally {
      dispose()
    }
  })
})

// ── Adapter integration tests ─────────────────────────────────────────
// Verify that process-pane routes ALL ownership and tab operations through
// the adapter layer (createProcessOwnership / createTerminalTabOps) rather
// than calling claxedo.terminal.* or iterating groups directly.

describe("adapter integration", () => {
  test("fetchProcesses owns PTYs via adapter (ownership.ownProcess)", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()
      // The adapter delegates to claxedo.terminal.own — verify the effect
      expect(mockLayout._ownedPtys.get("pty_1")).toBe("process:proc_abc123")
    } finally {
      dispose()
    }
  })

  test("openInTab disowns via adapter and adds tab via tabOps", async () => {
    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()
      // PTY is owned before openInTab
      expect(mockLayout._ownedPtys.has("pty_1")).toBe(true)

      api.openInTab("proc_abc123")
      await tick()

      // After openInTab, ownership is released via adapter
      expect(mockLayout._ownedPtys.has("pty_1")).toBe(false)
      // Tab was added via tabOps adapter (which delegates to topTabs/groupTabs)
      expect(mockLayout._addedTerminals.length).toBeGreaterThanOrEqual(1)
      const added = mockLayout._addedTerminals[mockLayout._addedTerminals.length - 1]
      expect(added.ptyId).toBe("pty_1")
    } finally {
      dispose()
    }
  })

  test("start() uses adapter for expect/resolve process PTY deferral", async () => {
    const { api, dispose } = createTestProcessPane()
    try {
      await tick()
      const before = mockLayout.terminal.pendingProcessStarts()

      // start() calls ownership.expectProcessPty() then ownership.resolveProcessPty()
      await api.start("proc_abc123")

      // After start completes, pending count should be back where it was
      expect(mockLayout.terminal.pendingProcessStarts()).toBe(before)
    } finally {
      dispose()
    }
  })

  test("stale cleanup uses adapter for processOwnedPtyIds and removeTerminalTabsByPtyIds", async () => {
    // Seed a stale process-owned PTY that is NOT in the current server data
    mockLayout._ownedPtys.set("stale-pty", "process:old-config")
    mockLayout._setGroups([
      { id: "g1", tabs: [{ id: "tab-stale", type: "terminal", terminalId: "stale-pty" }] },
    ])

    const { api, dispose } = createTestProcessPane({
      "GET": () => ({
        configs: [SAMPLE_CONFIG],
        processes: [{ configId: "proc_abc123", ptyId: "pty_1", status: "running", restartCount: 0 }],
      }),
    })
    try {
      await tick()
      // Stale PTY's tab should be cleaned up via tabOps.removeTerminalTabsByPtyIds
      expect(mockLayout._closedTabs).toContain("tab-stale")
      // Stale PTY should also be removed from terminal.all() via terminalCtx.removeStale
      expect(removedStalePtyIds).toContain("stale-pty")
    } finally {
      dispose()
    }
  })

  test("SSE process.started uses adapter to own PTY and remove auto-created tabs", async () => {
    // Set up a group with an auto-created tab that should be cleaned
    mockLayout._setGroups([
      { id: "g1", tabs: [{ id: "auto-tab", type: "terminal", terminalId: "pty_new" }] },
    ])

    const { api, dispose } = createTestProcessPane()
    try {
      await tick()

      // SSE process.started should own the PTY and remove auto-created tab
      emitSSE("process.started", { configId: "proc_abc123", ptyId: "pty_new" })

      expect(mockLayout._ownedPtys.get("pty_new")).toBe("process:proc_abc123")
      expect(mockLayout._closedTabs).toContain("auto-tab")
    } finally {
      dispose()
    }
  })

  test("SSE process.crashed uses adapter to own PTY", async () => {
    const { api, dispose } = createTestProcessPane()
    try {
      await tick()

      emitSSE("process.crashed", { configId: "proc_abc123", exitCode: 1, restartCount: 0, ptyId: "pty_crash" })

      expect(mockLayout._ownedPtys.get("pty_crash")).toBe("process:proc_abc123")
    } finally {
      dispose()
    }
  })

  test("resolveInitialProcessPty is called via adapter on mount completion", async () => {
    // Track the initial pending count
    const initialPending = mockLayout.terminal.pendingProcessStarts()

    const { api, dispose } = createTestProcessPane()
    try {
      await tick()
      // After mount + fetchProcesses, the initial count should be resolved
      expect(mockLayout.terminal.pendingProcessStarts()).toBe(initialPending - 1)
    } finally {
      dispose()
    }
  })
})
