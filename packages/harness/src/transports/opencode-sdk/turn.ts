import { asRecordOrEmpty } from "@claxedo/helpers/guards"
import { AsyncPushQueue, errorMessage, settleAtRequestDeadline } from "@claxedo/helpers"
import type { RoutedEvent, StartInput, TurnBroker, TurnInput } from "../../contract"
import type { ProjectedEvent } from "./event-pump"
import { TransportError } from "../../contract/errors.js"
import type { OpenCodeRuntime } from "./runtime"
import type { WorkspaceScope } from "./scope"
import type { SessionSummary } from "./session-types"
import { assertProviderAvailable } from "./credentials.js"
import { abortedSessionOutcome, eventAssistantMessageID, eventSessionID, projectTurnEvent, sessionOutcome, terminal } from "./translate/event.js"
import { createTurnUsage, readSessionTotal } from "./translate/turn-usage.js"
import { answerOpenCodeRequest } from "./requests.js"
import { declaredCommand } from "./command-invocation.js"
import { flattenTurnPrompt } from "../../translate/prompt"

export type OpenCodeTurnState = { start: StartInput; scope: WorkspaceScope; upstream: string;
  active: boolean; assistantMessageID?: string; steers: Set<string>; pendingInstance?: string }

const STREAM_LOSS_WAIT_MS = 60_000
const INTERRUPT_WAIT_MS = 5_000
const SNAPSHOT_READ_MS = 5_000
const MCP_SETTLE_MS = 10_000

class StreamLost extends Error {}
class TurnAborted extends Error {}
class InterruptWaitExpired extends Error {}
class McpSettleExpired extends Error {}

export function promptRequest(turn: TurnInput) {
  const files: Array<{ ref: string; name?: string }> = []
  for (const part of turn.prompt.parts) {
    const row = asRecordOrEmpty(part)
    if (row.type === "text" && typeof row.text === "string") continue
    if (row.type === "file" && typeof row.url === "string") {
      files.push({ ref: row.url, ...(typeof row.filename === "string" ? { name: row.filename } : {}) })
    } else throw new TransportError("opencode", "configuration", `OpenCode prompt part ${String(row.type)} has no mapping`)
  }
  return { text: flattenTurnPrompt(turn, { separator: "\n", system: "prefix" }),
    ...(files.length ? { files } : {}), delivery: "steer" as const }
}

export function route(event: RoutedEvent["event"]): RoutedEvent { return { event } }

function listenOpenCodeEvents(runtime: OpenCodeRuntime, state: OpenCodeTurnState, broker: TurnBroker, queue: AsyncPushQueue<ProjectedEvent>): () => void {
  return runtime.events.subscribe((event) => {
    const owner = event.type === "form.created"
      ? asRecordOrEmpty(asRecordOrEmpty(event.data).form).sessionID : eventSessionID(event)
    if (owner !== state.upstream || (event.directory && event.directory !== state.scope.directory)) return
    if (event.type === "permission.asked" || event.type === "form.created") {
      void answerOpenCodeRequest(event, runtime, state.scope, broker, state.start.sessionId).catch((error: unknown) =>
        queue.fail(error instanceof Error ? error : new TransportError("opencode", "request", errorMessage(error))))
    } else queue.push(event)
  })
}

async function admitOpenCodeTurn(runtime: OpenCodeRuntime, state: OpenCodeTurnState, turn: TurnInput, signal: AbortSignal): Promise<{
  usage: ReturnType<typeof createTurnUsage>; admittedAt: number }> {
  const model = turn.model
  if (!model) throw new TransportError("opencode", "configuration", "OpenCode turn requires a resolved model")
  assertProviderAvailable(state.start, model.providerID)
  await runtime.events.ready()
  if (signal.aborted) throw new TurnAborted("OpenCode turn was aborted")
  const usage = createTurnUsage(state.upstream, await readSessionTotal(async () =>
    (await runtime.sessions.get(state.scope, state.upstream)).tokens))
  if (turn.prompt.agent) await runtime.sessions.switchAgent(state.scope, state.upstream, turn.prompt.agent)
  await runtime.sessions.switchModel(state.scope, state.upstream, { providerID: model.providerID, modelID: model.modelID,
    ...(turn.effort ? { variant: turn.effort } : {}) })
  await awaitInstanceMcp(runtime, state, signal)
  return { usage, admittedAt: await submitOpenCodeTurn(runtime, state, turn) }
}

async function awaitInstanceMcp(runtime: OpenCodeRuntime, state: OpenCodeTurnState, signal: AbortSignal): Promise<void> {
  try {
    await settleAtRequestDeadline("OpenCode MCP settle", { deadlineAt: Date.now() + MCP_SETTLE_MS, signal },
      runtime.instances.ready(state.upstream), () => {}, (what, aborted) => aborted ? new TurnAborted("OpenCode turn was aborted") : new McpSettleExpired(what))
  } catch (error) {
    if (!(error instanceof McpSettleExpired)) throw error
  }
}

async function submitOpenCodeTurn(runtime: OpenCodeRuntime, state: OpenCodeTurnState, turn: TurnInput): Promise<number> {
  const request = promptRequest(turn)
  const invocation = await declaredCommand(runtime, state.scope, turn)
  if (!invocation) return (await runtime.sessions.prompt(state.scope, state.upstream, request)).createdAt
  const submittedAt = Date.now()
  await runtime.sessions.command(state.scope, state.upstream, { ...invocation, delivery: request.delivery })
  return submittedAt
}

