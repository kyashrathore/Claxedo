import type { BackgroundWork } from "@claxedo/agent-runtime-contract"
import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import type { HarnessServices, HarnessVersionGate, ProcessLosses, SessionBroker, StartInput } from "../../contract"
import { projectCodexThreadConfig } from "./configuration"
import type { Entry } from "./entry"
import { CodexRequestRefusal, CodexTransportError } from "./errors"
import { reconcileCodexGoal } from "./goals"
import { codexThreadResumeParams, codexThreadStartParams } from "./input"
import { codexModelProvider, type CodexLaunch, type CodexLaunches } from "./launch"
import { codexPermissionSettings } from "./modes"
import { codexStartSettings } from "./models"
import { codexNotificationOutsideTurn } from "./notifications"
import type { RpcMessage } from "./rpc"
import { CodexTerminals } from "./terminals"
import { CodexChildren } from "./children"
import { CodexUsageLedger } from "./usage"

export type CodexSessionHost = {
  launches: CodexLaunches
  versions: HarnessVersionGate
  services: HarnessServices
  losses: ProcessLosses
  entries: Map<string, Entry>
  answer(entry: Entry, message: RpcMessage, signal: AbortSignal): Promise<unknown>
  idle(entry: Entry): void
}

type OpenedLaunch = CodexLaunch & { modelProvider: string }

async function openThread(host: CodexSessionHost, { rpc, plugins, modelProvider }: OpenedLaunch, input: StartInput, resumed: string | undefined): Promise<string> {
  const config = projectCodexThreadConfig(input, host.services, plugins)
  host.launches.assertLive(" during startup")
  const mode = codexPermissionSettings(input.config.permissionMode)
  const result = asRecordOrEmpty(await rpc.request(resumed ? "thread/resume" : "thread/start",
    resumed ? codexThreadResumeParams(resumed, input, config, mode, modelProvider) : codexThreadStartParams(input, config, mode, modelProvider)))
  const threadId = asString(asRecordOrEmpty(result.thread).id) ?? ""
  if (!threadId || (resumed && threadId !== resumed)) throw new CodexTransportError("session", "Codex returned a different or missing thread")
  return threadId
}

function publishBackgroundWork(broker: SessionBroker, work: BackgroundWork): void {
  void broker.publish({ type: "background-work", ...work }).catch((error: unknown) => broker.reportFailure(error))
}

async function bindEntry(host: CodexSessionHost, launched: OpenedLaunch, input: StartInput, broker: SessionBroker,
  threadId: string): Promise<{ entry: Entry; replay(): void }> {
  const { rpc } = launched
  let entry: Entry | undefined
  const early: RpcMessage[] = []
  rpc.onRequest((message, signal) => entry ? host.answer(entry, message, signal)
    : Promise.reject(new CodexRequestRefusal(-32000, "Codex session is not bound yet")))
  rpc.onMessage((message) => { if (entry) codexNotificationOutsideTurn(entry, message); else early.push(message) })
  rpc.onFailure((error) => {
    if (!entry) return
    if (entry.state !== "retiring") {
      host.losses.record(input.sessionId, error.message)
      entry.state = "lost"
    }
    entry.providerTurn?.fail(error)
    entry.children.end()
  })
  const binding = await broker.rebind(threadId)
  const bound: Entry = { state: "ready", start: input, session: { directory: input.directory, locality: input.locality, binding }, broker, rpc,
    home: launched.home, modelProvider: launched.modelProvider, plugins: launched.plugins, terminals: new CodexTerminals(rpc, threadId), children: new CodexChildren((work) => publishBackgroundWork(broker, work)), sideThreads: new Set(),
    usage: new CodexUsageLedger(), goal: null, settings: codexStartSettings(input), steers: new Set(), released: Promise.resolve(), idle: () => host.idle(bound) }
  return { entry: bound, replay: () => {
    entry = bound
    for (const message of early.splice(0)) codexNotificationOutsideTurn(bound, message)
  } }
}

export async function openCodexSession(host: CodexSessionHost, input: StartInput, broker: SessionBroker, resumed?: string): Promise<Entry> {
  const launch = await host.launches.launch(input)
  try {
    await host.versions.admit(launch.version, "initialize", broker)
    const launched = { ...launch, modelProvider: await codexModelProvider(launch, input.directory) }
    const threadId = await openThread(host, launched, input, resumed)
    const { entry, replay } = await bindEntry(host, launched, input, broker, threadId)
    if (resumed) await reconcileCodexGoal(entry)
    if (!launched.rpc.alive) throw new CodexTransportError("process", "Codex process exited while its session was bound")
    host.entries.set(input.sessionId, entry)
    host.losses.recovered(input.sessionId)
    host.launches.settled(launched.rpc)
    replay()
    return entry
  } catch (error) {
    await host.launches.discard(launch.rpc)
    throw error
  }
}
