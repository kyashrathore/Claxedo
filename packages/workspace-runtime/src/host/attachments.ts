import { AgentRuntimeContractError, type AgentExecutionBinding, type SessionHarness } from "@claxedo/agent-runtime-contract"
import { createSessionBroker, type BrokerOwner, type SessionBrokerContext } from "@claxedo/harness/broker"
import { CredentialSelectionError } from "@claxedo/harness/registry"
import type { HarnessSession, SessionBroker, TurnActor, TurnOrigin } from "@claxedo/harness/contract"
import type { AgentRuntimeStore } from "./contracts"
import { attachInput, type LaunchComposer } from "./launch"
import type { HarnessHandle, TransportResolver } from "./transports"

export type AttachedSession = {
  handle: HarnessHandle
  session: HarnessSession
  broker: SessionBroker
  context: SessionBrokerContext
  owner: TurnActor
}

type AttachmentsInput = {
  store: AgentRuntimeStore
  transports: TransportResolver
  launch: LaunchComposer
  broker: BrokerOwner
  workspaceId: string
}

function serviceOrigin(owner: TurnActor): TurnOrigin {
  return { actor: owner, via: "service", reissued: false }
}

/**
 * The sessions this host holds open on a transport. A session is attached
 * lazily from its durable binding the first time it is used after a restart
 * or after its transport was replaced, and every handle read here carries the
 * binding the store holds now, so a rebind by a handoff is never served from a
 * stale copy.
 */
export class SessionAttachments {
  private readonly attached = new Map<string, AttachedSession>()
  private readonly attaching = new Map<string, Promise<AttachedSession>>()

  constructor(private readonly input: AttachmentsInput) {}

  register(sessionId: string, attachment: AttachedSession): void {
    this.attached.set(sessionId, attachment)
  }

  forget(sessionId: string): AttachedSession | undefined {
    const current = this.attached.get(sessionId)
    this.attached.delete(sessionId)
    return current
  }

  peek(sessionId: string): AttachedSession | undefined {
    const current = this.attached.get(sessionId)
    if (!current || current.handle.retired()) return undefined
    return this.current(sessionId, current)
  }

  entries(): AttachedSession[] {
    return [...this.attached.values()].filter((entry) => !entry.handle.retired())
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

  async for(sessionId: string, directory?: string): Promise<AttachedSession> {
    const current = this.attached.get(sessionId)
    if (current && !current.handle.retired()) return this.current(sessionId, current)
    const pending = this.attaching.get(sessionId)
    if (pending) return await pending
    const attaching = this.attach(sessionId, directory).finally(() => this.attaching.delete(sessionId))
    this.attaching.set(sessionId, attaching)
    return await attaching
  }

  private current(sessionId: string, entry: AttachedSession): AttachedSession {
    const binding = this.binding(sessionId)
    if (binding.upstreamSessionId === entry.session.binding.upstreamSessionId &&
      binding.connectionId === entry.session.binding.connectionId) return entry
    return { ...entry, session: { ...entry.session, binding } }
  }

  private async attach(sessionId: string, requestedDirectory?: string): Promise<AttachedSession> {
    const config = this.input.store.getSessionConfig(sessionId)
    if (!config) throw new Error(`Session ${sessionId} has no runtime config`)
    const binding = this.binding(sessionId)
    const directory = requestedDirectory ?? binding.directory
    const handle = await this.input.transports.forHarness(config.harness, directory)
    const owner = this.owner(sessionId)
    const context: SessionBrokerContext = { sessionId, directory, workspaceId: this.input.workspaceId, origin: serviceOrigin(owner) }
    const broker = createSessionBroker(this.input.broker, context)
    const session = await handle.transport.attach(attachInput(this.input.launch, {
      sessionId, directory, locality: handle.locality, config, owner,
    }, binding), broker)
    const attachment: AttachedSession = { handle, session, broker, context, owner }
    this.attached.set(sessionId, attachment)
    return attachment
  }

  /** The harness a session runs on, without attaching it. */
  harnessOf(sessionId: string): SessionHarness | undefined {
    return this.input.store.getSessionConfig(sessionId)?.harness
  }
}
