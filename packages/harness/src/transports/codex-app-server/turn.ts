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
import type { RpcMessage } from "./rpc"

function listenTurn(entry: Entry, session: HarnessSession, queue: AsyncPushQueue<RoutedEvent>): { remove: () => void; accept: () => void } {
  const events = new CodexEvents(session.binding.upstreamSessionId)
  const early: RpcMessage[] = []
  const ingest = (message: RpcMessage) => {
    if (!message.method || (message.method !== "account/rateLimits/updated"
      && asString(asRecordOrEmpty(message.params).threadId) !== session.binding.upstreamSessionId)) return
    try {
      if (message.method === "turn/started" || message.method === "turn/completed") {
        const id = asString(asRecordOrEmpty(asRecordOrEmpty(message.params).turn).id)
        if (!entry.turn?.id) { early.push(message); return }
        if (id !== entry.turn.id) return
      }
      for (const event of events.ingest(message)) queue.push(event)
      if (message.method === "turn/completed") queue.end()
    } catch (error) { queue.fail(error) }
  }
  const removeMessage = entry.rpc.onMessage(ingest)
  const removeFailure = entry.rpc.onFailure((error) => queue.fail(error))
  return { remove: () => { removeMessage(); removeFailure() }, accept: () => { for (const message of early) ingest(message) } }
}

async function startTurn(entry: Entry, session: HarnessSession, turn: TurnInput, services: HarnessServices,
  models: () => Promise<CodexModel[]>): Promise<void> {
  const settings = codexTurnSettings(await models(), {
    model: turn.model?.modelID ?? entry.start.config.model?.modelID ?? entry.start.model?.modelID,
    effort: turn.effort, serviceTier: turn.prompt.serviceTier,
  })
  const params = codexTurnParams(turn, session.binding.upstreamSessionId, session.directory, settings)
  const result = asRecordOrEmpty(await startCodexTurn(entry.rpc, params, projectCodexThreadConfig(entry.start, services)))
  const id = asString(asRecordOrEmpty(result.turn).id)
  if (!id) throw new CodexTransportError("protocol", "Codex turn/start returned no turn id")
  if (entry.turn) entry.turn.id = id
}

export async function* runCodexTurn(entry: Entry, session: HarnessSession, turn: TurnInput, broker: TurnBroker,
  services: HarnessServices, models: () => Promise<CodexModel[]>, cancel: () => Promise<unknown>): AsyncIterable<RoutedEvent> {
  if (entry.state !== "ready" || entry.providerTurn) throw new CodexTransportError("session", "Codex turn already active")
  entry.state = "busy"
  entry.turn = { broker }
  const queue = new AsyncPushQueue<RoutedEvent>()
  const listener = listenTurn(entry, session, queue)
  const onAbort = () => { void cancel().catch((error: unknown) => entry.broker.reportFailure(error)) }
  broker.signal.addEventListener("abort", onAbort, { once: true })
  try {
    await startTurn(entry, session, turn, services, models)
    listener.accept()
    for await (const event of queue) yield event
  } finally {
    listener.remove()
    broker.signal.removeEventListener("abort", onAbort)
    entry.turn = undefined
    if (entry.state === "busy") entry.state = "ready"
  }
}
