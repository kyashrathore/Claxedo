import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import type { PromptModel } from "@claxedo/agent-runtime-contract"
import type { HarnessSession, HarnessTransport, PluginProjection, ResolvedCredentials, RoutedEvent, StartInput, TurnActor, TurnInput, TurnOrigin } from "../../contract"
import { createRequestBroker, createSessionBroker, createTurnBroker } from "../../broker"
import { MemoryPorts, authority, origin } from "./memory-ports"
import { createTestServices, type TestServices } from "./services"
import { pollUntil } from "./poll"

export type ConformanceBackend = {
  execution?: "process" | "in-process"
  unrunnableTurn(turn: TurnInput): TurnInput
  cleanupWithoutCommands?: "verified_clear"
  agent?: string
  directory: string
  harness: StartInput["config"]["harness"]
  model: PromptModel
  alternateModel?: PromptModel
  credentials: ResolvedCredentials
  owner: TurnActor
  origin?: TurnOrigin
  sharedSender?: TurnOrigin
  projection?: PluginProjection
  credentialsAfterActiveTurns?: true
  locality?: "local" | "remote"
  permissionCommand?: string
  textCommand?: string
  configureServices?(services: TestServices): void
  verifyRemoteMcp?(): Promise<void>
  onSetup?(context: { owner: ReturnType<typeof createRequestBroker>; ports: MemoryPorts }): void
  authFile?: string
  hold?(marker: string): () => void
  held?(marker: string): Promise<void>
  steerIncorporationUnreported?: true
  processesPerLaunch?: number
  firstLaunchProcesses?: number
  credentialsPerCommand?: true
  scriptTool?(name: string, input: unknown): void
  scriptThinking?(input: { marker: string; text: string; reasoning: string }): void | Promise<string>
  thinkingRequested?(marker: string): boolean
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
  ports.directories.set("s1", backend.directory)
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
    sessionId: "s1", workspaceId: "w1", directory: backend.directory, locality: backend.locality ?? "local", owner: backend.owner,
    config: { harness: backend.harness, model: backend.model }, model: backend.model,
    projection: backend.projection ?? { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] },
    credentials: backend.credentials,
  }
  let started: HarnessSession
  try { started = await transport.start(start, sessionBroker) }
  catch (error) { await transport.dispose(); await backend.close(); throw error }
  ports.startStatus = "created"
  const binding = () => ports.bindings.get("s1") ?? started.binding
  const turnBroker = (signal = new AbortController().signal) => createTurnBroker(owner, {
    authority: { ...authority, directory: backend.directory, upstreamSessionId: binding().upstreamSessionId }, origin: turnOrigin, signal,
  })
  const close = async () => { await transport.dispose(); await backend.close() }
  return { backend, services, ports, owner, transport, start, started, sessionBroker, turnBroker,
    get session(): HarnessSession { return { ...started, binding: binding() } },
    turn: (message: string, userMessageId?: string) => turn(backend.model, backend.agent ?? "build", message, turnOrigin, userMessageId), close }
}

export { setup as setupConformance }

export function withUndeliverableFile(turn: TurnInput): TurnInput {
  return { ...turn, prompt: { ...turn.prompt, parts: [...turn.prompt.parts,
    { type: "file", mime: "image/png", filename: "remote.png", url: "https://attachments.invalid/remote.png" }] } }
}

async function pendingQuestion(context: Awaited<ReturnType<typeof setup>>) {
  const pending = await pollUntil(() => context.owner.broker.list({ sessionId: context.session.binding.sessionId })
    .find((row) => row.request.kind === "question"), Date.now() + 5_000)
  if (pending) return pending
  throw new Error("Pi question did not reach the broker")
}

async function pendingPermission(context: Awaited<ReturnType<typeof setup>>) {
  const pending = await pollUntil(() => context.owner.broker.list({ sessionId: context.session.binding.sessionId })
    .find((row) => row.request.kind === "permission"), Date.now() + 5_000)
  if (pending) return pending
  throw new Error("ACP permission did not reach the broker")
}

async function heldRequest(backend: ConformanceBackend, marker: string): Promise<void> {
  if (!backend.held) throw new Error("A backend that holds a reply must report when the held request arrives")
  await backend.held(marker)
}

function turn(model: PromptModel, agent: string, message: string, turnOrigin: TurnOrigin, userMessageId = "u1"): TurnInput {
  return {
    turnId: "t1", userMessageId, assistantMessageId: "a1", origin: turnOrigin, model,
    prompt: { agent, assistantMessageId: "a1", parts: [{ type: "text", text: message }] }, todos: [],
  }
}

