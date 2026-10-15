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
      time.advance(900)
      await ensure.onMachineReady?.()
      time.advance(1_500)
      await ensure.onImageReady?.()
      time.advance(2_000)
      return target(ensure)
    }]), time)

    expect((await manager.ensure("ws_1", input)).status).toBe("ready")

    expect(timeline(events)).toEqual([["lease_decision", 0], ["provider_ready", 400], ["machine_ready", 900], ["image_ready", 1_500], ["runtime_ready", 2_000]])
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

  test("each phase is on the lease's target as it ends, while the driver is still booting", async () => {
    const time = clock()
    const seen: unknown[] = []
    const read = async () => {
      const current = await manager.target("ws_1")
      seen.push(current.status === "unavailable" ? current.start : current.status)
    }
    const { manager } = compose(scriptedDriver([async (ensure) => {
      await read()
      time.advance(400)
      await ensure.onResource?.({ sandboxId: "sb_1", hostId: "host_ws_1", labels: ensure.labels })
      await read()
      time.advance(1_500)
      await ensure.onImageReady?.()
      await read()
      time.advance(2_000)
      return target(ensure)
    }]), time)
    const requestedAt = time.now()

    expect((await manager.ensure("ws_1", input)).status).toBe("ready")

    const start = { epoch: 1, requestedAt, startedAt: requestedAt, bootMode: "cold-start" }
    expect(seen).toEqual([
      { ...start, markedAt: requestedAt, phases: ["lease_decision"] },
      { ...start, markedAt: requestedAt + 400, phases: ["lease_decision", "provider_ready"] },
      { ...start, markedAt: requestedAt + 1_900, phases: ["lease_decision", "provider_ready", "image_ready"] },
    ])
    const served = await manager.target("ws_1")
    expect(served.status === "unavailable" ? served.start : undefined).toBeUndefined()
  })

  test("a start an epoch continues is on its target before its driver step has ended a phase", async () => {
    const time = clock()
    const seen: unknown[] = []
    const store = createMemoryLeaseStore()
    const { manager } = compose(scriptedDriver([
      async (ensure) => {
        await ensure.onResource?.({ sandboxId: "sb_1", hostId: "host_ws_1", labels: ensure.labels })
        return { provisioning: true, retryAfterMs: 2_000 }
      },
      async (ensure) => {
        const current = await manager.target("ws_1")
        seen.push(current.status === "unavailable" ? current.start?.phases : current.status)
        return target(ensure)
      },
    ]), time, store)
    expect((await manager.ensure("ws_1", input)).status).toBe("provisioning")
    time.advance(2_500)
    expect((await manager.ensure("ws_1", input)).status).toBe("ready")
    expect(seen).toEqual([["lease_decision", "provider_ready"]])
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

  test("a wake times the machine's resume apart from the image it then prepares", async () => {
    const time = clock()
    const resumeHost: SandboxDriver["resumeHost"] = async ({ ensure }) => {
      time.advance(20_000)
      await ensure.onMachineReady?.()
      time.advance(60_000)
      await ensure.onImageReady?.()
      time.advance(3_000)
      return target(ensure)
    }
    const { manager, events } = compose(scriptedDriver([async (ensure) => target(ensure)], resumeHost), time)
    await manager.ensure("ws_1", input)
    expect((await manager.stop("ws_1")).ok).toBe(true)
    events.length = 0

    expect((await manager.ensure("ws_1", input)).status).toBe("ready")

    expect(timeline(events)).toEqual([["lease_decision", 0], ["machine_ready", 20_000], ["image_ready", 60_000], ["runtime_ready", 3_000]])
    expect(events.at(-1)).toMatchObject({ bootMode: "resume", sinceStartMs: 83_000 })
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

    expect(lifecycle.map(({ kind, epoch, ...rest }) => ({
      kind, epoch, activeMs: "activeMs" in rest ? rest.activeMs : undefined, idle: "idle" in rest ? rest.idle : undefined, hostGone: "hostGone" in rest ? rest.hostGone : undefined,
    })))
      .toEqual([
        { kind: "stopped", epoch: 1, activeMs: 13_000, idle: true, hostGone: undefined },
        { kind: "destroyed", epoch: 2, activeMs: 5_700, idle: undefined, hostGone: false },
      ])
    expect(lifecycle[0]).toMatchObject({ workspaceId: "ws_1", driver: "test-driver", labels: { projectId: "prj_1" } })
  })

  test("a provision that fails reports it without a reason text", async () => {
    const time = clock()
    const { manager, lifecycle } = composeLifecycle(scriptedDriver([async () => { throw new Error("provider said no") }]), time)

    expect((await manager.ensure("ws_1", input)).status).toBe("unavailable")

    expect(lifecycle).toEqual([{ workspaceId: "ws_1", epoch: 1, driver: "test-driver", labels: { projectId: "prj_1" }, kind: "failed", bootFailed: false, retrying: true }])
  })
})

