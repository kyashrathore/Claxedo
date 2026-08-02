import { describe, expect, test } from "bun:test"
import { LocalDiagnostics } from "@claxedo/app/process-diagnostics-contract"
import { EventEmitter } from "node:events"

import {
  aggregateInterval,
  createProfiler,
  type DiagnosticsClock,
  type DiagnosticsObservation,
  type DiagnosticsSource,
} from "./profiler"

class FakeClock implements DiagnosticsClock {
  nowMs = 0
  #nextId = 1
  #timers = new Map<number, { at: number; callback: () => void }>()

  now = () => this.nowMs
  setTimeout = (callback: () => void, delayMs: number) => {
    const id = this.#nextId++
    this.#timers.set(id, { at: this.nowMs + delayMs, callback })
    return id
  }
  clearTimeout = (id: unknown) => {
    this.#timers.delete(Number(id))
  }
  advance(ms: number) {
    const end = this.nowMs + ms
    while (true) {
      const next = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      this.nowMs = next[1].at
      this.#timers.delete(next[0])
      next[1].callback()
    }
    this.nowMs = end
  }
  get timerCount() {
    return this.#timers.size
  }
}

const observation = (
  at: number,
  pid: number,
  creation: string,
  cpu: number,
  rss: number,
  role: LocalDiagnostics.ProcessRole = "main",
  ownerId = "owner-main",
): DiagnosticsObservation => ({
  owner: {
    id: ownerId,
    kind: role === "server" ? "server" : role === "renderer" ? "renderer" : "electron-main",
    label: role === "server" ? "Claxedo server" : role === "renderer" ? "Claxedo window 1" : "Claxedo",
    access: "local",
    lifecycle: "current",
  },
  process: {
    identity: {
      id: `host:${String(pid)}:${creation}`,
      domain: "host",
      pid,
      creation: { state: "available", value: creation, source: "electron" },
    },
    ownerId,
    role,
    label: role === "server" ? "Claxedo server" : role === "renderer" ? "Claxedo window 1" : "Claxedo main",
    lifecycle: "running",
    actionEligibility: { state: "ineligible", reason: "protected-process" },
  },
  point: {
    at,
    processId: `host:${String(pid)}:${creation}`,
    cpuMachinePercent: { state: "available", value: cpu },
    rssBytes: { state: "available", value: rss },
  },
})

function source(collect: DiagnosticsSource["collect"]): DiagnosticsSource {
  return {
    id: "electron",
    domain: "host",
    accuracy: "native",
    capabilities: {
      cpu: true,
      rss: true,
      ancestry: false,
      creationIdentity: true,
      actionIdentity: false,
    },
    collect,
    getStats: () => ({ lastReconciliationDurationMs: 3 }),
  }
}

