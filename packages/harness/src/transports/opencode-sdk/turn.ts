import { asRecordOrEmpty } from "@claxedo/helpers/guards"
import { AsyncPushQueue, errorMessage } from "@claxedo/helpers"
import type { RoutedEvent, StartInput, TurnBroker, TurnInput } from "../../contract"
import type { ProjectedEvent } from "./event-pump"
import { TransportError } from "../../contract/errors.js"
import type { OpenCodeRuntime } from "./runtime"
import type { WorkspaceScope } from "./scope"
import { assertProviderAvailable } from "./credentials.js"
import { eventAssistantMessageID, eventSessionID, projectTurnEvent, terminal } from "./translate/event.js"
import { createTurnUsage, readSessionTotal } from "./translate/turn-usage.js"
import { answerOpenCodeRequest } from "./requests.js"
import { flattenTurnPrompt } from "../../translate/prompt"

export type OpenCodeTurnState = { start: StartInput; scope: WorkspaceScope; upstream: string;
  active: boolean; assistantMessageID?: string }

export function promptRequest(turn: TurnInput) {
  const files: Array<{ ref: string; name?: string }> = []
  for (const part of turn.prompt.parts) {
    const row = asRecordOrEmpty(part)
    if (row.type === "text" && typeof row.text === "string") continue
    if (row.type === "file" && typeof row.url === "string") {
      files.push({ ref: row.url, ...(typeof row.filename === "string" ? { name: row.filename } : {}) })
    } else throw new TransportError("opencode", "configuration", `OpenCode prompt part ${String(row.type)} has no mapping`)
  }
  return { text: flattenTurnPrompt(turn, { system: "turn", separator: "\n" }),
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

async function admitOpenCodeTurn(runtime: OpenCodeRuntime, state: OpenCodeTurnState, turn: TurnInput): Promise<ReturnType<typeof createTurnUsage>> {
  const model = turn.model ?? state.start.config.model
  if (!model) throw new TransportError("opencode", "configuration", "OpenCode turn requires a resolved model")
  assertProviderAvailable(state.start.credentials, model.providerID)
  await runtime.providersBound()
  await runtime.events.ready()
  const usage = createTurnUsage(state.upstream, await readSessionTotal(async () =>
    (await runtime.sessions.get(state.scope, state.upstream)).tokens))
  if (turn.prompt.agent) await runtime.sessions.switchAgent(state.scope, state.upstream, turn.prompt.agent)
  await runtime.sessions.switchModel(state.scope, state.upstream, { providerID: model.providerID, modelID: model.modelID,
    ...(state.start.config.variant ? { variant: state.start.config.variant } : {}) })
  await runtime.sessions.prompt(state.scope, state.upstream, promptRequest(turn))
  return usage
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
    const projected = projectTurnEvent(event) ?? usage.observe(event)
    if (projected) yield route(projected)
  }
}

export async function* runOpenCodeTurn(runtime: OpenCodeRuntime, state: OpenCodeTurnState, turn: TurnInput,
  broker: TurnBroker): AsyncIterable<RoutedEvent> {
  if (state.active) throw new TransportError("opencode", "session", "OpenCode session already has an active turn")
  state.active = true
  const queue = new AsyncPushQueue<ProjectedEvent>()
  const unsubscribe = listenOpenCodeEvents(runtime, state, broker, queue)
  try {
    const usage = await admitOpenCodeTurn(runtime, state, turn)
    yield* streamOpenCodeTurn(runtime, state, queue, usage)
  } catch (error) {
    yield route({ type: "error", error: errorMessage(error), harness: "opencode" })
  } finally {
    unsubscribe()
    state.active = false
    state.assistantMessageID = undefined
  }
}
