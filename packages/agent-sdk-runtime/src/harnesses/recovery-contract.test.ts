import { describe, expect, test } from "bun:test"
import type {  SupportsCancel } from "../adapter-contract"
import type { CleanupFact } from "@claxedo/agent-runtime-contract"
import { AcpHarnessAdapter } from "./acp/index"
import { cancelAcpTurn } from "./acp/cancellation"
import { ClaudeHarnessAdapter } from "./claude/index"
import { CodexHarnessAdapter } from "./codex/index"
import { CursorHarnessAdapter } from "./cursor/index"
import { PiHarnessAdapter } from "./pi/index"
import { createClaudeSdkDriver } from "./claude/driver"
import { createCodexAppServerDriver } from "./codex/driver"
import { createCursorSdkDriver } from "./cursor/driver"
import { createTurnStop, createTurnStopRecord, type TurnStopRecord } from "./shared/cancellation-facts"
import { cancelSdkRuntimeTurn, stoppedWaiting } from "./shared/sdk-runtime-cancellation"
import { createSessionTurnLifecycle } from "./shared/turn-lifecycle"
import type { ActiveTurn, SdkRuntimeDriver, SdkRuntimeDriverHost } from "./shared/sdk-runtime-driver"
import type { ACPProcess } from "./acp/process"
import type { PermissionReplyPort } from "./acp/permission-reply"
import type { WithInternals } from "../test-utils/class-internals"
import { SdkRuntimeInteractions } from "./shared/sdk-runtime-interactions"
import { createMemoryRuntimeStore } from "../stores/memory"
import { createAgentRuntime, type AgentHarnessFactory } from "../runtime"
import { createRuntimeEventHub } from "../runtime-event-hub"
import { acp } from "../harness-factories/acp"
import { claude } from "../harness-factories/claude"
import { codex } from "../harness-factories/codex"
import { cursor } from "../harness-factories/cursor"
import { pi } from "../harness-factories/pi"
import { rm } from "node:fs/promises"
import { installFakeCodexAppServer } from "../test-utils/fake-codex-app-server"
import { cancelAdapterTurn } from "../test-utils/cancel-turn"
import { installFakePiRpc } from "../test-utils/fake-pi-rpc.mjs"
import { executeTestTurn, executionBinding } from "../test-utils/execution-binding"
import { questionAsked } from "../compat-events"

/**
 * What each harness can actually establish about a turn it was asked to stop.
 *
 * `cleanupBest` is a CEILING, not a promise: a harness reaches it only when its
 * own evidence allows, and `evidence` names the reading that produces it. The
 * rule the whole table obeys is that an empty process group never earns
 * `verified_clear` — a descendant that called `setsid` has left the group and
 * neither macOS nor Linux offers an enumeration that would find it again. Only
 * an authoritative inventory of the turn's own resources, read back empty, does.
 */
type RecoveryCapabilityRow = {
  harness: string
  cancel: "supported" | "ack-only" | "unsupported"
  /** Whether the harness answers a question about a turn's state, not just about its transport. */
  query: boolean
  retire: "process" | "sdk-hook" | "none"
  cleanupBest: CleanupFact
  evidence: string
}

const MATRIX: readonly RecoveryCapabilityRow[] = [
  {
    harness: "codex",
    cancel: "supported",
    query: true,
    retire: "process",
    cleanupBest: "verified_clear",
    evidence: "thread/backgroundTerminals/list is Codex's own inventory of what the turn started; read back without the turn's processes it is proof, and the shared app-server is harness-owned so it does not count against the turn",
  },
  {
    harness: "claude",
    cancel: "supported",
    query: false,
    retire: "sdk-hook",
    cleanupBest: "owned",
    evidence: "the CLI leads a group this driver retires, but the group is not an inventory: a surviving member reads as owned and an empty one proves nothing",
  },
  {
    harness: "cursor",
    cancel: "supported",
    query: false,
    retire: "none",
    cleanupBest: "unknown",
    evidence: "the Cursor SDK hands back no process handle and enumerates nothing a run started",
  },
  {
    harness: "pi",
    cancel: "supported",
    query: true,
    retire: "process",
    cleanupBest: "owned",
    evidence: "a refused abort escalates to retiring the launch, whose group is containment rather than an inventory",
  },
  {
    harness: "acp",
    cancel: "ack-only",
    query: false,
    retire: "process",
    cleanupBest: "unknown",
    evidence: "ACP's cancel is a notification and the agent runs its tools itself, publishing no inventory of them",
  },
]

