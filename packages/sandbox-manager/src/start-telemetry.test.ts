import { describe, expect, test } from "vitest"
import { createSandboxManager, type SandboxDriver, type SandboxDriverEnsureInput, type SandboxLifecycleEvent, type SandboxStartPhaseEvent } from "."
import { createMemoryLeaseStore } from "./stores/memory"

const input = { homeRegion: "us-east", labels: { projectId: "prj_1" } }

function clock() {
  let at = Date.now()
  return { now: () => at, advance: (ms: number) => { at += ms } }
}

type Step = (input: SandboxDriverEnsureInput) => Promise<Awaited<ReturnType<SandboxDriver["ensureHost"]>>>

function scriptedDriver(steps: Step[], resumeHost?: SandboxDriver["resumeHost"]): SandboxDriver {
  return {
    id: "test-driver",
    ensureHost: async (ensure) => {
      const step = steps.shift()
      if (!step) throw new Error("no scripted step left")
      return await step(ensure)
    },
    ...(resumeHost ? { resumeHost } : {}),
    stop: async () => {},
    metadata: {
      driverRunsIn: ["node"],
      hostStopBehavior: "terminates-host", hostResumeBehavior: "replacement-host",
      targetAccess: "relay",
      secretBrokering: "native",
      egressControl: "hosts-and-cidrs",
      persistence: { resume: "same-sandbox", capture: "none", clone: false, captureSource: "not-applicable", retention: "not-applicable", restoreMount: "not-applicable" },
    },
  }
}

function target(ensure: SandboxDriverEnsureInput) {
  return { sandboxId: `sb_${ensure.epoch}`, url: "https://runtime.test", hostId: `host_${ensure.workspaceId}`, labels: ensure.labels }
}

function compose(driver: SandboxDriver, time: ReturnType<typeof clock>, store = createMemoryLeaseStore()) {
  const events: SandboxStartPhaseEvent[] = []
  const manager = createSandboxManager({ leaseStore: store, driver, now: time.now, onStartPhase: (event) => events.push(event) })
  return { manager, events, store }
}

const timeline = (events: SandboxStartPhaseEvent[]) => events.map((event) => [event.phase, event.durationMs])

describe("sandbox start telemetry", () => {
  test("a cold start emits each phase it observes with its duration and tags", async () => {
    const time = clock()
    const { manager, events } = compose(scriptedDriver([async (ensure) => {
      time.advance(400)
      await ensure.onResource?.({ sandboxId: "sb_1", hostId: "host_ws_1", labels: ensure.labels })
      time.advance(1_500)
      await ensure.onImageReady?.()
      time.advance(2_000)
      return target(ensure)
    }]), time)

    expect((await manager.ensure("ws_1", input)).status).toBe("ready")

    expect(timeline(events)).toEqual([["lease_decision", 0], ["provider_ready", 400], ["image_ready", 1_500], ["runtime_ready", 2_000]])
    expect(events[0]).toMatchObject({ workspaceId: "ws_1", epoch: 1, driver: "test-driver", homeRegion: "us-east", bootMode: "cold-start" })
    expect(events.every((event) => event.labels.projectId === "prj_1")).toBe(true)
  })

  test("a start spread over polls from separately composed managers is timed across them and emitted once per phase", async () => {
    const time = clock()
    const store = createMemoryLeaseStore()
    const steps: Step[] = [
      async (ensure) => {
        time.advance(300)
        await ensure.onResource?.({ sandboxId: "sb_1", hostId: "host_ws_1", labels: ensure.labels })
        return { provisioning: true, retryAfterMs: 2_000 }
      },
      async (ensure) => {
        await ensure.onResource?.({ sandboxId: "sb_1", hostId: "host_ws_1", labels: ensure.labels })
        return target(ensure)
      },
    ]
    const first = compose(scriptedDriver(steps), time, store)
    expect((await first.manager.ensure("ws_1", input)).status).toBe("provisioning")
    time.advance(2_500)
    const second = compose(scriptedDriver(steps), time, store)
    expect((await second.manager.ensure("ws_1", input)).status).toBe("ready")

    expect(timeline(first.events)).toEqual([["lease_decision", 0], ["provider_ready", 300]])
    expect(timeline(second.events)).toEqual([["runtime_ready", 2_500]])
  })

  test("re-ensuring a serving lease is not a start", async () => {
    const time = clock()
    const { manager, events } = compose(scriptedDriver([async (ensure) => target(ensure), async (ensure) => target(ensure)]), time)
    await manager.ensure("ws_1", input)
    events.length = 0
    expect((await manager.ensure("ws_1", input)).status).toBe("ready")
    expect(events).toEqual([])
  })

  test("runtime-timed phases join the epoch's start once, and a report for another epoch is dropped", async () => {
    const time = clock()
    const { manager, events } = compose(scriptedDriver([async (ensure) => target(ensure)]), time)
    await manager.ensure("ws_1", input)
    events.length = 0

    await manager.recordStartPhases("ws_1", { epoch: 2, phases: [{ phase: "repository_checkout", durationMs: 9 }] })
    await manager.recordStartPhases("ws_1", { epoch: 1, phases: [{ phase: "repository_checkout", durationMs: 1_200 }], repoSizeBytes: 4_096 })
    await manager.recordStartPhases("ws_1", { epoch: 1, phases: [{ phase: "repository_checkout", durationMs: 7 }] })

    expect(events).toEqual([expect.objectContaining({ phase: "repository_checkout", durationMs: 1_200, repoSizeBytes: 4_096, epoch: 1, labels: expect.objectContaining({ projectId: "prj_1" }) })])
  })

  test("the first session is timed from runtime readiness, and evidence older than the start records nothing", async () => {
    const time = clock()
    const { manager, events } = compose(scriptedDriver([async (ensure) => target(ensure)]), time)
    const startedAt = time.now()
    await manager.ensure("ws_1", input)
    events.length = 0
    time.advance(5_000)

    await manager.markStartPhase("ws_1", { epoch: 1, phase: "first_session_ready", notBefore: startedAt - 1 })
    expect(events).toEqual([])
    await manager.markStartPhase("ws_1", { epoch: 1, phase: "first_session_ready", notBefore: startedAt })
    time.advance(1_000)
    await manager.markStartPhase("ws_1", { epoch: 1, phase: "first_session_ready", notBefore: time.now() })

    expect(timeline(events)).toEqual([["first_session_ready", 5_000]])
  })

  test("a stopped lease's next ensure is a new epoch with its own start", async () => {
    const time = clock()
    const resumeHost: SandboxDriver["resumeHost"] = async ({ ensure }) => {
      time.advance(700)
      return target(ensure)
    }
    const { manager, events } = compose(scriptedDriver([async (ensure) => target(ensure)], resumeHost), time)
    await manager.ensure("ws_1", input)
    expect((await manager.stop("ws_1")).ok).toBe(true)
    events.length = 0

    expect((await manager.ensure("ws_1", input)).status).toBe("ready")

    expect(events.map((event) => [event.epoch, event.bootMode, event.phase, event.durationMs])).toEqual([
      [2, "resume", "lease_decision", 0],
      [2, "resume", "runtime_ready", 700],
    ])
  })

  test("a sink that throws does not fail the start", async () => {
    const time = clock()
    const manager = createSandboxManager({
      leaseStore: createMemoryLeaseStore(),
      driver: scriptedDriver([async (ensure) => target(ensure)]),
      now: time.now,
      onStartPhase: () => { throw new Error("telemetry down") },
    })
    expect((await manager.ensure("ws_1", input)).status).toBe("ready")
  })
})