async function collect(transport: HarnessTransport, session: HarnessSession, input: TurnInput, broker: ReturnType<Awaited<ReturnType<typeof setup>>["turnBroker"]>): Promise<RoutedEvent[]> {
  const events: RoutedEvent[] = []
  for await (const event of transport.send(session, input, broker)) events.push(event)
  return events
}

export type SuiteBackend = ConformanceBackend & Required<Pick<ConformanceBackend, "scriptThinking">>

type SuiteInput = ConformanceInput & { backend(): Promise<SuiteBackend> }

export function runConformance(input: SuiteInput): void {
  describe(`${input.name} transport conformance`, () => {
    test("starts a real harness, streams text and usage, and closes it", async () => {
      const context = await setup(input)
      try {
        if (context.backend.execution === "in-process") expect(context.services.processes).toHaveLength(0)
        expect(context.session.binding.workspaceId).toBe(context.start.workspaceId)
        const events = await collect(context.transport, context.session, context.turn(context.backend.textCommand ?? "Reply with exactly this one token: PICONFORM"), context.turnBroker())
        expect(events.some((item) => item.event.type === "text-delta" && item.event.delta.includes("PICONFORM"))).toBe(true)
        expect(events.some((item) => item.event.type === "usage")).toBe(true)
        expect(events.some((item) => item.event.type === "finish")).toBe(true)
        await context.transport.close(context.session)
        if (context.backend.execution === "in-process") expect(context.services.processes).toHaveLength(0)
        else expect((await Promise.all(context.services.processes.map((process) => process.exited))).every((exit) => exit.code !== null || exit.signal !== null)).toBe(true)
      } finally { await context.close() }
    }, 60_000)

    test("streams the model's thinking once, before the reply", async () => {
      const context = await setup(input)
      try {
        const reasoning = "Checking THINKCONFORM before replying"
        if (!context.backend.scriptThinking) throw new Error(`${input.name} scripts no thinking`)
        const prompt = await context.backend.scriptThinking({ marker: "THINKCONFORM", text: "THOUGHTCONFORM", reasoning })
        const events = (await collect(context.transport, context.session, context.turn(prompt ?? "Think, then reply: THINKCONFORM"), context.turnBroker()))
          .map((item) => item.event)
        const thinking = events.flatMap((event) => event.type === "thinking-delta" ? [event.delta] : []).join("")
        expect(thinking.trim()).toBe(reasoning)
        const firstThought = events.findIndex((event) => event.type === "thinking-delta")
        const firstText = events.findIndex((event) => event.type === "text-delta" && event.delta.length > 0)
        expect(firstThought).toBeGreaterThanOrEqual(0)
        expect(firstThought).toBeLessThan(firstText)
        if (context.backend.thinkingRequested) expect(context.backend.thinkingRequested("THINKCONFORM")).toBe(true)
      } finally { await context.close() }
    }, 60_000)

    test("the session's binding is the frozen binding the broker committed", async () => {
      const context = await setup(input)
      try {
        expect(Object.isFrozen(context.started.binding)).toBe(true)
        expect(context.ports.bindings.get("s1")).toEqual(context.started.binding)
        expect(() => { (context.started.binding as { upstreamSessionId: string }).upstreamSessionId = "forged" }).toThrow()
      } finally { await context.close() }
    }, 60_000)

    test("the goals capability agrees with the goals operation group", async () => {
      const context = await setup(input)
      try {
        const capabilities = await context.transport.capabilities({ directory: context.backend.directory, sessionId: context.session.binding.sessionId })
        expect(capabilities.goals.implemented).toBe(context.transport.goals !== undefined)
      } finally { await context.close() }
    }, 60_000)

    test("a turn the transport cannot run rejects the iteration and yields no error event", async () => {
      const context = await setup(input)
      try {
        const events: RoutedEvent[] = []
        const failure = await (async () => {
          const unrunnable = context.backend.unrunnableTurn(context.turn("Reply with exactly this one token: UNRUNNABLE"))
          for await (const event of context.transport.send(context.session, unrunnable, context.turnBroker())) events.push(event)
        })().then(() => undefined, (error: unknown) => error)
        expect(failure).toBeInstanceOf(Error)
        expect(events.filter((item) => item.event.type === "error")).toEqual([])
      } finally { await context.close() }
    }, 60_000)

    test("config options preview names the model the harness holds and derives it from the select", async () => {
      const context = await setup(input)
      try {
        if (!context.transport.config) return
        const alternate = context.backend.alternateModel
        const previews = [
          await context.transport.config.options({ session: context.session }, "probe"),
          await context.transport.config.options({ session: context.session, model: alternate ?? context.backend.model }, "probe"),
        ]
        if (alternate) {
          expect(previews[0]?.resolvedModel?.id).toBe(context.backend.model.modelID)
          expect(previews[1]?.resolvedModel?.id).toBe(alternate.modelID)
        }
        for (const preview of previews) {
          expect(preview.options).toBeArray()
          if (!preview.resolvedModel) { expect(alternate).toBeUndefined(); continue }
          const select = preview.options.find((option) => option.type === "select" && (option.category === "model" || option.id === "model"))
          expect(select?.currentValue).toBe(preview.resolvedModel.id)
          expect(select?.selectOptions?.find((choice) => choice.id === preview.resolvedModel?.id)?.name).toBe(preview.resolvedModel.name)
        }
      } finally { await context.close() }
    }, 60_000)

    test("tool events and declared optional groups", async () => {
      const context = await setup(input)
      try {
        if (context.backend.scriptTool) {
          context.backend.scriptTool("read", { path: "conformance.txt" })
          const events = await collect(context.transport, context.session, context.turn("Read conformance.txt"), context.turnBroker())
          expect(events.some((item) => item.event.type === "tool-start")).toBe(true)
          expect(events.some((item) => item.event.type === "tool-output")).toBe(true)
        }
        if (context.transport.commands) expect(await context.transport.commands.list({ session: context.session })).toBeArray()
        if (context.transport.naming?.rename) await context.transport.naming.rename(context.session, "Conformance title")
        if (context.transport.health) {
          expect(context.transport.health.runtime(context.backend.directory).status).toBe("ok")
          expect(context.transport.health.connection(context.backend.directory, context.session.binding.sessionId).state).toBe("ready")
        }
      } finally { await context.close() }
    }, 60_000)

    test("steers an active turn when declared", async () => {
      const context = await setup(input)
      try {
        if (!context.transport.steer || !context.backend.hold) return
        const release = context.backend.hold("PISTEER")
        const running = collect(context.transport, context.session, context.turn("Reply with exactly this one token: PISTEER"), context.turnBroker())
        await heldRequest(context.backend, "PISTEER")
        const steer = () => context.transport.steer?.steer(context.session, { turnId: "t1", assistantMessageId: "a1" },
          context.turn("Reply with exactly this one token: PISTEERFOLLOW", "msg_steer"))
        const result = await pollUntil(async () => {
          const result = await steer()
          return result && !result.ok && result.status === "no_active_turn" ? undefined : result
        }, Date.now() + 5_000)
        expect(result?.ok).toBe(true)
        release()
        const events = await running
        expect(events.some((item) => item.event.type === "finish")).toBe(true)
        const incorporated = events.filter((item) => item.event.type === "input-incorporated").map((item) => item.event)
        expect(incorporated).toEqual(context.backend.steerIncorporationUnreported ? [] : [{ type: "input-incorporated", messageId: "msg_steer" }])
      } finally { await context.close() }
    }, 60_000)

    test("credential timing, cancellation facts, and disposal", async () => {
      const context = await setup(input)
      try {
        if (context.backend.hold) {
          const release = context.backend.hold("PICANCEL")
          const controller = new AbortController()
          const running = collect(context.transport, context.session, context.turn("Reply with exactly this one token: PICANCEL"), context.turnBroker(controller.signal))
          await heldRequest(context.backend, "PICANCEL")
          const processes = context.services.processes.map((process) => process.pid)
          const update = await context.transport.configure(context.session, { credentials: context.backend.credentials })
          expect(["applied", "deferred"]).toContain(update.state)
          expect(context.services.processes.map((process) => process.pid)).toEqual(processes)
          const outcome = await context.transport.cancel(context.session, { turnId: "t1", assistantMessageId: "a1" }, { at: Date.now() + 5_000, signal: controller.signal })
          expect(["terminal", "unknown"].includes(outcome.execution)).toBe(true)
          if (context.backend.cleanupWithoutCommands) expect(outcome.cleanup).toBe(context.backend.cleanupWithoutCommands)
          else expect(outcome.cleanup).not.toBe("verified_clear")
          release()
          await running
        }
        const rotation = await context.backend.rotate?.()
        expect((await context.transport.configure(context.session, { credentials: rotation?.credentials ?? context.backend.credentials })).state).toBe("applied")
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
        const attached = await context.transport.attach({ ...context.start, binding: context.session.binding, upstreamHasTurns: true }, context.sessionBroker)
        if (context.backend.execution === "in-process") expect(context.services.processes).toHaveLength(0)
        expect(attached.binding.upstreamSessionId).toBe(context.session.binding.upstreamSessionId)
        const events = await collect(context.transport, attached, context.turn("PIRESUMED"), context.turnBroker())
        expect(events.flatMap((item) => item.event.type === "text-delta" ? [item.event.delta] : []).join("").length).toBeGreaterThan(0)
        expect(events.some((item) => item.event.type === "finish")).toBe(true)
        await context.transport.close(attached)
        expect(context.services.processes).toHaveLength(context.backend.execution === "in-process" || context.backend.locality === "remote" ? 0
          : (context.backend.firstLaunchProcesses ?? context.backend.processesPerLaunch ?? 1) + (context.backend.processesPerLaunch ?? 1))
      } finally { await context.close() }
    }, 60_000)

    test("filters remote MCP servers on new, fork, and resume", async () => {
      const context = await setup(input)
      try {
        if (!context.backend.verifyRemoteMcp) return
        await context.transport.fork?.fork(context.session, "m1", "child")
        await context.transport.close(context.session)
        await context.transport.attach({ ...context.start, binding: context.session.binding, upstreamHasTurns: false }, context.sessionBroker)
        await context.backend.verifyRemoteMcp()
      } finally { await context.close() }
    }, 60_000)

    test("passes extension UI notices and brokered dialog answers", async () => {
      const context = await setup(input)
      try {
        if (!context.backend.uiCommand) return
        const commands = await context.transport.commands?.list({ session: context.session })
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

    test("an aborted ask is durably cancelled and a late answer is stale", async () => {
      const context = await setup(input)
      try {
        const capabilities = await context.transport.capabilities({ directory: context.backend.directory })
        if (!capabilities.requests.questions && !capabilities.requests.permissions) return
        const requestId = "conformance-request-abort"
        const request = capabilities.requests.questions ? {
          kind: "question" as const, requestId,
          question: { id: requestId, sessionID: "s1", questions: [{ header: "Confirm", question: "Continue?", options: [], custom: true }] },
        } : {
          kind: "permission" as const, requestId,
          permission: { id: requestId, sessionID: "s1", permission: "execute", patterns: [], always: [], metadata: {} },
        }
        const controller = new AbortController()
        const asked = context.turnBroker().ask(request, { signal: controller.signal })
        for (let index = 0; index < 12; index++) await Promise.resolve()
        controller.abort()
        expect(await asked).toEqual({ kind: "cancelled" })
        expect(context.ports.readAnswer("s1", requestId)).toEqual({ kind: "cancelled" })
        expect(await context.owner.broker.answer(requestId, { kind: "rejected" }, { sessionId: "s1" })).toMatchObject({ refusal: "stale" })
      } finally { await context.close() }
    }, 60_000)

    test("a credential update targets one session while another turn runs", async () => {
      const context = await setup(input)
      try {
        if (!context.backend.credentialsAfterActiveTurns ||
          (!context.backend.hold && !context.backend.permissionCommand)) return
        await collect(context.transport, context.session, context.turn("Reply with exactly this one token: CONFORMANCEPREPARE"), context.turnBroker())
        const secondStart = { ...context.start, sessionId: "s2", workspaceId: "w2" }
        context.ports.current.set("s2", { ...authority, sessionId: "s2", workspaceId: "w2", directory: context.backend.directory })
        context.ports.directories.set("s2", context.backend.directory)
        const secondBroker = createSessionBroker(context.owner, { sessionId: "s2", workspaceId: "w2",
          directory: context.backend.directory, origin: context.backend.origin ?? origin })
        const second = await context.transport.start(secondStart, secondBroker)
        const secondTurnBroker = createTurnBroker(context.owner, { authority: context.ports.current.get("s2")!,
          origin: context.backend.origin ?? origin, signal: new AbortController().signal })
        const release = context.backend.hold?.("CONFORMANCESECOND")
        const running = collect(context.transport, second, context.turn(release ?
          "Reply with exactly this one token: CONFORMANCESECOND" : context.backend.permissionCommand!), secondTurnBroker)
        let pending: ReturnType<typeof context.owner.broker.list>[number] | undefined
        if (!release) {
          pending = await pollUntil(() => context.owner.broker.list({ sessionId: "s2" })
            .find((row) => row.request.kind === "permission"), Date.now() + 5_000)
          expect(pending).toBeDefined()
        } else await heldRequest(context.backend, "CONFORMANCESECOND")
        const secondProcess = context.services.processes.at(-1)
        const { credentials } = context.backend
        const update = await context.transport.configure(context.session, { credentials: { ...credentials, leaseGeneration: "session-one-only",
          providers: Object.fromEntries(Object.entries(credentials.providers).map(([id, provider]) =>
            [id, "placeholder" in provider ? { ...provider, placeholder: `${provider.placeholder}-session-one-only` } : provider])) } })
        expect(update.state).toBe("applied")
        if (secondProcess && !context.backend.credentialsPerCommand) expect(context.services.processes.at(-1)).not.toBe(secondProcess)
        if (pending) expect((await context.owner.broker.answer(pending.request.requestId,
          { kind: "permission", decision: "deny" }, { sessionId: "s2" })).ok).toBe(true)
        release?.()
        expect((await running).some((item) => item.event.type === "finish")).toBe(true)
      } finally { await context.close() }
    }, 60_000)

    test("a draft launch probes config options once and retires its process", async () => {
      const context = await setup(input)
      try {
        if (!context.transport.config) return
        const { sessionId: _sessionId, title: _title, instructions: _instructions, ...draft } = context.start
        const before = context.services.processes.length
        const [first, second] = await Promise.all([
          context.transport.config.options({ draft }, "probe"), context.transport.config.options({ draft }, "probe"),
        ])
        expect(first).toEqual(second)
        expect(first.options.length).toBeGreaterThan(0)
        if (context.backend.execution === "in-process") expect(context.services.processes).toHaveLength(0)
        else if (context.backend.locality !== "remote") {
          expect(context.services.processes).toHaveLength(before + (context.backend.processesPerLaunch ?? 1))
          for (const child of context.services.processes.slice(before)) expect(await child.exited).toBeDefined()
        }
        expect(await context.transport.config.options({ draft }, "probe")).toEqual(first)
      } finally { await context.close() }
    }, 60_000)

    test("a draft launch lists commands and retires its process", async () => {
      const context = await setup(input)
      try {
        if (!context.transport.commands) return
        const { sessionId: _sessionId, title: _title, instructions: _instructions, ...draft } = context.start
        const before = context.services.processes.length
        const commands = await context.transport.commands.list({ draft })
        expect(commands).toBeArray()
        expect(commands?.length).toBeGreaterThan(0)
        if (context.backend.execution === "in-process") expect(context.services.processes).toHaveLength(0)
        else if (context.backend.locality !== "remote") {
          expect(context.services.processes).toHaveLength(before + (context.backend.processesPerLaunch ?? 1))
          for (const child of context.services.processes.slice(before)) expect(await child.exited).toBeDefined()
        }
      } finally { await context.close() }
    }, 60_000)

    test("agent listing uses its session or draft target", async () => {
      const context = await setup(input)
      try {
        if (!context.transport.agents) return
        const sessionAgents = await context.transport.agents.list({ session: context.session })
        expect(sessionAgents?.length).toBeGreaterThan(0)
        const { sessionId: _sessionId, title: _title, instructions: _instructions, ...draft } = context.start
        expect(await context.transport.agents?.list({ draft })).toEqual(sessionAgents)
        if (context.backend.execution === "in-process") expect(context.services.processes).toHaveLength(0)
      } finally { await context.close() }
    }, 60_000)

    test("provider turn admission returns before settlement", async () => {
      const context = await setup(input)
      try {
        const capabilities = await context.transport.capabilities({ directory: context.backend.directory })
        if (!capabilities.goals.available) return
        let release!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        const result = await context.sessionBroker.admitProviderTurn({ reason: "goal" }, async function* () {
          await gate
          yield { event: { type: "text-delta", delta: "native goal" } }
          yield { event: { type: "finish", sessionId: context.session.binding.sessionId } }
        })
        expect(result.admitted).toBe(true)
        if (!result.admitted) return
        let settled = false
        void result.settled.then(() => { settled = true })
        await Promise.resolve()
        expect(settled).toBe(false)
        release()
        expect(await result.settled).toEqual({ state: "completed" })
        expect(context.ports.drained).toHaveLength(2)
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
