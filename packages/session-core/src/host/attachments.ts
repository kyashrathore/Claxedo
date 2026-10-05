import { AgentRuntimeContractError, type AgentExecutionBinding, type SessionHarness } from "@claxedo/agent-runtime-contract"
import { createSessionBroker, type BrokerOwner, type SessionBrokerContext } from "@claxedo/harness/broker"
import { CredentialSelectionError } from "@claxedo/harness/registry"
import type { HarnessSession, SessionBroker, TurnActor, TurnOrigin } from "@claxedo/harness/contract"
import type { ConnectionSecretAuthority } from "@claxedo/agent-runtime-contract"
import { createKeyedSerializer } from "@claxedo/helpers"
import type { AgentRuntimeStore } from "./contracts"
import { attachInput, type LaunchComposer } from "./launch"
import type { PermissionModeWrite } from "./session-row"
import type { HarnessHandle, TransportResolver } from "./transports"

export type AttachedSession = {
  handle: HarnessHandle
  session: HarnessSession
  broker: SessionBroker
  context: SessionBrokerContext
  owner: TurnActor
}

/** The transport a read addresses, and the session's attachment only when it is already held. */
export type UnattachedRead = { handle: HarnessHandle; directory: string; attached?: AttachedSession }

type AttachmentsInput = {
  store: AgentRuntimeStore
  transports: TransportResolver
  launch: LaunchComposer
  broker: BrokerOwner
  workspaceId: string
  executing: (sessionId: string, generation: object) => AttachedSession | undefined
  /** Whether a turn of the session is admitted or still finishing, which keeps its attachment held. */
  busy: (sessionId: string) => boolean
  writeMode: PermissionModeWrite
}

function serviceOrigin(owner: TurnActor): TurnOrigin {
  return { actor: owner, via: "service", reissued: false }
}

/**
 * The sessions this host holds open on a transport. A session is attached
 * lazily from its durable binding the first time it is used after a restart
 * or after its transport was replaced. Every attachment read here is brought
 * to the binding the store holds now, in place, whether a handoff or the
 * harness itself rebound it: a transport refuses a session under a stale
 * upstream id, and readers that key state on the attachment must keep finding
 * the same object.
 */
export class SessionAttachments {
  private readonly attached = new Map<string, AttachedSession>()
  private readonly released = new Set<string>()
  private readonly attaching = createKeyedSerializer()

  constructor(private readonly input: AttachmentsInput) {}

  register(sessionId: string, attachment: AttachedSession): void {
    this.released.delete(sessionId)
    this.attached.set(sessionId, attachment)
  }

  forget(sessionId: string): AttachedSession | undefined {
    const current = this.attached.get(sessionId)
    this.attached.delete(sessionId)
    this.released.delete(sessionId)
    return current
  }

  /** Whether the session's harness execution was released and not attached since, so it has nothing left to close. */
  isReleased(sessionId: string): boolean {
    return this.released.has(sessionId)
  }

  peek(sessionId: string): AttachedSession | undefined {
    const current = this.attached.get(sessionId)
    if (!current || current.handle.retired()) return undefined
    return this.current(sessionId, current)
  }

  entries(): AttachedSession[] {
    return [...this.attached].filter(([, entry]) => !entry.handle.retired()).map(([sessionId, entry]) => this.current(sessionId, entry))
  }

  owner(sessionId: string): TurnActor {
    const owner = this.input.store.sessionOwner(sessionId)
    if (!owner) throw new CredentialSelectionError("account_unavailable", `Session ${sessionId} has no recorded owner`)
    return owner
  }

  binding(sessionId: string): AgentExecutionBinding {
    const binding = this.input.store.getExecutionBinding(sessionId)
    if (!binding) {
      throw new AgentRuntimeContractError({
        code: "invalid_execution_binding",
        field: "upstreamSessionId",
        message: `Session ${sessionId} has no complete execution binding`,
      })
    }
    return binding
  }