describe("a start across the epochs it takes", () => {
  const held = (ensure: SandboxDriverEnsureInput) => ensure.onResource?.({ sandboxId: "sb_held", hostId: "host_ws_1", labels: ensure.labels })
  const resumeAfter = (time: ReturnType<typeof clock>, ms: number): SandboxDriver["resumeHost"] => async ({ ensure }) => {
    time.advance(ms)
    return { ...target(ensure), sandboxId: "sb_held" }
  }
  function composeStart(driver: SandboxDriver, time: ReturnType<typeof clock>, maxRetryCount?: number) {
    const starts: SandboxStartPhaseEvent[] = []
    const lifecycle: SandboxLifecycleEvent[] = []
    const manager = createSandboxManager({
      leaseStore: createMemoryLeaseStore(),
      driver,
      now: time.now,
      ...(maxRetryCount === undefined ? {} : { maxRetryCount }),
      onStartPhase: (event) => starts.push(event),
      onLifecycle: (event) => lifecycle.push(event),
    })
    const served = () => starts.filter((event) => event.phase === "runtime_ready").map((event) => [event.epoch, event.bootMode, event.sinceStartMs])
    const failures = () => lifecycle.filter((event) => event.kind === "failed").map((event) => [event.epoch, "retrying" in event && event.retrying])
    return { manager, starts, lifecycle, served, failures }
  }

  test("a cold start that fails on a held host and serves on the next epoch is one cold start timed from the first request", async () => {
    const time = clock()
    const { manager, served, failures, lifecycle } = composeStart(scriptedDriver([async (ensure) => {
      time.advance(3_000)
      await held(ensure)
      throw new Error("provider said no")
    }], resumeAfter(time, 40_000)), time)

    expect((await manager.ensure("ws_1", input)).status).toBe("unavailable")
    time.advance(2_000)
    expect((await manager.ensure("ws_1", input)).status).toBe("ready")

    expect(failures()).toEqual([[1, true]])
    expect(served()).toEqual([[2, "cold-start", 45_000]])
    time.advance(10_000)
    expect((await manager.stop("ws_1")).ok).toBe(true)
    expect(lifecycle.at(-1)).toMatchObject({ kind: "stopped", epoch: 2, activeMs: 50_000 })
  })

  test("a wake that fails on its first epoch and serves on the next is one wake timed from the first request", async () => {
    const time = clock()
    let resumes = 0
    const resumeHost: SandboxDriver["resumeHost"] = async ({ ensure }) => {
      resumes += 1
      if (resumes === 1) {
        time.advance(5_000)
        throw new Error("provider said no")
      }
      time.advance(30_000)
      return target(ensure)
    }
    const { manager, served, failures } = composeStart(scriptedDriver([async (ensure) => target(ensure)], resumeHost), time)
    await manager.ensure("ws_1", input)
    expect((await manager.stop("ws_1")).ok).toBe(true)

    expect((await manager.ensure("ws_1", input)).status).toBe("unavailable")
    time.advance(2_000)
    expect((await manager.ensure("ws_1", input)).status).toBe("ready")

    expect(failures()).toEqual([[2, true]])
    expect(served().slice(1)).toEqual([[3, "resume", 37_000]])
  })

  test("a boot failure ends the start, and the person's next start of a host that never served is a cold start of its own", async () => {
    const time = clock()
    const bootFailure = Object.assign(new Error("fatal: couldn't find remote ref"), { runtimeBootFailed: true })
    const { manager, served, failures } = composeStart(scriptedDriver([async (ensure) => {
      await held(ensure)
      time.advance(40_000)
      throw bootFailure
    }], resumeAfter(time, 1_000)), time)

    expect((await manager.ensure("ws_1", input)).status).toBe("unavailable")
    time.advance(60_000)
    expect((await manager.ensure("ws_1", input)).status).toBe("ready")

    expect(failures()).toEqual([[1, false]])
    expect(served()).toEqual([[2, "cold-start", 1_000]])
  })

  test("a provider failure that spends the retry budget ends the start", async () => {
    const time = clock()
    const { manager, failures } = composeStart(scriptedDriver([async (ensure) => {
      await held(ensure)
      throw new Error("provider said no")
    }]), time, 1)

    expect((await manager.ensure("ws_1", input)).status).toBe("unavailable")

    expect(failures()).toEqual([[1, false]])
  })
})
