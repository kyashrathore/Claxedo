import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import {
  assertMemoryBrowserProcessExit,
  closeMemoryBrowser,
  type MemoryBrowserProcessHandle,
  type MemoryBrowserServerHandle,
} from "../src/memory-lane"
import {
  memoryRecords,
  memoryComparisonPublishable,
  memoryCacheCeilingStatus,
  memoryRunValidity,
  memorySessionQueryCounts,
  memorySamplesStable,
  memoryVisitOrder,
  needsFinalMemorySample,
  parseMemoryInteger,
  sessionActivationSelector,
  summarizeMemorySweeps,
  tailSlope,
  type MemorySample,
  type MemorySweep,
} from "../src/memory-runner"

const MB = 1024 * 1024

function browser(input: {
  connected: () => boolean
  contexts?: () => unknown[]
}) {
  return {
    isConnected: input.connected,
    contexts: input.contexts ?? (() => []),
  }
}

class FakeBrowserProcess extends EventEmitter {
  readonly pid = 42
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  rawKillReturns = true
  rawKillExits = true
  killCalls: Array<NodeJS.Signals | number> = []

  exit(code: number | null, signal: NodeJS.Signals | null) {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.exitCode = code
    this.signalCode = signal
    this.emit("exit", code, signal)
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM") {
    this.killCalls.push(signal)
    if (this.rawKillReturns && this.rawKillExits) {
      this.exit(null, typeof signal === "string" ? signal : "SIGKILL")
    }
    return this.rawKillReturns
  }

  handle() {
    return this as unknown as MemoryBrowserProcessHandle
  }
}

function server(
  process: FakeBrowserProcess,
  input: {
    close: () => Promise<void>
    kill?: () => Promise<void>
  },
): MemoryBrowserServerHandle {
  return {
    close: input.close,
    kill: input.kill ?? (async () => process.exit(null, "SIGKILL")),
    process: () => process.handle(),
  }
}

describe("browser teardown", () => {
  test("records a graceful server close and verifies the owned process exit", async () => {
    let connected = true
    const process = new FakeBrowserProcess()
    const contexts: unknown[] = [{}]
    const result = await closeMemoryBrowser({
      browser: browser({ connected: () => connected, contexts: () => contexts }),
      server: server(process, {
        close: async () => {
          connected = false
          contexts.length = 0
          process.exit(0, null)
        },
      }),
    }, 50)

    expect(result).toMatchObject({
      status: "normal",
      before: {
        browser: { connected: true, contexts: 1 },
        process: { pid: 42, exited: false },
      },
      after: {
        browser: { connected: false, contexts: 0 },
        process: { pid: 42, exitCode: 0, signalCode: null, exited: true },
      },
      normalClose: { status: "completed" },
      forcedServerKill: { status: "not-needed" },
      forcedProcessKill: { status: "not-needed" },
      verifiedProcessExit: true,
    })
  })

  test("records a graceful-close rejection while accepting independently verified process exit", async () => {
    const process = new FakeBrowserProcess()
    const result = await closeMemoryBrowser({
      browser: browser({ connected: () => false }),
      server: server(process, {
        close: async () => {
          process.exit(0, null)
          throw new Error("transport closed first")
        },
      }),
    }, 50)

    expect(result).toMatchObject({
      status: "normal",
      normalClose: { status: "rejected", error: "transport closed first" },
      after: { process: { exited: true } },
      verifiedProcessExit: true,
    })
  })

  test("bounds a hung graceful close and verifies server kill even when browser state is stale", async () => {
    const never = new Promise<void>(() => undefined)
    const process = new FakeBrowserProcess()
    const result = await closeMemoryBrowser({
      browser: browser({ connected: () => true, contexts: () => [{}] }),
      server: server(process, { close: () => never }),
    }, 1)

    expect(result).toMatchObject({
      status: "forced",
      timeoutMs: 1,
      normalClose: { status: "timed-out" },
      forcedServerKill: { status: "completed" },
      forcedProcessKill: { status: "not-needed" },
      after: {
        browser: { connected: true, contexts: 1 },
        process: { signalCode: "SIGKILL", exited: true },
      },
      verifiedProcessExit: true,
    })
  })

  test("falls back to direct SIGKILL when both Playwright server operations hang", async () => {
    const never = new Promise<void>(() => undefined)
    const process = new FakeBrowserProcess()
    const result = await closeMemoryBrowser({
      server: server(process, { close: () => never, kill: () => never }),
    }, 1)

    expect(result).toMatchObject({
      status: "forced",
      normalClose: { status: "timed-out" },
      forcedServerKill: { status: "timed-out" },
      forcedProcessKill: { status: "completed" },
      before: { browser: { connected: undefined, contexts: undefined } },
      after: { process: { signalCode: "SIGKILL", exited: true } },
      verifiedProcessExit: true,
    })
    expect(process.killCalls).toEqual(["SIGKILL"])
  })

  test("refuses fresh-browser isolation and aborts before report publication when process exit is unverified", async () => {
    const never = new Promise<void>(() => undefined)
    const process = new FakeBrowserProcess()
    process.rawKillReturns = false
    process.rawKillExits = false
    const result = await closeMemoryBrowser({
      browser: browser({ connected: () => false }),
      server: server(process, { close: () => never, kill: () => never }),
    }, 1)

    expect(result).toMatchObject({
      status: "unverified",
      normalClose: { status: "timed-out" },
      forcedServerKill: { status: "timed-out" },
      forcedProcessKill: {
        status: "rejected",
        error: "ChildProcess.kill(SIGKILL) returned false",
      },
      after: { process: { exitCode: null, signalCode: null, exited: false } },
      verifiedProcessExit: false,
    })
    expect(process.killCalls).toEqual(["SIGKILL"])
    expect(() => assertMemoryBrowserProcessExit(result, 3)).toThrow(
      "Memory repetition 3 browser process exit could not be verified",
    )
    expect(() => assertMemoryBrowserProcessExit(result, 3)).toThrow('"verifiedProcessExit":false')
  })
})

