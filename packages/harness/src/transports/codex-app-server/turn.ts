import { AsyncPushQueue } from "@claxedo/helpers"
import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import type { HarnessServices, HarnessSession, RoutedEvent, TurnBroker, TurnInput } from "../../contract"
import type { Entry } from "./index"
import { CodexEvents } from "./events"
import { CodexTransportError } from "./errors"
import { codexTurnParams } from "./input"
import { codexTurnSettings, type CodexModel } from "./models"
import { startCodexTurn } from "./recovery"
import { projectCodexThreadConfig } from "./configuration"

function listenTurn(entry: Entry, session: HarnessSession, queue: AsyncPushQueue<RoutedEvent>): () => void {
  const events = new CodexEvents(session.binding.upstreamSessionId)
  const removeMessage = entry.rpc.onMessage((message) => {
    if (!message.method || (message.method !== "account/rateLimits/updated"
      && asString(asRecordOrEmpty(message.params).threadId) !== session.binding.upstreamSessionId)) return
    try {
      for (const event of events.ingest(message)) queue.push(event)
      if (message.method === "turn/started" && entry.turn) {
        entry.turn.id = asString(asRecordOrEmpty(asRecordOrEmpty(message.params).turn).id) ?? ""
      }
      if (message.method === "turn/completed") queue.end()
    } catch (error) { queue.fail(error) }
  })
  const removeFailure = entry.rpc.onFailure((error) => queue.fail(error))
  return () => { removeMessage(); removeFailure() }
}

async function startTurn(entry: Entry, session: HarnessSession, turn: TurnInput, services: HarnessServices,
  models: () => Promise<CodexModel[]>): Promise<void> {
  const settings = codexTurnSettings(await models(), {
    model: turn.model?.modelID ?? entry.start.config.model?.modelID ?? entry.start.model?.modelID,
    effort: turn.effort, serviceTier: turn.prompt.serviceTier,
  })
  const params = codexTurnParams(turn, session.binding.upstreamSessionId, session.directory, settings)
  const result = asRecordOrEmpty(await startCodexTurn(entry.rpc, params, projectCodexThreadConfig(entry.start, services)))
  if (entry.turn) entry.turn.id = asString(asRecordOrEmpty(result.turn).id) ?? entry.turn.id ?? ""
}

export async function* runCodexTurn(entry: Entry, session: HarnessSession, turn: TurnInput, broker: TurnBroker,
  services: HarnessServices, models: () => Promise<CodexModel[]>, cancel: () => Promise<unknown>): AsyncIterable<RoutedEvent> {
  if (entry.state !== "ready" || entry.providerTurn) throw new CodexTransportError("session", "Codex turn already active")
  entry.state = "busy"
  entry.turn = { broker }
  const queue = new AsyncPushQueue<RoutedEvent>()
  const remove = listenTurn(entry, session, queue)
  const onAbort = () => { void cancel().catch((error: unknown) => entry.broker.reportFailure(error)) }
  broker.signal.addEventListener("abort", onAbort, { once: true })
  try {
    await startTurn(entry, session, turn, services, models)
    for await (const event of queue) yield event
  } finally {
    remove()
    broker.signal.removeEventListener("abort", onAbort)
    entry.turn = undefined
    if (entry.state === "busy") entry.state = "ready"
  }
}
