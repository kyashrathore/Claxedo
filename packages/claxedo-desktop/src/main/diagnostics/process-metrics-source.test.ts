import { describe, expect, test } from "bun:test"

import type { ElectronDiagnosticsSource } from "./electron-source"
import { createProcessMetricsSource, mergeByProcess } from "./process-metrics-source"
import type { DiagnosticsObservation } from "./profiler"

describe("process metrics source", () => {
  test("creates the host worker only while platform metrics are demanded", async () => {
    let workers = 0
    let samples = 0
    let disposals = 0
    const source = createProcessMetricsSource({
      platform: "linux",
      hostCollection: "on-demand",
      electron: electron(() => [observation(50, "electron", undefined, undefined)]),
      workerFactory: () => {
        workers++
        return {
          async reconcile() {
            return { entries: [{ pid: 50, ppid: 1, rootPid: 50 }], truncated: false }
          },
          async sample(entries) {
            samples++
            return entries.map((entry) => ({
              ...entry,
              creation: { state: "available" as const, value: "linux-start", source: "linux-proc" as const },
              cpuMachinePercent: 1,
              rssBytes: 1_000,
            }))
          },
          clear() {},
          dispose() {
            disposals++
          },
        }
      },
    })
    source.registerRoot(root(50))

    source.collect(0)
    await Bun.sleep(0)
    expect({ workers, samples, disposals }).toEqual({ workers: 0, samples: 0, disposals: 0 })

    source.setDemanded?.(true)
    source.collect(500)
    await Bun.sleep(0)
    expect({ workers, samples, disposals }).toEqual({ workers: 1, samples: 1, disposals: 0 })

    source.setDemanded?.(false)
    source.collect(1_000)
    await Bun.sleep(0)
    expect({ workers, samples, disposals }).toEqual({ workers: 1, samples: 1, disposals: 1 })

    source.setDemanded?.(true)
    source.collect(1_500)
    await Bun.sleep(0)
    expect({ workers, samples, disposals }).toEqual({ workers: 2, samples: 2, disposals: 1 })
    source.dispose?.()
  })

  test("keeps Electron cadence independent while a platform call is stalled", async () => {
    electronCallsForProof = 0
    let resolveTree: ((value: { entries: []; truncated: false }) => void) | undefined
    const source = createProcessMetricsSource({
      platform: "linux",
      electron: electron(() => [observation(10, "electron", 1, 1_000)]),
      worker: {
        reconcile: () => new Promise((resolve) => (resolveTree = resolve)),
        async sample() {
          return []
        },
        clear() {},
        dispose() {},
      },
    })
    source.registerRoot(root(50))
    source.collect(0)
    source.collect(500)
    source.collect(1_000)
    expect(electronCallsForProof).toBe(3)
    expect(source.collect(1_500)).toHaveLength(1)
    expect(electronCallsForProof).toBe(4)
    resolveTree?.({ entries: [], truncated: false })
    await Bun.sleep(0)
    expect(source.getStats()).toMatchObject({
      hostCollections: 1,
      reconciliations: 1,
    })
  })

  test("reports platform health separately and does not leak raw failure", async () => {
    const source = createProcessMetricsSource({
      platform: "linux",
      electron: electron(() => []),
      worker: {
        async reconcile() {
          throw new Error("TOP_SECRET raw package error")
        },
        async sample() {
          return []
        },
        clear() {},
        dispose() {},
      },
    })
    source.registerRoot(root(50))
    source.collect(0)
    await Bun.sleep(0)
    expect(source.statuses?.()).toEqual([
      expect.objectContaining({ source: "linux-proc", state: "degraded", reason: "source-failed" }),
    ])
    expect(JSON.stringify(source.statuses?.())).not.toContain("TOP_SECRET")
  })

  test("retries a degraded platform source on backoff and returns to healthy once it recovers", async () => {
    // A source that fails a few times and is never retried looks identical,
    // in a snapshot, to one that failed permanently — and the release gate
    // reads exactly that: three failures in the first two seconds, then
    // silence, then a stop grant that never arrives. The backoff must expire
    // and the source must climb back to healthy on its own.
    let failures = 0
    const source = createProcessMetricsSource({
      platform: "linux",
      electron: electron(() => []),
      random: () => 0,
      worker: {
        async reconcile() {
          if (++failures <= 3) throw new Error("transient platform failure")
          return { entries: [{ pid: 50, ppid: 1, rootPid: 50 }], truncated: false }
        },
        async sample(entries: Array<{ pid: number }>) {
          return entries.map((entry) => ({
            ...entry,
            creation: { state: "available" as const, value: "c", source: "linux-proc" as const },
            cpuMachinePercent: 1,
            rssBytes: 1_000,
          }))
        },
        clear() {},
        dispose() {},
      },
    })
    source.registerRoot(root(50))

    // Drive past each backoff window. Attempts are only made when the clock
    // passes hostRetryAt, so a fixed cadence that never advances would spin
    // here without ever retrying.
    let at = 0
    for (let step = 0; step < 40 && failures < 4; step++) {
      at += 2_000
      source.collect(at)
      await Bun.sleep(0)
    }
    expect(failures).toBeGreaterThanOrEqual(4)

    at += 2_000
    source.collect(at)
    await Bun.sleep(0)
    expect(source.statuses?.()).toEqual([
      expect.objectContaining({ source: "linux-proc", state: "healthy" }),
    ])
  })

  test("merges duplicate PID fields with Electron precedence and no second contribution", () => {
    const preferred = observation(50, "electron", 10, 1_000)
    const fallback = observation(50, "electron", 90, 9_000)
    expect(mergeByProcess([preferred], [fallback])).toEqual([preferred])
  })

  test("does not fill a reused Electron PID from stale platform identity", () => {
    const preferred = observation(50, "new-electron", undefined, undefined)
    const fallback = observation(50, "old-platform", 90, 9_000)
    expect(mergeByProcess([preferred], [fallback])[0]?.point).toEqual(preferred.point)
  })

  test("fills an unavailable Electron field once, then rejects it across PID reuse until resampled", async () => {
    let creation = "electron-old"
    const source = createProcessMetricsSource({
      platform: "linux",
      electron: electron(() => [observation(50, creation, undefined, undefined)]),
      worker: {
        async reconcile() {
          return { entries: [], truncated: false }
        },
        async sample() {
          return [
            {
              pid: 50,
              ppid: 1,
              rootPid: 50,
              creation: { state: "available", value: "linux-start", source: "linux-proc" },
              cpuMachinePercent: 25,
              rssBytes: 8_192,
            },
          ]
        },
        clear() {},
        dispose() {},
      },
    })
    source.collect(0)
    await Bun.sleep(0)
    expect(source.collect(500)[0]?.point.rssBytes).toEqual({ state: "available", value: 8_192 })
    creation = "electron-new"
    expect(source.collect(1_000)[0]?.point.rssBytes).toEqual({ state: "unavailable", reason: "not-sampled" })
    await Bun.sleep(0)
    expect(source.collect(1_500)[0]?.point.rssBytes).toEqual({ state: "unavailable", reason: "not-sampled" })
    await Bun.sleep(0)
    expect(source.collect(2_000)[0]?.point.rssBytes).toEqual({ state: "available", value: 8_192 })
  })

  test("does not invoke the host worker for complete native Electron readings", async () => {
    let samples = 0
    const source = createProcessMetricsSource({
      platform: "linux",
      electron: electron(() => [observation(50, "electron", 1, 1_000)]),
      worker: {
        async reconcile() {
          return { entries: [], truncated: false }
        },
        async sample() {
          samples++
          return []
        },
        async probeCreation() {
          return { state: "unavailable", reason: "identity-unavailable" }
        },
        clear() {},
        dispose() {},
      },
    })

    source.collect(0)
    await Bun.sleep(0)
    expect(samples).toBe(0)
  })

  test("keeps a root registered during reconciliation dirty for the next pass", async () => {
    const reconciliations: number[][] = []
    let resolveTree: ((value: { entries: Array<{ pid: number; ppid: number; rootPid: number }>; truncated: false }) => void) | undefined
    const source = createProcessMetricsSource({
      platform: "linux",
      electron: electron(() => []),
      worker: {
        reconcile(pids) {
          reconciliations.push(pids)
          if (reconciliations.length > 1) {
            return Promise.resolve({
              entries: pids.map((pid) => ({ pid, ppid: 1, rootPid: pid })),
              truncated: false as const,
            })
          }
          return new Promise((resolve) => {
            resolveTree = resolve
          })
        },
        async sample() {
          return []
        },
        async probeCreation() {
          return { state: "unavailable", reason: "identity-unavailable" }
        },
        clear() {},
        dispose() {},
      },
    })
    source.registerRoot(root(50))
    source.collect(0)
    source.registerRoot({ ...root(60), launchId: "launch-60" })
    resolveTree?.({ entries: [{ pid: 50, ppid: 1, rootPid: 50 }], truncated: false })
    await Bun.sleep(0)
    source.collect(500)
    await Bun.sleep(0)

    expect(reconciliations).toEqual([[50], [50, 60]])
  })

  test("maps sampled PPIDs to stable parent process IDs", async () => {
    const source = createProcessMetricsSource({
      platform: "linux",
      electron: electron(() => []),
      worker: {
        async reconcile() {
          return {
            entries: [
              { pid: 50, ppid: 1, rootPid: 50 },
              { pid: 51, ppid: 50, rootPid: 50 },
            ],
            truncated: false,
          }
        },
        async sample(entries) {
          return entries.map((entry) => ({
            ...entry,
            creation: {
              state: "available" as const,
              value: `start-${String(entry.pid)}`,
              source: "linux-proc" as const,
            },
            cpuMachinePercent: 1,
            rssBytes: 1_000,
          }))
        },
        async probeCreation() {
          return { state: "unavailable", reason: "identity-unavailable" }
        },
        clear() {},
        dispose() {},
      },
    })
    source.registerRoot(root(50))
    source.collect(0)
    await Bun.sleep(0)
    const observations = source.collect(500)
    const rootProcess = observations.find((item) => item.process.identity.pid === 50)
    const child = observations.find((item) => item.process.identity.pid === 51)

    expect(child?.process.parentProcessId).toBe(rootProcess?.process.identity.id)
  })

  test("pins exact audited dependencies and Windows-only native packaging", async () => {
    const desktop = await Bun.file(new URL("../../../package.json", import.meta.url)).json()
    const root = await Bun.file(new URL("../../../../../package.json", import.meta.url)).json()
    const builder = await Bun.file(new URL("../../../electron-builder.config.ts", import.meta.url)).text()
    const main = await Bun.file(new URL("../index.ts", import.meta.url)).text()
    expect(desktop.dependencies).toMatchObject({ pidusage: "4.0.1", pidtree: "1.0.0" })
    expect(desktop.optionalDependencies).toEqual({ "@vscode/windows-process-tree": "0.8.0" })
    expect(root.trustedDependencies).toContain("@vscode/windows-process-tree")
    expect(builder).toContain('targetOsArch.startsWith("win32-")')
    // Only Windows includes the native probe; every platform ships nothing
    // beyond the declared native set.
    expect(builder).toContain('...(targetOsArch.startsWith("win32-") ? ["@vscode/windows-process-tree"] : [])')
    expect(builder).toContain("!**/node_modules/**")
    expect(main).toContain('workerPath: join(import.meta.dirname, "process-metrics-worker.js")')
  })

  function electron(collect: () => DiagnosticsObservation[]): ElectronDiagnosticsSource {
    return {
      id: "electron",
      domain: "host",
      accuracy: "native",
      capabilities: { cpu: true, rss: true, ancestry: false, creationIdentity: true, actionIdentity: false },
      collect() {
        electronCallsForProof++
        return collect()
      },
      registerRoot() {
        return () => {}
      },
    }
  }
})

let electronCallsForProof = 0

function root(pid: number) {
  return {
    pid,
    launchId: "launch",
    ownerId: "owner",
    ownerKind: "runtime" as const,
    role: "runtime" as const,
    label: "Runtime",
  }
}

function observation(
  pid: number,
  creation: string,
  cpu: number | undefined,
  rss: number | undefined,
): DiagnosticsObservation {
  const processId = `host:${String(pid)}:${creation}`
  return {
    owner: {
      id: "owner",
      kind: "runtime",
      label: "Runtime",
      access: "local",
      lifecycle: "current",
    },
    process: {
      identity: {
        id: processId,
        domain: "host",
        pid,
        creation: { state: "available", value: creation, source: "electron" },
      },
      ownerId: "owner",
      role: "runtime",
      label: "Runtime",
      lifecycle: "running",
      actionEligibility: { state: "ineligible", reason: "owner-operation-unavailable" },
    },
    point: {
      at: 0,
      processId,
      cpuMachinePercent:
        cpu === undefined ? { state: "unavailable", reason: "not-sampled" } : { state: "available", value: cpu },
      rssBytes:
        rss === undefined ? { state: "unavailable", reason: "not-sampled" } : { state: "available", value: rss },
    },
  }
}
