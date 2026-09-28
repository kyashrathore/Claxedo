import { randomUUID } from "node:crypto"
import {
  AgentRuntimeContractError,
  connectionIdForHarness,
  type AgentSession,
  type SessionConfig,
  type SessionConfigUpdate,
  type SessionHandoffSource,
  type SessionHarness,
} from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { admitSessionInstructions, type RuntimeDirectory } from "@claxedo/agent-sdk-runtime"
import { createSessionBroker, type createRequestBroker, type SessionBrokerContext } from "@claxedo/harness/broker"
import { applySessionConfigUpdate, type HarnessSession, type SessionBroker, type TurnActor } from "@claxedo/harness/contract"
import { SessionAttachments, type AttachedSession } from "./attachments"
import type { AgentRuntimeEventEnvelope, AgentRuntimeSessionCreateInput, AgentRuntimeStore } from "./contracts"
import { assertSessionCreateBindingScope, normalizeDirectory, requireExecutionBinding } from "./execution-binding"
import { executeHandoffTransaction, releaseKeptHandoffSource, type OpenedTarget } from "./handoff"
import { attachInput, startInput, type LaunchComposer } from "./launch"
import type { createSessionTitleOwner } from "./session-titles"
import type { TurnAdmissions } from "./turn-admission"
import type { TransportResolver } from "./transports"

export type SessionLifecycleInput = {
  store: AgentRuntimeStore
  transports: TransportResolver
  launch: LaunchComposer
  broker: ReturnType<typeof createRequestBroker>
  attachments: SessionAttachments
  admissions: TurnAdmissions
  workspaceId: string
  publish: (event: AgentRuntimeEventEnvelope) => void
  reportSessionFailure: (sessionId: string, error: unknown) => void
  forgetGoal: (sessionId: string) => void
  pushTitle: ReturnType<typeof createSessionTitleOwner>["push"]
}

function key(input: Pick<SessionConfig, "harness">["harness"]) {
  return `${input.id}:${input.access}`
}

function keptKey(sessionId: string, harness: SessionHarness, upstreamSessionId: string) {
  return `${sessionId}\0${key(harness)}\0${upstreamSessionId}`
}

function retainedFields(input: { instructions?: string; group?: AgentRuntimeSessionCreateInput["group"] }) {
  return {
    ...(input.instructions ? { instructions: input.instructions } : {}),
    ...(input.group ? { group: input.group } : {}),
  }
}

/**
 * Session lifecycle over the transports: a create binds the session, starts it
 * on its harness and keeps it attached; a switch opens the target and keeps
 * the left native session until a turn runs on the new one; a delete closes
 * the harness side, releases a kept source and removes the rows.
 */
