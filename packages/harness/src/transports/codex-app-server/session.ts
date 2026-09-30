import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import type { HarnessServices, ProcessLosses, SessionBroker, StartInput } from "../../contract"
import { projectCodexThreadConfig } from "./configuration"
import type { Entry } from "./entry"
import { CodexRequestRefusal, CodexTransportError } from "./errors"
import { reconcileCodexGoal } from "./goals"
import { codexThreadResumeParams, codexThreadStartParams } from "./input"
import type { CodexLaunch, CodexLaunches } from "./launch"
import { codexPermissionSettings } from "./modes"
import { codexNotificationOutsideTurn } from "./notifications"
import type { CodexRpc, RpcMessage } from "./rpc"
import { CodexTerminals } from "./terminals"
import { CodexUsageLedger } from "./usage"

export type CodexSessionHost = {
  launches: CodexLaunches
  services: HarnessServices
  losses: ProcessLosses
  entries: Map<string, Entry>
  answer(entry: Entry, message: RpcMessage): Promise<unknown>
  idle(entry: Entry): void
}

async function openThread(host: CodexSessionHost, rpc: CodexRpc, input: StartInput, resumed: string | undefined): Promise<string> {
  const config = projectCodexThreadConfig(input, host.services)
  host.launches.assertLive(" during startup")
  const mode = codexPermissionSettings(input.config.permissionMode)
  const result = asRecordOrEmpty(await rpc.request(resumed ? "thread/resume" : "thread/start",
    resumed ? codexThreadResumeParams(resumed, input, config, mode) : codexThreadStartParams(input, config, mode)))
  const threadId = asString(asRecordOrEmpty(result.thread).id) ?? ""
  if (!threadId || (resumed && threadId !== resumed)) throw new CodexTransportError("session", "Codex returned a different or missing thread")
  return threadId
}

async function bindEntry(host: CodexSessionHost, launched: CodexLaunch, input: StartInput, broker: SessionBroker,
  threadId: string): Promise<{ entry: Entry; replay(): void }> {
  const { rpc } = launched
  let entry: Entry | undefined
  const early: RpcMessage[] = []
  rpc.onRequest((message) => entry ? host.answer(entry, message)
    : Promise.reject(new CodexRequestRefusal(-32000, "Codex session is not bound yet")))
  rpc.onMessage((message) => { if (entry) codexNotificationOutsideTurn(entry, message); else early.push(message) })
  rpc.onFailure((error) => {
    if (!entry) return
    if (entry.state !== "retiring") {
      host.losses.record(input.sessionId, error.message)
      entry.state = "lost"
    }
    entry.providerTurn?.queue.fail(error)
  })
  const binding = await broker.rebind(threadId)
  const bound: Entry = { state: "ready", start: input, session: { directory: input.directory, locality: input.locality, binding }, broker, rpc,
    home: launched.home, brokered: launched.brokered, terminals: new CodexTerminals(rpc, threadId), children: new Map(), sideThreads: new Set(),
    usage: new CodexUsageLedger(), goal: null, settings: {}, idle: () => host.idle(bound) }
  return { entry: bound, replay: () => {
    entry = bound
    for (const message of early.splice(0)) codexNotificationOutsideTurn(bound, message)
  } }
}

export async function openCodexSession(host: CodexSessionHost, input: StartInput, broker: SessionBroker, resumed?: string): Promise<Entry> {
  const launched = await host.launches.launch(input)
  try {
    const threadId = await openThread(host, launched.rpc, input, resumed)
    const { entry, replay } = await bindEntry(host, launched, input, broker, threadId)
    if (resumed) await reconcileCodexGoal(entry)
    if (!launched.rpc.alive) throw new CodexTransportError("process", "Codex process exited while its session was bound")
    host.entries.set(input.sessionId, entry)
    host.losses.recovered(input.sessionId)
    host.launches.settled(launched.rpc)
    replay()
    return entry
  } catch (error) {
    await host.launches.discard(launched.rpc)
    throw error
  }
}