const sample = (heapBytes: number, step: number, input: Partial<MemorySample> = {}): MemorySample => ({
  step,
  heapBytes,
  documentElements: 100,
  queries: 10,
  cachedSessions: 10,
  lightweightSessions: 10,
  families: {},
  documents: 2,
  liveDomNodes: 200,
  liveListeners: 50,
  ...input,
})

const sweepSamples = (heaps: number[]) => heaps.map((heap, index) => sample(heap, index * 10))

const sweep = (slope: number | undefined, plateau: number, input: Partial<MemorySweep> = {}): MemorySweep => ({
  flow: "session-accumulation-normal-click-v2",
  mode: "normal",
  samples: [sample(20 * MB, 0), sample(plateau, 60)],
  settlement: {
    samples: [sample(plateau, 60)],
    stable: true,
    cacheCeilingSatisfied: true,
    diagnosticCacheCeilingSatisfied: true,
  },
  ...(slope === undefined ? {} : { slopeBytesPerStep: slope }),
  plateauBytes: plateau,
  ...input,
})

describe("tail slope", () => {
  test("fits all tail samples with least-squares regression", () => {
    const linear = sweepSamples([20, 30, 40, 50, 60, 70, 80, 90].map((mb) => mb * MB))
    expect(tailSlope(linear)).toBeCloseTo(MB)
  })

  test("does not reduce the tail to its two endpoints", () => {
    const values = [0, 0, 0, 10, 20, 30, 5].map((mb) => mb * MB)
    const samples = sweepSamples(values)
    const endpointSlope = (values.at(-1)! - values[2]!) / (samples.at(-1)!.step - samples[2]!.step)
    expect(tailSlope(samples)).not.toBeCloseTo(endpointSlope)
  })

  test("a sufficiently sampled flat curve reports zero", () => {
    expect(tailSlope(sweepSamples([22 * MB, 22 * MB, 22 * MB, 22 * MB, 22 * MB]))).toBe(0)
  })

  test("rejects underdetermined fits instead of reporting a guessed zero", () => {
    expect(tailSlope(sweepSamples([20 * MB, 21 * MB, 22 * MB]))).toBeUndefined()
    expect(tailSlope([])).toBeUndefined()
  })

  test("requires an immediate sample at the final post-click step", () => {
    expect(needsFinalMemorySample([{ step: 0 }, { step: 10 }], 12)).toBe(true)
    expect(needsFinalMemorySample([{ step: 0 }, { step: 12 }], 12)).toBe(false)
  })
})

describe("settlement contract", () => {
  test("requires three stable forced-GC observations", () => {
    const stable = [
      sample(50 * MB, 60),
      sample(50 * MB + 64 * 1024, 60),
      sample(50 * MB + 32 * 1024, 60),
    ]
    expect(memorySamplesStable(stable.slice(0, 2))).toBe(false)
    expect(memorySamplesStable(stable)).toBe(true)
    expect(memorySamplesStable([...stable.slice(0, 2), sample(50 * MB, 60, { queries: 11 })])).toBe(false)
    expect(memorySamplesStable([...stable.slice(0, 2), sample(50 * MB, 60, { lightweightSessions: 11 })])).toBe(false)
  })

  test("requires documents, live DOM nodes, and main-document elements to stabilize", () => {
    const stable = [sample(50 * MB, 60), sample(50 * MB, 60), sample(50 * MB, 60)]
    for (const change of [{ documents: 3 }, { liveDomNodes: 201 }, { documentElements: 101 }]) {
      expect(memorySamplesStable([...stable.slice(0, 2), sample(50 * MB, 60, change)])).toBe(false)
    }
  })

  test("pins validity to product ceiling 40 while preserving a diagnostic threshold", () => {
    expect(memoryCacheCeilingStatus(60, 100)).toEqual({
      cacheCeilingSatisfied: false,
      diagnosticCacheCeilingSatisfied: true,
    })
  })

  test("counts heavy session surfaces separately from lightweight rail metadata", () => {
    const surface = Array.from({ length: 40 }, (_, index) => ["shell", "session", `ses_${index}`, "messages"])
    const lightweight = Array.from({ length: 60 }, (_, index) => [
      ["shell", "session", `ses_${index}`, "status"],
      ["shell", "session", `ses_${index}`, "requests"],
    ]).flat()
    const counts = memorySessionQueryCounts([...surface, ...lightweight], (key) =>
      key[0] === "shell" && key[1] === "session" && key[3] !== "status" && key[3] !== "requests")

    expect(counts).toEqual({ cachedSessions: 40, lightweightSessions: 60 })
    expect(memoryCacheCeilingStatus(counts.cachedSessions, 100).cacheCeilingSatisfied).toBe(true)
  })
})

