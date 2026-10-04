import type { BackgroundWork } from "@claxedo/agent-runtime-contract"
import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import type { HarnessServices, HarnessVersionGate, ProcessLosses, SessionBroker, StartInput } from "../../contract"
import { CodexAccountLogin } from "./account"
import { projectCodexThreadConfig } from "./configuration"
import type { Entry } from "./entry"
import { CodexRequestRefusal, CodexThreadArchivedError, CodexTransportError } from "./errors"
import { reconcileCodexGoal } from "./goals"
import { codexThreadResumeParams, codexThreadStartParams } from "./input"
import { codexModelProvider, type CodexLaunch, type CodexLaunches } from "./launch"
import { codexPermissionSettings } from "./modes"
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

async function resumeThread(member: CodexLaunch["member"], threadId: string, params: unknown): Promise<unknown> {
  try { return await member.request("thread/resume", params) }
  catch (error) {
    if (!(error instanceof CodexThreadArchivedError)) throw error
    await member.request("thread/unarchive", { threadId })
    return member.request("thread/resume", params)
  }
}

async function openThread(host: CodexSessionHost, { member, plugins, modelProvider }: OpenedLaunch, input: StartInput, resumed: string | undefined): Promise<string> {
  const config = projectCodexThreadConfig(input, host.services, plugins)
  host.launches.assertLive(" during startup")
  const mode = codexPermissionSettings(input.config.permissionMode)
  const result = asRecordOrEmpty(resumed ? await resumeThread(member, resumed, codexThreadResumeParams(resumed, input, config, mode, modelProvider))
    : await member.request("thread/start", codexThreadStartParams(input, config, mode, modelProvider)))
  const threadId = asString(asRecordOrEmpty(result.thread).id) ?? ""
  if (!threadId || (resumed && threadId !== resumed)) throw new CodexTransportError("session", "Codex returned a different or missing thread")
  return threadId
}

function publishBackgroundWork(broker: SessionBroker, work: BackgroundWork): void {
  void broker.publish({ type: "background-work", ...work }).catch((error: unknown) => broker.reportFailure(error))
}

function listenUntilBound(host: CodexSessionHost, launch: CodexLaunch, input: StartInput): (entry: Entry) => void {
  let entry: Entry | undefined
  const early: RpcMessage[] = []
  launch.member.onRequest((message, signal) => entry ? host.answer(entry, message, signal)
    : Promise.reject(new CodexRequestRefusal(-32000, "Codex session is not bound yet")))
  launch.member.onMessage((message) => { if (entry) codexNotificationOutsideTurn(entry, message); else early.push(message) })
  launch.member.onFailure((error) => {
    if (!entry) return
    if (entry.state !== "retiring") {
      host.losses.record(input.sessionId, error.message)
      entry.state = "lost"
    }
    entry.providerTurn?.fail(error)
    entry.children.end()
  })
  return (bound) => {
    entry = bound
    for (const message of early.splice(0)) codexNotificationOutsideTurn(bound, message)
  }
}

function createEntry(host: CodexSessionHost, launched: OpenedLaunch, input: StartInput, broker: SessionBroker, binding: Entry["session"]["binding"]): Entry {
  const { member } = launched
  const entry: Entry = { state: "ready", start: input, session: { directory: input.directory, locality: input.locality, binding }, broker,
    rpc: member, key: launched.key, release: launched.release, home: launched.home, modelProvider: launched.modelProvider,
    terminals: new CodexTerminals(member, binding.upstreamSessionId), children: new CodexChildren((work) => publishBackgroundWork(broker, work)),
    sideThreads: new Set(), usage: new CodexUsageLedger(), goal: null, steers: new Set(), released: Promise.resolve(), idle: () => host.idle(entry) }
  return entry
}

export async function openCodexSession(host: CodexSessionHost, input: StartInput, broker: SessionBroker, resumed?: string): Promise<Entry> {
  let opened: Entry | undefined
  const account = new CodexAccountLogin(() => opened?.start ?? input,
    async (request) => host.services.refreshCredential?.({ sessionId: input.sessionId, ...request }), host.services.clock)
  const launch = await host.launches.join(input, account)
  try {
    const bind = listenUntilBound(host, launch, input)
    await host.versions.admit(launch.version, "initialize", broker)
    const launched = { ...launch, modelProvider: await codexModelProvider(launch, input.directory) }
    const threadId = await openThread(host, launched, input, resumed)
    const entry = opened = createEntry(host, launched, input, broker, await broker.rebind(threadId))
    if (resumed) await reconcileCodexGoal(entry)
    if (!launch.member.alive) throw new CodexTransportError("process", "Codex process exited while its session was bound")
    host.entries.set(input.sessionId, entry)
    host.losses.recovered(input.sessionId)
    bind(entry)
    return entry
  } catch (error) {
    await launch.release()
    throw error
  }
}