describe("bounded desktop profiler", () => {
  test("retains an immediate main sample before later startup and renderer markers", async () => {
    const clock = new FakeClock()
    const profiler = createProfiler({
      clock,
      source: source((at) => [observation(at, 10, "1000", at === 0 ? 80 : 1, 1_000)]),
    })
    expect(profiler.getSnapshot().samples[0]).toMatchObject({ at: 0, processId: "host:10:1000" })
    expect(profiler.getStats()).toMatchObject({
      sourceAttempts: 1,
      collections: 1,
      retainedProcesses: 1,
      retainedSamples: 1,
      lastReconciliationDurationMs: 3,
    })

    clock.advance(50)
    profiler.recordLifecycle({ event: "server-starting", ownerId: "owner-server" })
    clock.advance(50)
    profiler.recordLifecycle({ event: "process-appeared", processId: "host:20:2000" })
    const snapshot = profiler.getSnapshot()
    expect(() => LocalDiagnostics.RetainedSnapshot.parse(snapshot)).not.toThrow()
    const serverMarker = snapshot.markers.find(
      (marker) => marker.type === "lifecycle" && marker.event === "server-starting",
    )
    expect(snapshot.samples[0]?.at).toBeLessThan(serverMarker?.at ?? 0)
    expect(snapshot.interval.contributors[0]).toMatchObject({ processId: "host:10:1000" })
    profiler.dispose()
  })

  test("is completion-driven, drops overlapping manual ticks, and changes cadence after startup", async () => {
    const clock = new FakeClock()
    let resolveSlow: ((value: DiagnosticsObservation[]) => void) | undefined
    let calls = 0
    const profiler = createProfiler({
      clock,
      startupIntervalMs: 500,
      startupDurationMs: 1_000,
      steadyIntervalMs: 2_000,
      source: source((at) => {
        calls++
        if (calls === 2) return new Promise((resolve) => (resolveSlow = resolve))
        return [observation(at, 10, "1000", 1, 1_000)]
      }),
    })

    clock.advance(500)
    expect(calls).toBe(2)
    profiler.requestSample("manual")
    expect(profiler.getStats().droppedTicks).toBe(1)
    clock.advance(700)
    resolveSlow?.([observation(clock.now(), 10, "1000", 2, 1_000)])
    await Promise.resolve()
    expect(profiler.getStats().lateTicks).toBe(1)
    expect(clock.timerCount).toBe(1)

    clock.advance(1_999)
    expect(calls).toBe(2)
    clock.advance(1)
    expect(calls).toBe(3)
    profiler.dispose()
  })

  test("moves to the steady cadence once the first window is interactive", () => {
    const clock = new FakeClock()
    let calls = 0
    const profiler = createProfiler({
      clock,
      startupIntervalMs: 500,
      startupDurationMs: 120_000,
      steadyIntervalMs: 2_000,
      source: source((at) => {
        calls++
        return [observation(at, 10, "1000", 1, 1_000)]
      }),
    })

    clock.advance(100)
    profiler.markInteractive()
    clock.advance(1_999)
    expect(calls).toBe(1)
    clock.advance(1)
    expect(calls).toBe(2)
    profiler.dispose()
  })

  test("degrades and recovers a source, while coalescing lifecycle bursts", async () => {
    const clock = new FakeClock()
    let calls = 0
    const profiler = createProfiler({
      clock,
      source: source((at) => {
        calls++
        if (calls === 1) throw new Error("secret raw source failure")
        return [observation(at, 10, "1000", 1, 1_000)]
      }),
    })
    expect(profiler.getSnapshot().sources[0]).toMatchObject({ state: "degraded", reason: "source-failed" })
    profiler.recordLifecycle({ event: "owner-started", ownerId: "owner-a" })
    profiler.recordLifecycle({ event: "owner-started", ownerId: "owner-b" })
    profiler.recordLifecycle({ event: "owner-started", ownerId: "owner-c" })
    clock.advance(0)
    expect(calls).toBe(2)
    const snapshot = profiler.getSnapshot()
    expect(snapshot.sources[0]?.state).toBe("healthy")
    expect(snapshot.markers.map((marker) => marker.type === "lifecycle" && marker.event)).toContain("source-recovered")
    expect(JSON.stringify(snapshot)).not.toContain("secret raw source failure")
    profiler.dispose()
  })

  test("registers a utility once when pid is already assigned and makes its owner historical on exit", () => {
    const clock = new FakeClock()
    let registered:
      | {
          pid: number
          launchId: string
          ownerId: string
        }
      | undefined
    let registrations = 0
    const electronSource = {
      ...source((at) => [
        observation(at, 10, "main", 1, 1_000),
        ...(registered
          ? [
              {
                ...observation(at, registered.pid, "server", 20, 5_000, "server", registered.ownerId),
                owner: {
                  id: registered.ownerId,
                  kind: "server" as const,
                  label: "Claxedo server",
                  launchId: registered.launchId,
                  access: "local" as const,
                  lifecycle: "current" as const,
                },
                process: {
                  ...observation(at, registered.pid, "server", 20, 5_000, "server", registered.ownerId).process,
                  identity: {
                    ...observation(at, registered.pid, "server", 20, 5_000, "server", registered.ownerId).process
                      .identity,
                    launchId: registered.launchId,
                  },
                },
              },
            ]
          : []),
      ]),
      registerRoot(root: typeof registered & { pid: number; launchId: string; ownerId: string }) {
        registrations++
        registered = root
        return () => {
          registered = undefined
        }
      },
    }
    const profiler = createProfiler({ clock, source: electronSource })
    const utility = new EventEmitter() as EventEmitter & { pid: number }
    utility.pid = 50
    profiler.registerUtilityProcess(utility, {
      launchId: "server-launch",
      ownerId: "owner-server",
      ownerKind: "server",
      role: "server",
      label: "Claxedo server",
    })
    utility.emit("spawn")
    clock.advance(0)
    expect(registrations).toBe(1)
    expect(
      profiler
        .getSnapshot()
        .markers.filter((marker) => marker.type === "lifecycle" && marker.event === "server-starting"),
    ).toHaveLength(1)

    utility.emit("exit", 0)
    const snapshot = profiler.getSnapshot()
    expect(snapshot.owners.find((owner) => owner.id === "owner-server")?.lifecycle).toBe("historical")
    expect(snapshot.processes.find((process) => process.identity.launchId === "server-launch")?.lifecycle).toBe(
      "exited",
    )
    profiler.dispose()
  })

  test("binds accepted child owner events to platform roots and retained churn", () => {
    const clock = new FakeClock()
    const roots: number[] = []
    const removed: number[] = []
    const profiler = createProfiler({
      clock,
      source: {
        ...source(() => []),
        registerRoot(root) {
          roots.push(root.pid)
          return () => removed.push(root.pid)
        },
      },
    })
    const binding = { pid: 50, launchId: "server-launch", generation: "server-generation" }
    profiler.recordOwnerEvent({
      type: "owner-registered",
      at: 0,
      binding,
      descriptor: {
        ownerId: "pty-1",
        ownerGeneration: "owner-generation",
        ownerOperationId: "owner-operation",
        launchId: "pty-launch",
        kind: "pty",
        role: "pty",
        label: "Terminal",
        pid: 75,
        workspaceId: "workspace-1",
        directory: "/tmp/workspace",
        capabilities: { stopGracefully: true, killOwnedTree: false },
      },
    })
    clock.advance(25)
    profiler.recordOwnerEvent({
      type: "owner-exited",
      at: 25,
      binding,
      ownerId: "pty-1",
      ownerGeneration: "owner-generation",
      reason: "exited",
      exitCode: 0,
      observedLifetimeMs: 25,
    })

    expect(roots).toEqual([75])
    expect(removed).toEqual([75])
    expect(profiler.getSnapshot().owners).toContainEqual(
      expect.objectContaining({ id: "pty-1", lifecycle: "historical", workspaceId: "workspace-1" }),
    )
    expect(profiler.getSnapshot().markers).toContainEqual(
      expect.objectContaining({
        type: "churn",
        ownerId: "pty-1",
        launched: 1,
        exited: 1,
        resourceMeasurement: { state: "unmeasured", reason: "not-sampled" },
      }),
    )
    profiler.dispose()
  })

  test("registers a sampling root when a PID arrives after owner registration", () => {
    const roots: number[] = []
    const profiler = createProfiler({
      clock: new FakeClock(),
      source: {
        ...source(() => []),
        registerRoot(root) {
          roots.push(root.pid)
          return () => undefined
        },
      },
    })
    const binding = { pid: 50, launchId: "server-launch", generation: "server-generation" }
    profiler.recordOwnerEvent({
      type: "owner-registered",
      at: 0,
      binding,
      descriptor: {
        ownerId: "managed-delayed",
        ownerGeneration: "owner-generation",
        ownerOperationId: "owner-operation",
        launchId: "managed-launch",
        kind: "managed-process",
        role: "managed-process",
        label: "Managed process",
        capabilities: { stopGracefully: true, killOwnedTree: true },
      },
    })
    profiler.recordOwnerEvent({
      type: "owner-updated",
      at: 1,
      binding,
      ownerId: "managed-delayed",
      ownerGeneration: "owner-generation",
      pid: 91,
      lifecycle: "ready",
    })

    expect(roots).toEqual([91])
    profiler.dispose()
  })

  test("publishes guarded owner grants and records the revalidated action outcome", async () => {
    const clock = new FakeClock()
    const ownerId = "pty-action"
    const launchId = "pty-action-launch"
    const identity = {
      id: "host:75:900",
      domain: "host" as const,
      pid: 75,
      creation: { state: "available" as const, value: "900", source: "linux-proc" as const },
      launchId,
    }
    const invoked: LocalDiagnostics.ActionKind[] = []
    const profiler = createProfiler({
      clock,
      actionToken: (() => {
        let sequence = 0
        return () => `opaque-profiler-action-token-${String(++sequence)}`
      })(),
      source: {
        ...source((at) => [{
          owner: {
            id: ownerId,
            kind: "pty",
            label: "Terminal",
            launchId,
            access: "local",
            lifecycle: "current",
          },
          process: {
            identity,
            ownerId,
            role: "pty",
            label: "Terminal",
            lifecycle: "running",
            actionEligibility: { state: "ineligible", reason: "owner-operation-unavailable" },
          },
          point: {
            at,
            processId: identity.id,
            cpuMachinePercent: { state: "available", value: 1 },
            rssBytes: { state: "available", value: 1_000 },
          },
        }]),
        registerRoot: () => () => undefined,
        revalidateIdentity: async (current) => current.id === identity.id,
      },
    })
    profiler.recordOwnerEvent({
      type: "owner-registered",
      at: 0,
      binding: { pid: 50, launchId: "server-launch", generation: "server-generation" },
      descriptor: {
        ownerId,
        ownerGeneration: "owner-generation",
        ownerOperationId: "owner-operation",
        launchId,
        kind: "pty",
        role: "pty",
        label: "Terminal",
        pid: 75,
        capabilities: { stopGracefully: true, killOwnedTree: true },
      },
    }, async (request) => {
      invoked.push(request.action)
      return "completed"
    })
    profiler.requestSample("manual")
    const process = profiler.getSnapshot().processes.find((current) => current.ownerId === ownerId)
    expect(process?.actionEligibility.state).toBe("eligible")
    if (!process || process.actionEligibility.state !== "eligible") throw new Error("expected action grant")
    const prepared = profiler.prepareAction({
      action: "stop",
      token: process.actionEligibility.actions.find((grant) => grant.action === "stop")!.token,
    })
    expect(prepared.ok).toBeTrue()
    if (!prepared.ok) throw new Error("expected action claim")
    expect(await profiler.executeAction(prepared.claim)).toMatchObject({ ok: true, action: "stop" })
    expect(invoked).toEqual(["stop"])
    expect(profiler.getSnapshot().markers).toContainEqual(
      expect.objectContaining({
        type: "lifecycle",
        event: "action-completed",
        ownerId,
        action: "stop",
        outcome: "succeeded",
      }),
    )
    profiler.dispose()
  })

  test("evicts by target window and hard byte cap and reports the actual retained start", () => {
    const clock = new FakeClock()
    const profiler = createProfiler({
      clock,
      targetWindowMs: 1_000,
      maxBytes: 5_000,
      startupIntervalMs: 100,
      startupDurationMs: 10_000,
      source: source((at) =>
        Array.from({ length: 8 }, (_, index) =>
          observation(at, 100 + index, `creation-${String(index)}`, index + 1, 1_000 + index),
        ),
      ),
    })
    clock.advance(2_000)
    const snapshot = profiler.getSnapshot()
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(5_000)
    expect(snapshot.retainedFromAt).toBeGreaterThan(0)
    expect(snapshot.retention).toEqual({ state: "truncated", reason: "memory-pressure" })
    profiler.dispose()
  })

  test("creates a new series on PID reuse and keeps a server utility separate", () => {
    const clock = new FakeClock()
    let creation = "old"
    const profiler = createProfiler({
      clock,
      source: source((at) => [
        observation(at, 10, "main", 1, 1_000),
        observation(at, 50, creation, 10, 5_000, creation === "server" ? "server" : "renderer"),
      ]),
    })
    creation = "server"
    clock.advance(500)
    const snapshot = profiler.getSnapshot()
    expect(
      snapshot.processes.filter((process) => process.identity.pid === 50).map((process) => process.lifecycle),
    ).toEqual(["exited", "running"])
    expect(snapshot.interval.contributors.map((item) => item.processId)).toContain("host:50:server")
    profiler.dispose()
  })

  test("interval aggregation merges duplicate process points and ranks a startup spike", () => {
    const main = observation(0, 10, "main", 90, 2_000)
    const duplicate = {
      ...main,
      point: { ...main.point, cpuMachinePercent: { state: "available" as const, value: 90 } },
    }
    const renderer = observation(0, 20, "renderer", 10, 1_000, "renderer", "owner-renderer")
    const summary = aggregateInterval({
      startAt: 0,
      endAt: 0,
      samples: [main.point, duplicate.point, renderer.point],
      processes: [main.process, renderer.process],
      markers: [],
    })
    expect(summary.totals.currentCpuMachinePercent).toEqual({ state: "available", value: 100 })
    expect(summary.contributors[0]).toMatchObject({
      processId: "host:10:main",
      peakCpuMachinePercent: { state: "available", value: 90 },
      cpuSharePercent: { state: "available", value: 90 },
    })
  })

  test("keeps totals and shares unavailable when any contributing reading is missing", () => {
    const main = observation(0, 10, "main", 90, 2_000)
    const renderer = observation(0, 20, "renderer", 10, 1_000, "renderer", "owner-renderer")
    const summary = aggregateInterval({
      startAt: 0,
      endAt: 0,
      samples: [
        main.point,
        {
          ...renderer.point,
          cpuMachinePercent: { state: "unavailable", reason: "not-sampled" },
          rssBytes: { state: "unavailable", reason: "not-sampled" },
        },
      ],
      processes: [main.process, renderer.process],
      markers: [],
    })

    expect(summary.totals.currentCpuMachinePercent).toEqual({
      state: "unavailable",
      reason: "not-sampled",
    })
    expect(summary.totals.currentRssBytes).toEqual({ state: "unavailable", reason: "not-sampled" })
    expect(summary.contributors.every((item) => item.cpuSharePercent.state === "unavailable")).toBeTrue()
  })

  test("removes a throwing subscriber without stopping periodic collection", () => {
    const clock = new FakeClock()
    let calls = 0
    const profiler = createProfiler({
      clock,
      source: source((at) => {
        calls++
        return [observation(at, 10, "main", 1, 1_000)]
      }),
    })
    profiler.subscribe(() => {
      throw new Error("renderer disappeared")
    })

    clock.advance(500)
    clock.advance(500)

    expect(calls).toBe(3)
    expect(clock.timerCount).toBe(1)
    profiler.dispose()
  })

  test("disposal cancels timers and ignores late source completion", async () => {
    const clock = new FakeClock()
    let resolveSlow: ((value: DiagnosticsObservation[]) => void) | undefined
    const profiler = createProfiler({
      clock,
      source: source(() => new Promise((resolve) => (resolveSlow = resolve))),
    })
    profiler.dispose()
    resolveSlow?.([observation(100, 10, "main", 1, 1_000)])
    await Promise.resolve()
    expect(profiler.getSnapshot().samples).toEqual([])
    expect(clock.timerCount).toBe(0)
  })

  test("retains independent platform degradation and recovery markers", () => {
    const clock = new FakeClock()
    let platform: LocalDiagnostics.SourceStatus = {
      source: "linux-proc",
      domain: "host",
      accuracy: "estimated",
      capabilities: { cpu: true, rss: true, ancestry: true, creationIdentity: true, actionIdentity: true },
      state: "warming-up",
    }
    const electron = {
      ...source((at) => [observation(at, 10, "main", 1, 1_000)]),
      statuses: () => [platform],
    }
    const profiler = createProfiler({ clock, source: electron })
    platform = {
      ...platform,
      state: "degraded",
      reason: "source-failed",
    }
    profiler.requestSample()
    platform = {
      source: "linux-proc",
      domain: "host",
      accuracy: "estimated",
      capabilities: { cpu: true, rss: true, ancestry: true, creationIdentity: true, actionIdentity: true },
      state: "healthy",
      lastSuccessAt: 1,
    }
    profiler.requestSample()
    expect(
      profiler
        .getSnapshot()
        .markers.filter((marker) => marker.type === "lifecycle")
        .map((marker) => marker.event),
    ).toEqual(expect.arrayContaining(["source-degraded", "source-recovered"]))
    profiler.dispose()
  })
})