describe("public session navigation", () => {
  test("clicks every session top→bottom in the supplied rail order", () => {
    expect(memoryVisitOrder(["a", "b", "c"])).toEqual(["a", "b", "c"])
  })

  test("builds the canonical visible rail-row selector without synthetic routing", () => {
    expect(sessionActivationSelector('ses_"quoted"')).toBe(
      '[data-testid="rail-sidebar-session-row"][data-session-id="ses_\\"quoted\\""]:visible',
    )
  })
})

describe("repeated sweep summary", () => {
  test("uses the median and preserves spread and validity", () => {
    const summary = summarizeMemorySweeps([
      sweep(300, 30 * MB),
      sweep(100, 20 * MB),
      sweep(200, 25 * MB),
    ])
    expect(summary.slopeBytesPerStep).toBe(200)
    expect(summary.slopeMinBytesPerStep).toBe(100)
    expect(summary.slopeMaxBytesPerStep).toBe(300)
    expect(summary.plateauBytes).toBe(25 * MB)
    expect(summary.allSettled).toBe(true)
    expect(summary.cacheCeilingSatisfied).toBe(true)
  })

  test("one unstable or over-ceiling repetition invalidates the pooled contract", () => {
    const summary = summarizeMemorySweeps([
      sweep(100, 20 * MB),
      sweep(200, 30 * MB, {
        settlement: {
          samples: [sample(30 * MB, 60)],
          stable: false,
          cacheCeilingSatisfied: false,
          diagnosticCacheCeilingSatisfied: true,
        },
      }),
    ])
    expect(summary.allSettled).toBe(false)
    expect(summary.cacheCeilingSatisfied).toBe(false)
  })

  test("portable records gate JS heap slope and settled heap separately", () => {
    const summary = summarizeMemorySweeps([sweep(100, 20 * MB), sweep(200, 30 * MB)])
    const records = memoryRecords(summary, "solid-1", "laptop")
    expect(records.map((record) => record.metric)).toEqual([
      "retained_heap_bytes_per_visit",
      "retained_heap_bytes",
    ])
    expect(records[0]?.value).toBe(150)
    expect(records[0]?.samples).toEqual([100, 200])
    expect(records[0]?.unit).toBe("bytes/visit")
    expect(records[1]?.value).toBe(25 * MB)
  })

  test("marks pooled slope absent when any repetition is underdetermined", () => {
    const summary = summarizeMemorySweeps([sweep(100, 20 * MB), sweep(undefined, 30 * MB)])
    expect(summary.slopeSupported).toBe(false)
    const [record] = memoryRecords(summary, "solid-1", "laptop")
    expect(record?.value).toBeUndefined()
    expect(record?.absentReason).toContain("distinct post-click")
  })

  test("invalidity is explicit and names every publication blocker", () => {
    const validity = memoryRunValidity({
      summary: { slopeSupported: false, allSettled: false, cacheCeilingSatisfied: false },
      repetitionsSufficient: false,
      sourceStable: false,
      snapshotAvailable: false,
    })
    expect(validity.status).toBe("invalid")
    expect(validity.reasons).toEqual([
      "underdetermined-slope",
      "settlement-unstable",
      "product-cache-ceiling-exceeded",
      "insufficient-repetitions",
      "source-changed",
      "snapshot-unsupported",
    ])
    expect(memoryComparisonPublishable(validity)).toBe(false)
  })
})

describe("memory count options", () => {
  test("accepts safe integers and rejects fractional sessions or iterations", () => {
    expect(parseMemoryInteger("sessions", "60", 2)).toBe(60)
    expect(() => parseMemoryInteger("sessions", "2.5", 2)).toThrow("safe integer")
    expect(() => parseMemoryInteger("iterations", Number.MAX_SAFE_INTEGER + 1, 1)).toThrow("safe integer")
  })
})