export function createSessionLifecycle(input: SessionLifecycleInput) {
  const { store, transports, launch, attachments, admissions } = input
  const keptSources = new Map<string, AttachedSession>()

  const diagnose = (sessionId: string, directory: RuntimeDirectory) => (payload: AgentRuntimeEvent) =>
    input.publish({ sessionId, directory, payload })

  const brokerContext = (create: AgentRuntimeSessionCreateInput, sessionId: string): SessionBrokerContext => {
    const base = { sessionId, directory: normalizeDirectory(create.directory), workspaceId: create.workspaceId, origin: create.origin }
    return create.start
      ? { ...base, start: create.start, connectionId: create.start.connectionId, operationId: create.start.operationId }
      : base
  }

  const endStart = async (context: SessionBrokerContext) => {
    if (!context.start) return
    try {
      await input.broker.endStart(context)
    } catch (error) {
      input.reportSessionFailure(context.sessionId, error)
    }
  }

  const detachedBroker = (sessionId: string, directory: string, owner: TurnActor, binding: HarnessSession["binding"]): SessionBroker => ({
    ...createSessionBroker(input.broker, { sessionId, directory, workspaceId: input.workspaceId, origin: { actor: owner, via: "service", reissued: false } }),
    rebind: async (upstreamSessionId) => Object.freeze({ ...binding, upstreamSessionId }),
  })

  /** Closes the native session a left harness holds, attaching it first when this process never held it. */
  const closeSource = async (harness: SessionHarness, source: SessionHandoffSource, sessionId: string, directory: string | undefined) => {
    const keptId = keptKey(sessionId, harness, source.upstreamSessionId)
    const kept = keptSources.get(keptId)
    if (kept) {
      keptSources.delete(keptId)
      await kept.handle.transport.close(kept.session)
      return
    }
    const binding = attachments.binding(sessionId)
    const current = store.getSessionConfig(sessionId)
    if (!current) throw new Error(`Session ${sessionId} has no runtime config`)
    const targetDirectory = directory ?? binding.directory
    const handle = await transports.forHarness(harness, targetDirectory)
    const owner = attachments.owner(sessionId)
    const left = Object.freeze({ ...binding, connectionId: connectionIdForHarness(harness), upstreamSessionId: source.upstreamSessionId })
    const session = await handle.transport.attach(attachInput(launch, {
      sessionId, directory: targetDirectory, locality: handle.locality,
      config: { ...current, harness, ...(source.model ? { model: source.model } : {}), variant: source.variant ?? undefined, agent: source.agent ?? undefined },
      owner,
    }, left), detachedBroker(sessionId, targetDirectory, owner, left))
    await handle.transport.close(session)
  }

  const resumeSource = (sessionId: string, harness: SessionHarness, source: SessionHandoffSource) => {
    const keptId = keptKey(sessionId, harness, source.upstreamSessionId)
    const kept = keptSources.get(keptId)
    if (!kept) return
    keptSources.delete(keptId)
    attachments.register(sessionId, kept)
  }

  const openTarget = (sessionId: string, owner: TurnActor, title: string | undefined) =>
    async (config: SessionConfig, directory: string | undefined): Promise<OpenedTarget> => {
      const targetDirectory = normalizeDirectory(directory)
      const handle = await transports.forHarness(config.harness, targetDirectory)
      const context: SessionBrokerContext = { sessionId, directory: targetDirectory, workspaceId: input.workspaceId,
        origin: { actor: owner, via: "service", reissued: false } }
      const broker = createSessionBroker(input.broker, context)
      const session = await handle.transport.start(startInput(launch, {
        sessionId, directory: targetDirectory, locality: handle.locality, config, owner,
        ...(title !== undefined ? { title } : {}),
        ...(config.instructions ? { instructions: config.instructions } : {}),
      }), broker)
      const declared = await handle.transport.capabilities({ directory: targetDirectory, sessionId })
      const attached: AttachedSession = { handle, session, broker, context, owner }
      attachments.register(sessionId, attached)
      return {
        attached,
        configOwner: declared.configOwner,
        rollback: async () => {
          attachments.forget(sessionId)
          await handle.transport.close(session)
        },
      }
    }

  const updateSessionConfig = async (sessionId: string, update: SessionConfigUpdate, directory?: RuntimeDirectory) => {
    const current = store.getSessionConfig(sessionId)
    const changingHarness = !!current && !!update.harness && key(current.harness) !== key(update.harness)
    if (!changingHarness) {
      const attached = await attachments.for(sessionId, directory)
      const declared = await attached.handle.transport.capabilities({ directory: attached.session.directory, sessionId })
      const configured = declared.configOwner === "harness" && attached.handle.transport.config
        ? await attached.handle.transport.config.update(attached.session, update)
        : applySessionConfigUpdate(current!, update)
      const persisted = store.updateSessionConfig(sessionId, configured)
      if (!persisted) throw new Error(`Session ${sessionId} has no runtime config`)
      return persisted
    }
    const session = store.getSession(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)
    const targetDirectory = directory ?? session.directory
    const previousBinding = requireExecutionBinding(store, sessionId, targetDirectory, current.harness)
    const left = attachments.forget(sessionId)
    const leftKey = keptKey(sessionId, current.harness, previousBinding.upstreamSessionId)
    if (left) keptSources.set(leftKey, left)
    try {
      return await executeHandoffTransaction({
        sessionId, directory: targetDirectory, session, current, update: { ...update, harness: update.harness! },
        binding: previousBinding, store, admissions,
        diagnose: diagnose(sessionId, targetDirectory),
        openTarget: openTarget(sessionId, attachments.owner(sessionId), session.title ?? undefined),
        closeSource: (harness, source, dir) => closeSource(harness, source, sessionId, dir),
        resumeSource: (harness, source) => resumeSource(sessionId, harness, source),
      })
    } catch (error) {
      if (left) {
        keptSources.delete(leftKey)
        attachments.register(sessionId, left)
      }
      throw error
    }
  }

  return {
    updateSessionConfig,
    closeSource,
    async create(create: AgentRuntimeSessionCreateInput): Promise<AgentSession> {
      if (typeof create.workspaceId !== "string" || create.workspaceId.trim() === "") {
        throw new AgentRuntimeContractError({ code: "invalid_execution_binding", field: "workspaceId", message: "execution binding workspaceId is required" })
      }
      if (typeof create.directory !== "string" || !create.directory.trim()) {
        throw new AgentRuntimeContractError({ code: "invalid_execution_binding", field: "directory", message: "execution binding directory is required" })
      }
      if (create.id) assertSessionCreateBindingScope(store, create.id, create)
      const directory = normalizeDirectory(create.directory)
      const handle = await transports.forHarness(create.harness, directory)
      const declared = await handle.transport.capabilities({ directory })
      const refusal = admitSessionInstructions({ harness: create.harness.id, channel: declared.instructionChannel, instructions: create.instructions })
      if (refusal?.reason === "no_instruction_channel") {
        throw new AgentRuntimeContractError({ code: "unsupported_operation", operation: "session_instructions", message: refusal.message })
      }
      if (refusal) throw new Error(refusal.message)
      const sessionId = create.id ?? `ses_${randomUUID()}`
      const existed = !!store.getSession(sessionId)
      const config: SessionConfig = {
        harness: create.harness,
        ...(create.model ? { model: create.model } : {}),
        variant: create.variant ?? null,
        agent: create.agent ?? null,
        ...(create.permissionCeiling ? { permissionCeiling: create.permissionCeiling } : {}),
        ...retainedFields(create),
      }
      store.recordSessionOwner(sessionId, create.owner)
      store.bindSession({
        sessionId, workspaceId: create.workspaceId, directory,
        connectionId: connectionIdForHarness(create.harness), upstreamSessionId: sessionId, agentSessionId: sessionId,
        ...(create.title ? { title: create.title } : {}),
        ...(create.parentID ? { parentSessionId: create.parentID } : {}),
      })
      const context = brokerContext(create, sessionId)
      const broker = createSessionBroker(input.broker, context)
      let session: HarnessSession
      try {
        if (!store.updateSessionConfig(sessionId, config)) throw new Error(`Session ${sessionId} has no runtime config`)
        session = await handle.transport.start(startInput(launch, {
          sessionId, directory, locality: handle.locality, config, owner: create.owner,
          ...(create.title !== undefined ? { title: create.title } : {}),
          ...(create.instructions ? { instructions: create.instructions } : {}),
        }), broker)
      } catch (error) {
        await endStart(context)
        if (!existed) {
          input.broker.broker.closeSession(sessionId)
          store.deleteSession(sessionId)
        }
        throw error
      }
      await endStart(context)
      attachments.register(sessionId, { handle, session, broker, context, owner: create.owner })
      const persisted = store.getSession(sessionId)
      if (!persisted) throw new Error(`Session ${sessionId} was not persisted`)
      return persisted
    },
    async update(sessionId: string, updates: { title?: string; time?: { archived?: number } }, directory?: RuntimeDirectory) {
      const persisted = store.updateSession(sessionId, {
        ...(updates.title !== undefined ? { title: updates.title } : {}),
        ...(updates.time?.archived !== undefined ? { time: { archived: updates.time.archived } } : {}),
      })
      if (!persisted) throw new Error(`Session ${sessionId} not found`)
      if (updates.title !== undefined) {
        await input.pushTitle(sessionId, updates.title, async () => {
          const attached = await attachments.for(sessionId, directory)
          return { transport: attached.handle.transport, session: attached.session }
        })
      }
      return persisted
    },
    async delete(sessionId: string, directory?: RuntimeDirectory) {
      const config = store.getSessionConfig(sessionId)
      const attached = await attachments.for(sessionId, directory)
      await attached.handle.transport.close(attached.session)
      input.broker.broker.closeSession(sessionId)
      attachments.forget(sessionId)
      await releaseKeptHandoffSource({
        sessionId, directory: attached.session.directory, config,
        closeSource: (harness, source, dir) => closeSource(harness, source, sessionId, dir),
        diagnose: diagnose(sessionId, attached.session.directory),
      })
      store.deleteSession(sessionId)
      input.forgetGoal(sessionId)
    },
    async fork(sessionId: string, messageId: string, childId: string | undefined, directory?: RuntimeDirectory): Promise<{ id: string }> {
      const attached = await attachments.for(sessionId, directory)
      const ops = attached.handle.transport.fork
      if (!ops) throw new AgentRuntimeContractError({ code: "unsupported_operation", operation: "fork", message: `${attached.handle.runner.id} does not support fork` })
      const id = childId ?? `ses_${randomUUID()}`
      const { upstreamSessionId } = await ops.fork(attached.session, messageId, id)
      const config = store.getSessionConfig(sessionId)
      if (!config) throw new Error(`Session ${sessionId} has no runtime config`)
      const binding = attached.session.binding
      store.recordSessionOwner(id, attached.owner)
      store.bindSession({
        sessionId: id, workspaceId: binding.workspaceId, directory: binding.directory,
        connectionId: binding.connectionId, upstreamSessionId, agentSessionId: upstreamSessionId,
      })
      store.updateSessionConfig(id, config)
      return { id }
    },
  }
}