/**
 * The OpenCode rows live here as the contract, and are exercised where their
 * adapters do: `workspace-runtime/src/opencode/harness-adapter.test.ts` for the
 * embedded engine, `opencode-server-adapter/src/adapter.test.ts` for a
 * configured external one. Importing either here would point this package at a
 * consumer.
 */
const OPENCODE_ROWS: readonly RecoveryCapabilityRow[] = [
  {
    harness: "opencode-embedded",
    cancel: "supported",
    query: true,
    retire: "none",
    cleanupBest: "unknown",
    evidence: "the engine's own terminal event for the session is the execution evidence; it runs tools in process and publishes no inventory of them",
  },
  {
    harness: "opencode-external",
    cancel: "ack-only",
    query: false,
    retire: "none",
    cleanupBest: "unknown",
    evidence: "an HTTP 200 accepts the request; the adapter can reach the engine but does not own it",
  },
]

function driverFor(type: "claude" | "codex" | "cursor"): SdkRuntimeDriver {
  const host = {
    lifecycle: () => ({ set() {}, delete() {}, get() {}, activeTurns: new Map() }),
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    bindSession() {},
  } as unknown as SdkRuntimeDriverHost
  if (type === "claude") return createClaudeSdkDriver(host)
  if (type === "cursor") return createCursorSdkDriver(host)
  return createCodexAppServerDriver(host)
}

function adapterFor(harness: string): Partial<SupportsCancel> {
  if (harness === "acp") return Object.create(AcpHarnessAdapter.prototype) as AcpHarnessAdapter
  if (harness === "pi") return Object.create(PiHarnessAdapter.prototype) as PiHarnessAdapter
  const Adapter = harness === "claude" ? ClaudeHarnessAdapter : harness === "cursor" ? CursorHarnessAdapter : CodexHarnessAdapter
  const adapter = Object.create(Adapter.prototype) as WithInternals<CodexHarnessAdapter, { driver: SdkRuntimeDriver }>
  adapter.driver = driverFor(harness as "claude" | "codex" | "cursor")
  return adapter
}

const NOW_PLUS = (ms: number) => Date.now() + ms

function deadline(ms = 5_000) {
  return {
    turnId: "msg_turn",
    assistantMessageId: "asst_turn",
    signal: new AbortController().signal,
    deadlineAt: NOW_PLUS(ms),
  }
}

/**
 * One session running a turn on the production lifecycle, with the driver's own
 * stop behaviour injected. This is the real owner every SDK-backed harness
 * cancels through, so what it answers is what those adapters answer.
 */
function sdkSession(input: {
  stop: () => Promise<void>
  /** Leaves the producer's busy section; a turn that never calls it is still running. */
  autoLeave?: boolean
  cleanup?: CleanupFact
}) {
  const lifecycle = createSessionTurnLifecycle<ActiveTurn>()
  const leave = lifecycle.enter("s1")!
  const stops: TurnStopRecord = createTurnStopRecord()
  if (input.cleanup) stops.cleanup = input.cleanup
  const abort = new AbortController()
  const stop = createTurnStop(stops, "provider_unreachable", async () => {
    await input.stop()
    if (input.autoLeave !== false) leave()
  })
  abort.signal.addEventListener("abort", () => { void stop() }, { once: true })
  lifecycle.set("s1", { abort, close: stop, stops })
  return { lifecycle, stops, leave }
}

function acpPorts(overrides: Partial<Parameters<typeof cancelAcpTurn>[0]> = {}) {
  const proc = {
    alive: true,
    transportKind: "stdio" as const,
    pendingPermissions: new Map(),
    cancelAndWait: async () => {},
    respondPermission() {},
  } as unknown as ACPProcess
  return {
    sessionId: "s1",
    agentSessionId: "agent-1",
    proc,
    permissions: { commit() {} } as unknown as PermissionReplyPort,
    whenIdle: async () => {},
    hasActiveTurn: () => false,
    markInterrupted() {},
    log() {},
    ...overrides,
  }
}

