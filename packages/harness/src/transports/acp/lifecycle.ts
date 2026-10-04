import { attachedSessionEntry, type HarnessSession } from "../../contract"
import { errorMessage } from "@claxedo/helpers"
import { AcpTransportError } from "./errors"
import type { AcpEntry } from "./index"
import { restartAcpEntry, type AcpHost } from "./startup"

type Transition = {
  session: HarnessSession
  entry: AcpEntry
  state: "restarting" | "closing"
  abort: AbortController
  done: Promise<void>
  error?: unknown
}

function unverifiedRetirement(error: unknown): error is AcpTransportError {
  return error instanceof AcpTransportError && error.code === "ownership"
}

export class AcpSessionLifecycle {
  private readonly transitions = new Map<string, Transition>()

  constructor(private readonly host: AcpHost) {}

  async settled(sessionId: string): Promise<void> {
    let transition = this.transitions.get(sessionId)
    while (transition) {
      await transition.done
      const current = this.transitions.get(sessionId)
      if (current === transition) return
      transition = current
    }
  }

  async prepare(sessionId: string): Promise<void> {
    await this.settled(sessionId)
    const error = this.transitions.get(sessionId)?.error
    if (unverifiedRetirement(error)) throw error
    if (error !== undefined) this.transitions.delete(sessionId)
  }

  assertAvailable(sessionId: string): void {
    const transition = this.transitions.get(sessionId)
    if (!transition) return
    const { state, error } = transition
    if (unverifiedRetirement(error)) throw error
    if (error !== undefined) {
      throw new AcpTransportError("session", `ACP session ${state === "closing" ? "close" : "restart"} failed: ${errorMessage(error)}`, error)
    }
    if (state === "closing") throw new AcpTransportError("session", "ACP session is closing")
  }

  async restart(entry: AcpEntry): Promise<void> {
    await entry.updatesDelivered()
    const id = entry.session.binding.sessionId
    if (this.host.disposed() || this.host.entries.get(id) !== entry) return Promise.resolve()
    const pending = this.transitions.get(id)
    if (pending) return pending.done
    if (!entry.pendingRestart && !entry.peer.agent.signal.aborted) return
    if (!entry.peer.agent.signal.aborted && entry.children.hasLive) return Promise.reject(new AcpTransportError("configuration",
      "Claxedo cannot replace the ACP process while subagents are running. Wait for them to finish or explicitly stop the session before changing launch settings."))
    const abort = new AbortController()
    const work = restartAcpEntry(this.host, entry, abort.signal).then(() => {
      const closing = this.superseded(id)
      if (closing) throw closing
    }, (error: unknown) => { throw this.superseded(id, error) ?? error })
    this.begin(id, { session: entry.session, entry, state: "restarting", abort }, work)
    return work
  }

  defer(entry: AcpEntry): void {
    const id = entry.session.binding.sessionId
    void this.restart(entry).catch((error: unknown) => {
      if (this.transitions.get(id)?.state !== "closing") entry.broker.reportFailure(error)
    })
  }

  async close(session: HarnessSession): Promise<void> {
    const id = session.binding.sessionId
    const missing = () => new AcpTransportError("session", "ACP session is not attached")
    const entry = this.host.entries.has(id) ? attachedSessionEntry(this.host.entries, session, missing)
      : attachedSessionEntry(this.transitions, session, missing).entry
    const previous = this.transitions.get(id)
    if (previous?.state === "closing" && previous.error === undefined) return this.outcome(previous)
    const abort = previous?.abort ?? new AbortController()
    const transition = this.begin(id, { session: entry.session, entry, state: "closing", abort }, this.retire(id, entry, previous))
    abort.abort()
    return this.outcome(transition)
  }

  async dispose(): Promise<void> {
    const sessions = new Map([...this.transitions].map(([id, transition]) => [id, transition.session]))
    for (const [id, entry] of this.host.entries) sessions.set(id, entry.session)
    const closed = await Promise.allSettled([...sessions.values()].map((session) => this.close(session)))
    const failed = closed.find((result) => result.status === "rejected")
    if (failed?.status === "rejected") throw failed.reason
  }

  private superseded(id: string, cause?: unknown): AcpTransportError | undefined {
    if (unverifiedRetirement(cause) || this.transitions.get(id)?.state !== "closing") return undefined
    return new AcpTransportError("session", "ACP session is closing", cause)
  }

  private begin(id: string, fields: Omit<Transition, "done">, work: Promise<void>): Transition {
    const transition: Transition = { ...fields, done: Promise.resolve() }
    transition.done = work.then(() => {
      if (this.transitions.get(id) === transition) this.transitions.delete(id)
    }, (error: unknown) => { transition.error = error })
    this.transitions.set(id, transition)
    return transition
  }

  private async outcome(transition: Transition): Promise<void> {
    await transition.done
    if (transition.error !== undefined) throw transition.error
  }

  private async retire(id: string, entry: AcpEntry, previous: Transition | undefined): Promise<void> {
    await previous?.done
    this.host.entries.delete(id)
    entry.startupAbort.abort()
    entry.providerTurn?.queue.fail(new AcpTransportError("connection", "ACP session closed"))
    this.host.health.forget(id)
    await this.host.peers.retire(entry.peer)
  }
}