async function settledSnapshot(runtime: OpenCodeRuntime, state: OpenCodeTurnState, cause: StreamLost | TurnAborted,
  signal: AbortSignal): Promise<SessionSummary> {
  const idle = runtime.sessions.wait(state.scope, state.upstream)
  void idle.then(undefined, () => undefined)
  if (cause instanceof StreamLost) {
    await settleAtRequestDeadline("OpenCode session wait", { deadlineAt: Date.now() + STREAM_LOSS_WAIT_MS, signal }, idle, () => {},
      () => new TransportError("opencode", "engine", "OpenCode session wait deadline expired"))
  } else {
    await runtime.sessions.interrupt(state.scope, state.upstream)
    try {
      await settleAtRequestDeadline("OpenCode interrupt wait", { deadlineAt: Date.now() + INTERRUPT_WAIT_MS, signal: new AbortController().signal },
        idle, () => {}, () => new InterruptWaitExpired("OpenCode interrupt wait deadline expired"))
    } catch (error) {
      if (!(error instanceof InterruptWaitExpired)) throw error
    }
  }
  return settleAtRequestDeadline("OpenCode session reconciliation",
    { deadlineAt: Date.now() + SNAPSHOT_READ_MS, signal: new AbortController().signal },
    runtime.sessions.get(state.scope, state.upstream), () => {},
    () => new TransportError("opencode", "engine", "OpenCode session reconciliation deadline expired"))
}

async function* reconcileOpenCodeTurn(runtime: OpenCodeRuntime, state: OpenCodeTurnState,
  usage: ReturnType<typeof createTurnUsage>, admittedAt: number, cause: StreamLost | TurnAborted, signal: AbortSignal): AsyncIterable<RoutedEvent> {
  const snapshot = await settledSnapshot(runtime, state, cause, signal)
  if (snapshot.idleAt === undefined || snapshot.idleAt < admittedAt || !snapshot.outcome) {
    if (cause instanceof TurnAborted) return
    throw new TransportError("opencode", "engine", "OpenCode turn ended without a terminal session outcome")
  }
  const closing = usage.close(await readSessionTotal(async () => snapshot.tokens))
  if (closing) yield route(closing)
  yield route(cause instanceof TurnAborted ? abortedSessionOutcome(snapshot.outcome, state.upstream) : sessionOutcome(snapshot.outcome, state.upstream))
}

async function* streamOpenCodeTurn(runtime: OpenCodeRuntime, state: OpenCodeTurnState, queue: AsyncPushQueue<ProjectedEvent>,
  usage: ReturnType<typeof createTurnUsage>): AsyncIterable<RoutedEvent> {
  while (true) {
    const event = await queue.take()
    state.assistantMessageID = eventAssistantMessageID(event) ?? state.assistantMessageID
    const ended = terminal(event, state.upstream)
    if (ended) {
      const closing = usage.close(await readSessionTotal(async () =>
        (await runtime.sessions.get(state.scope, state.upstream)).tokens), event)
      if (closing) yield route(closing)
      yield route(ended)
      return
    }
    const delivered = deliveredSteer(event, state)
    if (delivered) { yield route({ type: "input-incorporated", messageId: delivered }); continue }
    const projected = projectTurnEvent(event) ?? usage.observe(event)
    if (projected) yield route(projected)
  }
}

function deliveredSteer(event: ProjectedEvent, state: OpenCodeTurnState): string | undefined {
  if (event.type !== "session.inbox.delivered") return undefined
  const inboxID = asRecordOrEmpty(event.data).inboxID
  if (typeof inboxID !== "string" || !state.steers.delete(inboxID)) return undefined
  return inboxID
}

export async function* runOpenCodeTurn(runtime: OpenCodeRuntime, state: OpenCodeTurnState, turn: TurnInput,
  broker: TurnBroker, closed: AbortSignal): AsyncIterable<RoutedEvent> {
  if (state.active) throw new TransportError("opencode", "session", "OpenCode session already has an active turn")
  if (!runtime.events.subscribeLoss) throw new TransportError("opencode", "engine", "OpenCode event loss subscription is unavailable")
  state.active = true
  const queue = new AsyncPushQueue<ProjectedEvent>()
  const unsubscribe = listenOpenCodeEvents(runtime, state, broker, queue)
  const unsubscribeLoss = runtime.events.subscribeLoss(() => queue.fail(new StreamLost("OpenCode event stream lost")))
  const abort = () => queue.fail(new TurnAborted("OpenCode turn was aborted"))
  broker.signal.addEventListener("abort", abort, { once: true })
  if (broker.signal.aborted) abort()
  const dispose = () => queue.fail(new TransportError("opencode", "engine", "OpenCode transport was disposed during the turn"))
  closed.addEventListener("abort", dispose, { once: true })
  if (closed.aborted) dispose()
  try {
    const { usage, admittedAt } = await admitOpenCodeTurn(runtime, state, turn, broker.signal)
    try { yield* streamOpenCodeTurn(runtime, state, queue, usage) }
    catch (error) {
      if (error instanceof StreamLost || error instanceof TurnAborted) {
        yield* reconcileOpenCodeTurn(runtime, state, usage, admittedAt, error, broker.signal)
      } else throw error
    }
  } finally {
    unsubscribe()
    unsubscribeLoss()
    broker.signal.removeEventListener("abort", abort)
    closed.removeEventListener("abort", dispose)
    state.active = false
    if (state.pendingInstance) runtime.instances.assign(state.upstream, state.pendingInstance)
    state.pendingInstance = undefined
    state.assistantMessageID = undefined
    state.steers.clear()
  }
}
