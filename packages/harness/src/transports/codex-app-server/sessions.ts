import { errorMessage } from "@claxedo/helpers"
import type { ConfigApplied, HarnessServices, HarnessSession, ProcessLosses, SessionBroker, StartInput, TransportConfigUpdate } from "../../contract"
import { attachedSessionEntry, mergeStartInput } from "../../contract"
import { codexCredential } from "../../profiles/codex"
import type { Entry } from "./entry"
import { CodexTransportError } from "./errors"
import type { CodexLaunches } from "./launch"
import { codexRetirementDeadline, type RpcMessage } from "./rpc"
import { openCodexSession, type CodexSessionHost } from "./session"

function codexLaunch(start: StartInput): string {
  return JSON.stringify([start.credentials.accountOwner, start.credentials.machineLoginAllowed, codexCredential(start.credentials) ?? null, start.projection])
}

export class CodexSessions implements CodexSessionHost {
  readonly entries = new Map<string, Entry>()
  private readonly reopening = new Map<string, Promise<Entry>>()

  constructor(readonly launches: CodexLaunches, readonly services: HarnessServices, readonly losses: ProcessLosses,
    readonly answer: (entry: Entry, message: RpcMessage) => Promise<unknown>) {}

  open(input: StartInput, broker: SessionBroker, resumed?: string): Promise<Entry> {
    return openCodexSession(this, input, broker, resumed)
  }

  entry(session: HarnessSession): Entry {
    return attachedSessionEntry(this.entries, session, () => new CodexTransportError("session", "Codex session is not attached"),
      (entry) => entry.state !== "retiring")
  }

  connected(sessionId: string): boolean {
    const state = this.entries.get(sessionId)?.state
    return state !== undefined && state !== "lost"
  }

  async settled(session: HarnessSession): Promise<Entry> {
    await Promise.allSettled([this.reopening.get(session.binding.sessionId)])
    return this.entry(session)
  }

  async live(session: HarnessSession): Promise<Entry> {
    const entry = await this.settled(session)
    return entry.state === "lost" ? this.reopen(entry) : entry
  }

  idle(entry: Entry): void {
    if (!entry.pendingUpdate || entry.state !== "ready" || entry.providerTurn) return
    void this.apply(entry).then(undefined, (error: unknown) => entry.broker.reportFailure(error))
  }

  async configure(session: HarnessSession, update: TransportConfigUpdate): Promise<ConfigApplied> {
    if (!update.credentials && !update.projection) return { state: "applied" }
    const entry = await this.settled(session)
    entry.pendingUpdate = { ...entry.pendingUpdate, ...update }
    if (entry.state === "busy" || entry.providerTurn) return { state: "deferred", until: "after-active-turns" }
    await this.apply(entry)
    return { state: "applied" }
  }

  private async apply(entry: Entry): Promise<void> {
    const next = mergeStartInput(entry.start, entry.pendingUpdate ?? {})
    if (entry.state !== "lost" && codexLaunch(next) !== codexLaunch(entry.start)) {
      await this.reopen(entry)
      return
    }
    entry.start = next
    entry.pendingUpdate = undefined
  }

  private reopen(entry: Entry): Promise<Entry> {
    const sessionId = entry.start.sessionId
    const running = this.reopening.get(sessionId)
    if (running) return running
    const reopening = this.replace(entry).finally(() => this.reopening.delete(sessionId))
    this.reopening.set(sessionId, reopening)
    return reopening
  }

  private async replace(entry: Entry): Promise<Entry> {
    if (entry.state !== "lost") {
      entry.state = "retiring"
      await entry.rpc.retire(codexRetirementDeadline(this.services))
    }
    entry.state = "lost"
    entry.start = mergeStartInput(entry.start, entry.pendingUpdate ?? {})
    entry.pendingUpdate = undefined
    try { return await this.open(entry.start, entry.broker, entry.session.binding.upstreamSessionId) }
    catch (error) {
      this.losses.record(entry.start.sessionId, errorMessage(error))
      throw error
    }
  }

  async close(session: HarnessSession): Promise<void> {
    await Promise.allSettled([this.reopening.get(session.binding.sessionId)])
    const entry = this.entries.get(session.binding.sessionId)
    if (!entry) return
    entry.state = "retiring"
    entry.providerTurn?.queue.fail(new CodexTransportError("process", "Codex process retired during provider turn"))
    entry.providerTurn = undefined
    await entry.rpc.retire(codexRetirementDeadline(this.services))
    this.entries.delete(session.binding.sessionId)
    this.losses.recovered(session.binding.sessionId)
  }

  async dispose(): Promise<void> {
    await this.launches.dispose()
    for (const entry of this.entries.values()) await this.close(entry.session)
  }
}
