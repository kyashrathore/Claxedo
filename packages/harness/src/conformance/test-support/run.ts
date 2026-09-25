import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import type { PromptModel } from "@claxedo/agent-runtime-contract"
import type { HarnessSession, HarnessTransport, PluginProjection, ResolvedCredentials, RoutedEvent, StartInput, TurnActor, TurnInput, TurnOrigin } from "../../contract"
import { createRequestBroker, createSessionBroker, createTurnBroker } from "../../broker"
import { MemoryPorts, authority, origin } from "./memory-ports"
import { createTestServices, type TestServices } from "./services"

export type ConformanceBackend = {
  directory: string
  harness: StartInput["config"]["harness"]
  model: PromptModel
  credentials: ResolvedCredentials
  owner: TurnActor
  origin?: TurnOrigin
  sharedSender?: TurnOrigin
  projection?: PluginProjection
  expectedMcp?: "session" | "config" | "none"
  locality?: "local" | "remote"
  permissionCommand?: string
  textCommand?: string
  configureServices?(services: TestServices): void
  verifyRemoteMcp?(): Promise<void>
  onSetup?(context: { owner: ReturnType<typeof createRequestBroker>; ports: MemoryPorts }): void
  authFile?: string
  hold?(marker: string): () => void
  scriptTool?(name: string, input: unknown): void
  uiCommand?: string
  rotate?(): Promise<{ credentials: ResolvedCredentials; observed(): boolean }>
  close(): Promise<void>
}

export type ConformanceInput = {
  name: string
  backend(): Promise<ConformanceBackend>
  makeTransport(services: TestServices, backend: ConformanceBackend): HarnessTransport
}

async function setup(input: ConformanceInput) {
  const backend = await input.backend()
  const turnOrigin = backend.origin ?? origin
  const services = createTestServices()
  backend.configureServices?.(services)
  const ports = new MemoryPorts()
  Object.assign(ports, { clock: services.clock })
  ports.current.set("s1", { ...authority, directory: backend.directory })
  const owner = createRequestBroker(ports)
  ports.startBinding = { sessionId: "s1", directory: backend.directory, workspaceId: "w1",
    connectionId: "c1", operationId: "start-1" }
  backend.onSetup?.({ owner, ports })
  const sessionBroker = createSessionBroker(owner, {
    sessionId: "s1", directory: backend.directory, workspaceId: "w1", origin: turnOrigin,
    start: ports.startBinding, connectionId: "c1", operationId: "start-1",
  })
  const transport = input.makeTransport(services, backend)
  const start: StartInput = {
    sessionId: "s1", directory: backend.directory, locality: backend.locality ?? "local", owner: backend.owner,
    config: { harness: backend.harness, model: backend.model }, model: backend.model,
    projection: backend.projection ?? { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] },
    credentials: backend.credentials,
  }
  let session: HarnessSession
  try { session = await transport.start(start, sessionBroker) }
  catch (error) { await transport.dispose(); await backend.close(); throw error }
  ports.startStatus = "created"
  ports.current.set("s1", { ...authority, directory: backend.directory, upstreamSessionId: session.binding.upstreamSessionId })
  const turnBroker = (signal = new AbortController().signal) => createTurnBroker(owner, {
    authority: { ...authority, directory: backend.directory, upstreamSessionId: session.binding.upstreamSessionId }, origin: turnOrigin, signal,
  })
  const close = async () => { await transport.dispose(); await backend.close() }
  return { backend, services, ports, owner, transport, start, session, sessionBroker, turnBroker,
    turn: (message: string) => turn(backend.model, message, turnOrigin), close }
}

export { setup as setupConformance }

async function pendingQuestion(context: Awaited<ReturnType<typeof setup>>) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const pending = context.owner.broker.list({ sessionId: context.session.binding.sessionId })
      .find((row) => row.request.kind === "question")
    if (pending) return pending
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Pi question did not reach the broker")
}

async function pendingPermission(context: Awaited<ReturnType<typeof setup>>) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const pending = context.owner.broker.list({ sessionId: context.session.binding.sessionId })
      .find((row) => row.request.kind === "permission")
    if (pending) return pending
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("ACP permission did not reach the broker")
}

function turn(model: PromptModel, message: string, turnOrigin: TurnOrigin): TurnInput {
  return {
    turnId: "t1", userMessageId: "u1", assistantMessageId: "a1", origin: turnOrigin, model,
    prompt: { agent: "pi", assistantMessageId: "a1", parts: [{ type: "text", text: message }] }, todos: [],
  }
}