describe("per-harness recovery capability matrix", () => {
  test("every row names a cleanup ceiling its evidence can actually reach", () => {
    for (const row of [...MATRIX, ...OPENCODE_ROWS]) {
      expect(row.evidence.length, `${row.harness} must say what produces ${row.cleanupBest}`).toBeGreaterThan(30)
      // A group is containment, never an inventory. Only a harness whose own
      // records list the turn's resources may claim they are gone.
      if (row.cleanupBest === "verified_clear") {
        expect(row.query, `${row.harness} claims verified_clear without an inventory to read`).toBe(true)
      }
      if (row.retire === "none") {
        expect(row.cleanupBest, `${row.harness} owns no process, so it cannot report owned resources`).toBe("unknown")
      }
    }
  })

  test("a harness implements cancelTurn exactly when the matrix says it can be asked", () => {
    for (const row of MATRIX) {
      const implemented = typeof adapterFor(row.harness).cancelTurn === "function"
      expect(implemented, `${row.harness} cancelTurn presence`).toBe(row.cancel !== "unsupported")
    }
  })

  /** How much a cleanup fact claims. A harness may never report above its row. */
  const CLEANUP_RANK: Record<CleanupFact, number> = { unknown: 0, owned: 1, verified_clear: 2 }

  test("Codex is the only harness whose real cancel path can reach verified_clear", async () => {
    // Driven through the real adapter and its real app-server protocol: the
    // ceiling is a claim about what that protocol can establish, so a literal
    // in the table would only be asserting itself.
    const fake = await installFakeCodexAppServer({ command: true })
    const adapter = new CodexHarnessAdapter({
      binary: fake.binary,
      store: createMemoryRuntimeStore(),
      codexHome: `${fake.directory}/codex-home`,
    })
    try {
      const session = await adapter.createSession(fake.directory)
      let started!: () => void
      const running = new Promise<void>((resolve) => { started = resolve })
      const turn = (async () => {
        for await (const event of executeTestTurn(adapter, session.id, {
          parts: [{ type: "text", text: "Run a command" }],
          userMessageId: "user-1",
          assistantMessageId: "assistant-1",
          agent: "build",
          model: { providerID: "codex", modelID: "default" },
        }, fake.directory)) {
          if (JSON.stringify(event).includes("cmd-current")) started()
        }
      })()
      await running
      const outcome = await cancelAdapterTurn(adapter, executionBinding(session.id, fake.directory, "native:codex"))
      await turn

      const codex = MATRIX.find((row) => row.harness === "codex")!
      expect(CLEANUP_RANK[outcome.cleanup]).toBeLessThanOrEqual(CLEANUP_RANK[codex.cleanupBest])
      // And it actually reaches it, which is what makes the row meaningful.
      expect(outcome.cleanup).toBe(codex.cleanupBest)
      // Every other row claims less, because no other harness publishes an
      // inventory of what its turn started.
      for (const row of MATRIX) {
        if (row.harness === "codex") continue
        expect(row.cleanupBest, `${row.harness} must not claim verified_clear`).not.toBe("verified_clear")
      }
    } finally {
      await adapter.dispose()
      await rm(fake.directory, { recursive: true, force: true })
    }
  })

  test("ACP's real cancel path never reports cleanup above its row", async () => {
    const acp = MATRIX.find((row) => row.harness === "acp")!
    const outcomes = [
      await cancelAcpTurn(acpPorts(), deadline()),
      await cancelAcpTurn(acpPorts({ proc: undefined }), deadline()),
      await cancelAcpTurn(acpPorts({ whenIdle: () => new Promise<void>(() => {}) }), deadline(20)),
    ]
    for (const outcome of outcomes) {
      expect(CLEANUP_RANK[outcome.cleanup]).toBeLessThanOrEqual(CLEANUP_RANK[acp.cleanupBest])
    }
  })

  test("a provider that never answers the interrupt is bounded, and is never reported terminal", async () => {
    const session = sdkSession({ stop: () => new Promise<void>(() => {}) })
    const outcome = await cancelSdkRuntimeTurn(session.lifecycle, "codex", "s1", deadline(40))
    expect(outcome).toMatchObject({
      execution: "running",
      cleanup: "unknown",
      error: { code: "cancellation_timeout" },
    })
  })

  test("a cancel that rejects while the stream is still open reports the provider's error, not a stopped turn", async () => {
    const session = sdkSession({
      stop: () => Promise.reject(new Error("cursor refused the cancel")),
      autoLeave: false,
    })
    const outcome = await cancelSdkRuntimeTurn(session.lifecycle, "cursor", "s1", deadline(40))
    expect(outcome).toMatchObject({
      execution: "running",
      cleanup: "unknown",
      error: { code: "provider_unreachable", message: "cursor refused the cancel" },
    })
  })

  test("a producer that left after a cancel the provider refused is unknown, never terminal", async () => {
    const session = sdkSession({ stop: () => Promise.reject(new Error("pi refused the abort")) })
    // The producer leaves anyway: a clean-looking exit over a cancellation the
    // provider never accepted.
    session.leave()
    const outcome = await cancelSdkRuntimeTurn(session.lifecycle, "pi", "s1", deadline())
    expect(outcome).toMatchObject({
      execution: "unknown",
      error: { code: "provider_unreachable", message: "pi refused the abort" },
    })
  })

  test("a turn whose owner retired live resources reports them as owned", async () => {
    const session = sdkSession({
      stop: () => Promise.reject(new Error("terminal cleanup failed")),
      cleanup: "owned",
    })
    session.leave()
    const outcome = await cancelSdkRuntimeTurn(session.lifecycle, "codex", "s1", deadline())
    expect(outcome.cleanup).toBe("owned")
    expect(outcome.execution).toBe("unknown")
  })

  test("a harness with no local turn refuses to claim anything about it", async () => {
    const lifecycle = createSessionTurnLifecycle<ActiveTurn>()
    expect(await cancelSdkRuntimeTurn(lifecycle, "claude", "s1", deadline())).toEqual({
      execution: "unknown",
      cleanup: "unknown",
    })
  })

  test("stopping one session's turn leaves another session's turn running", async () => {
    const lifecycle = createSessionTurnLifecycle<ActiveTurn>()
    const leaveA = lifecycle.enter("a")!
    const leaveB = lifecycle.enter("b")!
    lifecycle.set("a", { abort: new AbortController(), close: () => { leaveA() } })
    lifecycle.set("b", { abort: new AbortController(), close: () => { leaveB() } })

    expect(await cancelSdkRuntimeTurn(lifecycle, "codex", "a", deadline())).toMatchObject({ execution: "terminal" })
    expect(lifecycle.busySessions.has("b")).toBe(true)
    expect(lifecycle.get("b")?.abort?.signal.aborted).toBe(false)
  })

  test("an ACP agent that acknowledges the cancel is terminal only over a local transport", async () => {
    expect(await cancelAcpTurn(acpPorts(), deadline())).toEqual({ execution: "terminal", cleanup: "unknown" })

    const remote = acpPorts({
      proc: { alive: true, transportKind: "websocket", pendingPermissions: new Map(), cancelAndWait: async () => {}, respondPermission() {} } as unknown as ACPProcess,
    })
    expect(await cancelAcpTurn(remote, deadline())).toMatchObject({
      execution: "unknown",
      cleanup: "unknown",
      error: { code: "provider_unreachable" },
    })
  })

  test("an ACP prompt that never settles after the acknowledgement is bounded", async () => {
    const ports = acpPorts({ whenIdle: () => new Promise<void>(() => {}) })
    expect(await cancelAcpTurn(ports, deadline(40))).toMatchObject({
      execution: "running",
      error: { code: "cancellation_timeout" },
    })
  })

  test("an ACP session whose process is gone reports that, never a stopped turn", async () => {
    let interrupted: string | undefined
    const ports = acpPorts({
      proc: undefined,
      markInterrupted: (message: string) => { interrupted = message },
    })
    expect(await cancelAcpTurn(ports, deadline())).toMatchObject({
      execution: "unknown",
      error: { code: "provider_unreachable" },
    })
    expect(interrupted).toContain("no longer alive")
  })

  test("a transient cancellation failure does not poison the retry", async () => {
    const stops = createTurnStopRecord()
    let attempts = 0
    const stop = createTurnStop(stops, "provider_unreachable", async () => {
      attempts++
      if (attempts === 1) throw new Error("first attempt lost the connection")
    })
    await expect(stop()).rejects.toThrow("first attempt lost the connection")
    await stop()
    expect(attempts).toBe(2)
    // The newest attempt succeeded, so no failure is reported for this turn.
    expect(stops.attempts.at(-1)?.failure).toBeUndefined()

    // A stop that already succeeded is not replayed at the provider.
    await stop()
    expect(attempts).toBe(2)
  })

  test("a concurrent second stop joins the attempt in flight rather than starting another", async () => {
    const stops = createTurnStopRecord()
    let attempts = 0
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const stop = createTurnStop(stops, "provider_unreachable", async () => { attempts++; await held })
    const first = stop()
    const second = stop()
    expect(first).toBe(second)
    release()
    await first
    expect(attempts).toBe(1)
  })

  test("a late answer from an old turn is refused and reported to the session's owner", () => {
    const store = createMemoryRuntimeStore()
    const failures: Array<{ sessionId: string; error: unknown }> = []
    let generation: object | undefined = {}
    const interactions = new SdkRuntimeInteractions(store, {
      generationOf: () => generation,
      reportOwnerFailure: (sessionId, error) => failures.push({ sessionId, error }),
    })
    const session = "s1"
    store.bindSession({ sessionId: session, directory: "/work", agentSessionId: "agent-1" })
    let decided: string | undefined
    interactions.permissions.set("perm-1", {
      sessionId: session,
      agentSessionId: "agent-1",
      method: "requestPermission",
      params: {},
      resolve: (decision) => { decided = decision },
    })

    // The turn that raised it ends and the session is admitted to another.
    generation = {}
    expect(() => interactions.respondPermission(
      { workspaceId: "ws", directory: "/work", sessionId: session, connectionId: "native:codex", upstreamSessionId: session },
      "perm-1",
      "allow_once",
    )).toThrow("no longer running")
    // The provider's continuation is untouched: answering it would resolve a
    // callback belonging to a turn that is over.
    expect(decided).toBeUndefined()
    expect(failures).toHaveLength(1)
    expect(failures[0].sessionId).toBe(session)
  })

  test("an interaction the store could not project reaches the session's owner, not only its caller", () => {
    const store = createMemoryRuntimeStore()
    const failures: unknown[] = []
    const generation = {}
    // A proxy, not a spread: the store is a class instance and its methods
    // live on the prototype, so a spread would hand over an empty object.
    const unwritable = new Proxy(store, {
      get: (target, key, receiver) => key === "appendEvent"
        ? () => { throw new Error("journal is unavailable") }
        : Reflect.get(target, key, receiver),
    })
    const interactions = new SdkRuntimeInteractions(unwritable, {
      generationOf: () => generation,
      reportOwnerFailure: (_sessionId, error) => failures.push(error),
    })
    const session = "s2"
    store.bindSession({ sessionId: session, directory: "/work", agentSessionId: "agent-1" })
    interactions.questions.set("q-1", {
      sessionId: session,
      agentSessionId: "agent-1",
      questions: [],
      resolve() {},
      reject() {},
    })
    store.appendEvent({
      sessionId: session,
      agentSessionId: "agent-1",
      payload: questionAsked({ id: "q-1", sessionID: session, questions: [] }),
      source: { dir: "in", method: "question.asked" },
    })

    expect(() => interactions.replyQuestion(
      { workspaceId: "ws", directory: "/work", sessionId: session, connectionId: "native:codex", upstreamSessionId: session },
      "q-1",
      [],
    )).toThrow("journal is unavailable")
    expect(failures).toHaveLength(1)
  })

  test("a failure an adapter reports about a session reaches that session's recovery inspection", async () => {
    // The seam under test is the wiring, not a local array: an adapter's
    // report has to arrive at the runtime the product actually builds.
    let report!: (sessionId: string, error: unknown) => void
    const adapter = {
      instructionChannel: "none",
      async getSession() { return null },
      async createSession(_d: unknown, _t: unknown, id?: string) { return { id: id ?? "ses_test" } },
      async updateSession() { return null },
      async getSessionConfig() { return { harness: { id: "pi", access: "native" }, variant: null, agent: "build" } },
      async updateSessionConfig() { return { harness: { id: "pi", access: "native" }, variant: null, agent: null } },
      async deleteSession() {},
      readHarnessCapabilities: () => ({}) as never,
      executeTurn() { return (async function* () {})() },
      async getMessages() { return [] },
      dispose() {},
    } as unknown as import("../adapter-contract").AgentHarnessAdapter

    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [{
        id: "pi",
        access: "native",
        create: (context: { reportOwnerFailure: (sessionId: string, error: unknown) => void }) => {
          report = context.reportOwnerFailure
          return adapter
        },
      } as never],
    })
    const created = await runtime.sessions.create({
      id: "ses_1",
      workspaceId: "ws",
      directory: "/repo",
      harness: { id: "pi", access: "native" },
    })

    expect(runtime.recovery.inspect(created.id).failures).toEqual([])
    report(created.id, new Error("the approval could not be persisted"))

    const failures = runtime.recovery.inspect(created.id).failures
    expect(failures).toHaveLength(1)
    expect(failures[0].message).toContain("the approval could not be persisted")
    expect(failures[0].target).toMatchObject({ scope: "session", sessionId: created.id })
    // Another session's inspection is not this one's failure log.
    expect(runtime.recovery.inspect("ses_other").failures).toEqual([])
  })

  test("the loser of a deadline race releases its timer and its listener", async () => {
    // A listener left attached keeps this promise's closure reachable for the
    // life of the signal; a timer left running holds the event loop open for
    // the rest of a deadline nobody is waiting on.
    const cleared: unknown[] = []
    const realClear = globalThis.clearTimeout
    globalThis.clearTimeout = ((handle: never) => { cleared.push(handle); return realClear(handle) }) as typeof clearTimeout
    try {
      // The abort wins: the timer it beat must be cleared.
      const aborting = new AbortController()
      const pending = stoppedWaiting({ signal: aborting.signal, deadlineAt: Date.now() + 60_000 })
      aborting.abort()
      expect(await pending).toBe(false)
      expect(cleared).toHaveLength(1)

      // The timer wins: the listener it beat must come off the signal.
      const timing = new AbortController()
      const removed: string[] = []
      const realRemove = timing.signal.removeEventListener.bind(timing.signal)
      timing.signal.removeEventListener = ((type: string, listener: never, options?: never) => {
        removed.push(type)
        return realRemove(type, listener, options)
      }) as typeof timing.signal.removeEventListener
      expect(await stoppedWaiting({ signal: timing.signal, deadlineAt: Date.now() + 5 })).toBe(false)
      expect(removed).toEqual(["abort"])
    } finally {
      globalThis.clearTimeout = realClear
    }
  })

  test("every harness factory hands its adapter the runtime's failure sink", () => {
    // The sink stays optional on the adapter options: 34 test doubles build
    // adapters without one. That optionality is how it came to be supplied by
    // nothing in production, so the compositions are checked here rather than
    // by the type.
    const factories: Record<string, AgentHarnessFactory> = {
      acp: acp("acp-under-test", { connection: { kind: "process", command: "test-acp" } }),
      claude: claude(),
      codex: codex(),
      cursor: cursor(),
      pi: pi({ agentDir: "/tmp/pi-agent-under-test" }),
    }
    const sink = () => {}
    for (const [name, factory] of Object.entries(factories)) {
      const adapter = factory.create({
        store: createMemoryRuntimeStore(),
        eventHub: createRuntimeEventHub(),
        reportOwnerFailure: sink,
      }) as unknown as { options?: { reportOwnerFailure?: unknown } }
      expect(adapter.options?.reportOwnerFailure, `${name} forwards the runtime's sink`).toBe(sink)
    }
  })

  test("Pi's real cancel path never reports cleanup above its row", async () => {
    const fake = await installFakePiRpc()
    const store = createMemoryRuntimeStore()
    const adapter = new PiHarnessAdapter({ binary: fake.binary, agentDir: fake.agentDir, store })
    try {
      const session = await adapter.createSession(fake.directory)
      const binding = {
        workspaceId: "workspace",
        directory: fake.directory,
        sessionId: session.id,
        upstreamSessionId: store.getAgentSessionId(session.id)!,
        connectionId: "native:pi" as const,
      }
      const outcome = await cancelAdapterTurn(adapter, binding, { withinMs: 40 })
      const pi = MATRIX.find((row) => row.harness === "pi")!
      expect(CLEANUP_RANK[outcome.cleanup]).toBeLessThanOrEqual(CLEANUP_RANK[pi.cleanupBest])
      // Pi enumerates nothing, so even a clean stop cannot reach clear.
      expect(outcome.cleanup).not.toBe("verified_clear")
    } finally {
      await adapter.dispose()
      await rm(fake.directory, { recursive: true, force: true })
    }
  })

  test("Cursor and Claude own no inventory, so their real cancel paths stay below verified_clear", async () => {
    // Driven through the shared owner every SDK-backed adapter cancels
    // through, with each driver's own stop wiring: neither records a cleanup
    // fact, because neither harness can enumerate what a turn started.
    for (const harness of ["cursor", "claude"] as const) {
      const row = MATRIX.find((item) => item.harness === harness)!
      const session = sdkSession({ stop: async () => {} })
      const outcome = await cancelSdkRuntimeTurn(session.lifecycle, harness, "s1", deadline())
      expect(outcome.execution).toBe("terminal")
      expect(CLEANUP_RANK[outcome.cleanup]).toBeLessThanOrEqual(CLEANUP_RANK[row.cleanupBest])
      expect(outcome.cleanup).not.toBe("verified_clear")
    }
  })
})