  /**
   * The attachment a control or read addresses: the executing one when it
   * targets that turn's generation, else the one held now, reused without
   * leasing its secrets again. Only admitting a turn revalidates a connection;
   * `authority` is what a session not held yet is attached under.
   */
  async for(sessionId: string, directory?: string, generation?: object, authority?: ConnectionSecretAuthority): Promise<AttachedSession> {
    const executing = generation ? this.input.executing(sessionId, generation) : undefined
    if (executing) return this.current(sessionId, executing)
    return await this.attaching.run(sessionId, async () => this.peek(sessionId) ?? await this.attach(sessionId, directory, authority))
  }

  /**
   * Ends the harness execution of a session nothing is using, keeping its
   * binding so a later use attaches it again; false while a turn holds it or
   * its transport finds anything live. Serialized with every attach, so a use
   * that arrives meanwhile finds the held attachment or makes a fresh one.
   */
  async release(sessionId: string): Promise<boolean> {
    return await this.attaching.run(sessionId, async () => {
      const attached = this.attached.get(sessionId)
      if (!attached || attached.handle.retired() || this.input.busy(sessionId)) return false
      const transport = attached.handle.transport
      if (!transport.release || !(await transport.release(attached.session))) return false
      this.attached.delete(sessionId)
      this.released.add(sessionId)
      return true
    })
  }

  /**
   * The transport a read addresses without attaching the session. Attaching
   * launches the harness process for most transports, so a session nobody is
   * running is answered from its harness's declared facts instead.
   */
  async withoutAttaching(sessionId: string, requestedDirectory?: string, authority?: ConnectionSecretAuthority): Promise<UnattachedRead> {
    const attached = this.peek(sessionId)
    if (attached) return { handle: attached.handle, directory: attached.session.directory, attached }
    const harness = this.harnessOf(sessionId)
    if (!harness) throw new Error(`Session ${sessionId} has no runtime config`)
    const directory = requestedDirectory ?? this.binding(sessionId).directory
    const handle = await this.input.transports.forHarness(harness, directory, { owner: this.owner(sessionId), ...(authority ? { authority } : {}) })
    return { handle, directory }
  }

  /** The attachment a new turn runs on, after its connection and secret lease are resolved again under the turn's authority. */
  async admit(sessionId: string, authority?: ConnectionSecretAuthority): Promise<AttachedSession> {
    return await this.attaching.run(sessionId, () => this.attach(sessionId, undefined, authority))
  }

  private current(sessionId: string, entry: AttachedSession): AttachedSession {
    const binding = this.binding(sessionId)
    if (binding.upstreamSessionId !== entry.session.binding.upstreamSessionId ||
      binding.connectionId !== entry.session.binding.connectionId) entry.session = { ...entry.session, binding }
    return entry
  }

  private async attach(sessionId: string, requestedDirectory?: string, authority?: ConnectionSecretAuthority): Promise<AttachedSession> {
    const config = this.input.store.getSessionConfig(sessionId)
    if (!config) throw new Error(`Session ${sessionId} has no runtime config`)
    const binding = this.binding(sessionId)
    const directory = requestedDirectory ?? binding.directory
    const owner = this.owner(sessionId)
    const handle = await this.input.transports.forHarness(config.harness, directory, { owner, ...(authority ? { authority } : {}) })
    const current = this.attached.get(sessionId)
    if (current?.handle === handle && !handle.retired()) return this.current(sessionId, current)
    const context: SessionBrokerContext = { sessionId, directory, workspaceId: this.input.workspaceId, origin: serviceOrigin(owner) }
    const broker = createSessionBroker(this.input.broker, context)
    const session = await handle.transport.attach(attachInput(this.input.launch, {
      sessionId, directory, locality: handle.locality, config, owner,
      permissionModeKept: (mode) => this.input.writeMode(sessionId, mode),
    }, binding, this.input.store.upstreamHasTurns(sessionId, binding.upstreamSessionId)), broker)
    const attachment: AttachedSession = { handle, session, broker, context, owner }
    this.register(sessionId, attachment)
    return attachment
  }

  /** The harness a session runs on, without attaching it. */
  harnessOf(sessionId: string): SessionHarness | undefined {
    return this.input.store.getSessionConfig(sessionId)?.harness
  }
}