async function collect(transport: HarnessTransport, session: HarnessSession, input: TurnInput, broker: ReturnType<Awaited<ReturnType<typeof setup>>["turnBroker"]>): Promise<RoutedEvent[]> {
  const events: RoutedEvent[] = []
  for await (const event of transport.send(session, input, broker)) events.push(event)
  return events
}

export function runConformance(input: ConformanceInput): void {
  describe(`${input.name} transport conformance`, () => {
    test("starts a real process, streams text and usage, and closes it", async () => {
      const context = await setup(input)
      try {
        const events = await collect(context.transport, context.session, context.turn(context.backend.textCommand ?? "Reply with exactly this one token: PICONFORM"), context.turnBroker())
        expect(events.some((item) => item.event.type === "text-delta" && item.event.delta.includes("PICONFORM"))).toBe(true)
        expect(events.some((item) => item.event.type === "usage")).toBe(true)
        expect(events.some((item) => item.event.type === "finish")).toBe(true)
        const capabilities = await context.transport.capabilities({ directory: context.backend.directory })
        if (context.backend.expectedMcp) expect(capabilities.pluginIntake.mcp).toBe(context.backend.expectedMcp)
        await context.transport.close(context.session)
        expect((await Promise.all(context.services.processes.map((process) => process.exited))).every((exit) => exit.code !== null || exit.signal !== null)).toBe(true)
      } finally { await context.close() }
    }, 60_000)

    test("tool events and declared optional groups", async () => {
      const context = await setup(input)
      try {
        const capabilities = await context.transport.capabilities({ directory: context.backend.directory })
        if (context.backend.scriptTool) {
          context.backend.scriptTool("read", { path: "conformance.txt" })
          const events = await collect(context.transport, context.session, context.turn("Read conformance.txt"), context.turnBroker())
          expect(events.some((item) => item.event.type === "tool-start")).toBe(true)
          expect(events.some((item) => item.event.type === "tool-output")).toBe(true)
        }
        if (capabilities.commands) expect(await context.transport.commands?.list(context.backend.directory)).toBeArray()
        if (capabilities.titles === "harness") {
          expect(context.transport.naming).toBeDefined()
          await context.transport.naming?.rename?.(context.session, "Conformance title")
        }
        if (context.transport.health) {
          expect(context.transport.health.runtime(context.backend.directory).status).toBe("ok")
          expect(context.transport.health.connection(context.backend.directory, context.session.binding.sessionId).state).toBe("ready")
        }
      } finally { await context.close() }
    }, 60_000)

    test("steers an active turn when declared", async () => {
      const context = await setup(input)
      try {
        const capabilities = await context.transport.capabilities({ directory: context.backend.directory })
        if (!capabilities.steer || !context.backend.hold) return
        const release = context.backend.hold("PISTEER")
        const running = collect(context.transport, context.session, context.turn("Reply with exactly this one token: PISTEER"), context.turnBroker())
        await new Promise((resolve) => setTimeout(resolve, 100))
        const result = await context.transport.steer?.steer(context.session, { turnId: "t1", assistantMessageId: "a1" },
          context.turn("Reply with exactly this one token: PISTEERFOLLOW"))
        expect(result?.ok).toBe(true)
        release()
        const events = await running
        expect(events.some((item) => item.event.type === "finish")).toBe(true)
      } finally { await context.close() }
    }, 60_000)

    test("credential timing, cancellation facts, and disposal", async () => {
      const context = await setup(input)
      try {
        const capabilities = await context.transport.capabilities({ directory: context.backend.directory })
        if (context.backend.hold) {
          const release = context.backend.hold("PICANCEL")
          const controller = new AbortController()
          const running = collect(context.transport, context.session, context.turn("Reply with exactly this one token: PICANCEL"), context.turnBroker(controller.signal))
          await new Promise((resolve) => setTimeout(resolve, 300))
          const update = await context.transport.configure({ credentials: context.backend.credentials })
          if (capabilities.timing.credentials === "after-active-turns") expect(update.state).toBe("refused")
          const outcome = await context.transport.cancel(context.session, { turnId: "t1", assistantMessageId: "a1" }, { at: Date.now() + 5_000, signal: controller.signal })
          expect(["terminal", "unknown"].includes(outcome.execution)).toBe(true)
          expect(outcome.cleanup).not.toBe("verified_clear")
          release()
          await running
        }
        const rotation = await context.backend.rotate?.()
        expect((await context.transport.configure({ credentials: rotation?.credentials ?? context.backend.credentials })).state).toBe("applied")
        if (rotation) {
          await collect(context.transport, context.session, context.turn("Reply with exactly this one token: PIROTATED"), context.turnBroker())
          expect(rotation.observed()).toBe(true)
        }
      } finally { await context.close() }
    }, 60_000)

    test("keeps an owner's auth file byte identical", async () => {
      const context = await setup(input)
      try {
        if (!context.backend.authFile) return
        const before = await fs.readFile(context.backend.authFile)
        await collect(context.transport, context.session, context.turn("Reply with exactly this one token: PIAUTH"), context.turnBroker())
        expect(await fs.readFile(context.backend.authFile)).toEqual(before)
      } finally { await context.close() }
    }, 60_000)

    test("keeps the session profile for a shared sender and queued reissue", async () => {
      const context = await setup(input)
      try {
        if (!context.backend.sharedSender) return
        for (const reissued of [false, true]) {
          const shared = { ...context.turn("Reply with exactly this one token: PISHARED"), origin: { ...context.backend.sharedSender, reissued } }
          const events = await collect(context.transport, context.session, shared, context.turnBroker())
          expect(events.some((item) => item.event.type === "finish")).toBe(true)
        }
      } finally { await context.close() }
    }, 60_000)

    test("attaches a persisted session and retires the resumed process", async () => {
      const context = await setup(input)
      try {
        await collect(context.transport, context.session, context.turn("PIATTACH"), context.turnBroker())
        await context.transport.close(context.session)
        const attached = await context.transport.attach({ ...context.start, binding: context.session.binding }, context.sessionBroker)
        expect(attached.binding.upstreamSessionId).toBe(context.session.binding.upstreamSessionId)
        const events = await collect(context.transport, attached, context.turn("PIRESUMED"), context.turnBroker())
        expect(events.flatMap((item) => item.event.type === "text-delta" ? [item.event.delta] : []).join("").length).toBeGreaterThan(0)
        expect(events.some((item) => item.event.type === "finish")).toBe(true)
        await context.transport.close(attached)
        expect(context.services.processes).toHaveLength(context.backend.locality === "remote" ? 0 : 2)
      } finally { await context.close() }
    }, 60_000)

    test("filters remote MCP servers on new, fork, and resume", async () => {
      const context = await setup(input)
      try {
        if (!context.backend.verifyRemoteMcp) return
        await context.transport.fork?.fork(context.session, "m1")
        await context.transport.close(context.session)
        await context.transport.attach({ ...context.start, binding: context.session.binding }, context.sessionBroker)
        await context.backend.verifyRemoteMcp()
      } finally { await context.close() }
    }, 60_000)

    test("passes extension UI notices and brokered dialog answers", async () => {
      const context = await setup(input)
      try {
        if (!context.backend.uiCommand) return
        const commands = await context.transport.commands?.list(context.backend.directory)
        expect(commands?.some((command) => command.name === context.backend.uiCommand)).toBe(true)
        const running = collect(context.transport, context.session, context.turn(`/${context.backend.uiCommand} choose`), context.turnBroker())
        const question = await pendingQuestion(context)
        const reply = await context.owner.broker.answer(question.request.requestId, { kind: "answers", answers: [["Allow"]] }, { sessionId: context.session.binding.sessionId })
        expect(reply.ok).toBe(true)
        const events = await running
        for (const method of ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]) {
          expect(events.some((item) => item.event.type === "harness-notice" && item.event.code === `pi.extension_ui.${method}`)).toBe(true)
        }
        expect(events.some((item) => item.event.type === "session-title" && item.event.title === "Pi allowed")).toBe(true)
        expect(context.ports.saved.some((row) => row.answer.kind === "answers")).toBe(true)
      } finally { await context.close() }
    }, 60_000)

    test("expires a timed extension dialog in the broker", async () => {
      const context = await setup(input)
      try {
        if (!context.backend.uiCommand) return
        const events = await collect(context.transport, context.session, context.turn(`/${context.backend.uiCommand} expire`), context.turnBroker())
        expect(events.some((item) => item.event.type === "harness-notice" && item.event.code === "pi.extension_ui.setStatus")).toBe(true)
        expect(context.ports.saved.some((row) => row.answer.kind === "expired")).toBe(true)
      } finally { await context.close() }
    }, 60_000)

    test("records a denied dialog without granting it", async () => {
      const context = await setup(input)
      try {
        if (!context.backend.uiCommand) return
        const running = collect(context.transport, context.session, context.turn(`/${context.backend.uiCommand} choose`), context.turnBroker())
        const question = await pendingQuestion(context)
        const result = await context.owner.broker.answer(question.request.requestId, { kind: "answers", answers: [["Deny"]] }, { sessionId: context.session.binding.sessionId })
        expect(result.ok).toBe(true)
        await running
        expect(context.ports.saved.some((row) => row.answer.kind === "answers" && row.answer.answers[0]?.[0] === "Deny")).toBe(true)
      } finally { await context.close() }
    }, 60_000)

    test.each(["input", "editor"])("answers a Pi %s dialog through the broker", async (method) => {
      const context = await setup(input)
      try {
        if (!context.backend.uiCommand) return
        const running = collect(context.transport, context.session, context.turn(`/${context.backend.uiCommand} ${method}`), context.turnBroker())
        const question = await pendingQuestion(context)
        expect(question.request.kind).toBe("question")
        const result = await context.owner.broker.answer(question.request.requestId, { kind: "answers", answers: [["entered text"]] }, { sessionId: context.session.binding.sessionId })
        expect(result.ok).toBe(true)
        await running
        expect(context.ports.saved.some((row) => row.answer.kind === "answers" && row.answer.answers[0]?.[0] === "entered text")).toBe(true)
      } finally { await context.close() }
    }, 60_000)

    test("cancels a brokered dialog without allowing it", async () => {
      const context = await setup(input)
      try {
        if (!context.backend.uiCommand) return
        const controller = new AbortController()
        const running = collect(context.transport, context.session, context.turn(`/${context.backend.uiCommand} choose`), context.turnBroker(controller.signal))
        const settled = running.then((events) => ({ kind: "events" as const, events }), (error: unknown) => ({ kind: "error" as const, error }))
        await pendingQuestion(context)
        controller.abort()
        expect(["events", "error"]).toContain((await settled).kind)
        expect(context.ports.saved.some((row) => row.answer.kind === "cancelled")).toBe(true)
        expect(context.ports.saved.some((row) => row.answer.kind === "answers" && row.answer.answers[0]?.[0] === "Allow")).toBe(false)
      } finally { await context.close() }
    }, 60_000)

    test.each(["allow_once", "deny"])("persists a %s permission answer before releasing the agent", async (decision) => {
      const context = await setup(input)
      try {
        if (!context.backend.permissionCommand) return
        const running = collect(context.transport, context.session, context.turn(context.backend.permissionCommand), context.turnBroker())
        const pending = await pendingPermission(context)
        const reply = await context.owner.broker.answer(pending.request.requestId, { kind: "permission", decision },
          { sessionId: context.session.binding.sessionId })
        expect(reply.ok).toBe(true)
        const events = await running
        expect(events.some((item) => item.event.type === "finish")).toBe(true)
        expect(context.ports.saved.some((row) => row.answer.kind === "permission" && row.answer.decision === decision)).toBe(true)
      } finally { await context.close() }
    }, 60_000)

    test("cancels a pending permission without allowing it", async () => {
      const context = await setup(input)
      try {
        if (!context.backend.permissionCommand) return
        const controller = new AbortController()
        const running = collect(context.transport, context.session, context.turn(context.backend.permissionCommand), context.turnBroker(controller.signal))
        await pendingPermission(context)
        controller.abort()
        await running
        expect(context.ports.saved.some((row) => row.answer.kind === "cancelled")).toBe(true)
        expect(context.ports.saved.some((row) => row.answer.kind === "permission" && row.answer.decision.startsWith("allow"))).toBe(false)
      } finally { await context.close() }
    }, 60_000)

    test("holds an ACP permission when the durable reply fails, then releases on retry", async () => {
      const context = await setup(input)
      try {
        if (!context.backend.permissionCommand) return
        const running = collect(context.transport, context.session, context.turn(context.backend.permissionCommand), context.turnBroker())
        const pending = await pendingPermission(context)
        context.ports.failPersist = true
        const refused = await context.owner.broker.answer(pending.request.requestId,
          { kind: "permission", decision: "allow_once" }, { sessionId: context.session.binding.sessionId })
        expect(refused).toMatchObject({ ok: false, refusal: "persistence" })
        expect(context.owner.broker.list({ sessionId: context.session.binding.sessionId })).toContainEqual(pending)
        expect(context.ports.saved).toHaveLength(0)
        context.ports.failPersist = false
        const accepted = await context.owner.broker.answer(pending.request.requestId,
          { kind: "permission", decision: "allow_once" }, { sessionId: context.session.binding.sessionId })
        expect(accepted.ok).toBe(true)
        expect((await running).some((item) => item.event.type === "finish")).toBe(true)
      } finally { await context.close() }
    }, 60_000)
  })
}