describe("sandbox lease lifecycle", () => {
  function composeLifecycle(driver: SandboxDriver, time: ReturnType<typeof clock>) {
    const starts: SandboxStartPhaseEvent[] = []
    const lifecycle: SandboxLifecycleEvent[] = []
    const manager = createSandboxManager({
      leaseStore: createMemoryLeaseStore(),
      driver,
      now: time.now,
      onStartPhase: (event) => starts.push(event),
      onLifecycle: (event) => lifecycle.push(event),
    })
    return { manager, starts, lifecycle }
  }

  test("each boot's stop and destroy carry the machine time since that boot started", async () => {
    const time = clock()
    const resumeHost: SandboxDriver["resumeHost"] = async ({ ensure }) => {
      time.advance(700)
      return target(ensure)
    }
    const { manager, starts, lifecycle } = composeLifecycle(scriptedDriver([async (ensure) => {
      time.advance(3_000)
      return target(ensure)
    }], resumeHost), time)

    await manager.ensure("ws_1", input)
    expect(starts.find((event) => event.phase === "runtime_ready")?.sinceStartMs).toBe(3_000)
    time.advance(10_000)
    expect((await manager.stop("ws_1", { idleBefore: time.now() })).ok).toBe(true)
    expect((await manager.stop("ws_1")).ok).toBe(true)

    await manager.ensure("ws_1", input)
    expect(starts.filter((event) => event.phase === "runtime_ready").map((event) => [event.epoch, event.bootMode, event.sinceStartMs]))
      .toEqual([[1, "cold-start", 3_000], [2, "resume", 700]])
    time.advance(5_000)
    expect((await manager.destroy("ws_1")).ok).toBe(true)

    expect(lifecycle.map(({ kind, epoch, ...rest }) => ({ kind, epoch, activeMs: "activeMs" in rest ? rest.activeMs : undefined, idle: "idle" in rest ? rest.idle : undefined })))
      .toEqual([
        { kind: "stopped", epoch: 1, activeMs: 13_000, idle: true },
        { kind: "destroyed", epoch: 2, activeMs: 5_700, idle: undefined },
      ])
    expect(lifecycle[0]).toMatchObject({ workspaceId: "ws_1", driver: "test-driver", labels: { projectId: "prj_1" } })
  })

  test("a provision that fails reports it without a reason text", async () => {
    const time = clock()
    const { manager, lifecycle } = composeLifecycle(scriptedDriver([async () => { throw new Error("provider said no") }]), time)

    expect((await manager.ensure("ws_1", input)).status).toBe("unavailable")

    expect(lifecycle).toEqual([{ workspaceId: "ws_1", epoch: 1, driver: "test-driver", labels: { projectId: "prj_1" }, kind: "failed", bootFailed: false }])
  })
})
