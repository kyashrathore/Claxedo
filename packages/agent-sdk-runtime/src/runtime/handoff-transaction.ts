import { randomUUID } from "crypto"
import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime"
import {
  connectionIdForHarness,
  type AgentExecutionBinding,
} from "@claxedo/agent-runtime-contract"
import type { AgentHarnessAdapter } from "../adapter-contract"
import { buildUserMessage, messagePartUpdated, messageUpdated, type CompatEvent } from "../compat-events"
import type { SessionConfig, SessionConfigUpdate, SessionHarness } from "../index"
import { renderSessionHandoff } from "../session-handoff"
import type { AgentRuntimeStoreWithRecovery } from "../harnesses/shared/runtime-store"

type HandoffSession = {
  title?: string | null
  directory?: string
}

export type HandoffTransactionInput = {
  sessionId: string
  directory: string | undefined
  session: HandoffSession
  current: SessionConfig
  update: SessionConfigUpdate & { harness: SessionHarness }
  store: AgentRuntimeStoreWithRecovery
  source: AgentHarnessAdapter
  target: AgentHarnessAdapter
  binding: AgentExecutionBinding
  commit(event: CompatEvent): void
  diagnose(event: AgentRuntimeEvent): void
}

export class HandoffRollbackError extends AggregateError {
  readonly code = "session_handoff_rollback_failed"

  constructor(readonly handoffError: unknown, readonly rollbackError: unknown) {
    super([handoffError, rollbackError], "Session handoff failed and the target cleanup also failed", { cause: handoffError })
    this.name = "HandoffRollbackError"
  }
}

async function releaseSource(
  input: HandoffTransactionInput,
  previousAgentSessionId: string,
  previousOwnerKey: string | null,
  targetDirectory: string | undefined,
) {
  try {
    await input.source.releaseHandoffSource?.(
      input.sessionId,
      previousAgentSessionId,
      previousOwnerKey,
      input.session.directory ?? targetDirectory,
    )
  } catch (error) {
    input.diagnose(diagnostic(
      "session_handoff_source_cleanup_failed",
      error,
      "Source harness cleanup failed",
      "session.handoff.source-cleanup",
      { sessionId: input.sessionId, sourceHarness: input.current.harness.id },
    ))
  }
}

async function rollbackHandoff(
  input: HandoffTransactionInput,
  prepared: Awaited<ReturnType<NonNullable<AgentHarnessAdapter["createHandoffSession"]>>> | undefined,
  previousAgentSessionId: string,
  previousOwnerKey: string | null,
  handoffError: unknown,
) {
  let rollbackFailure: unknown
  try {
    await prepared?.rollback()
  } catch (error) {
    rollbackFailure = error
    input.diagnose(diagnostic(
      "session_handoff_rollback_failed",
      error,
      "Target harness rollback failed",
      "session.handoff.rollback",
      { sessionId: input.sessionId, targetHarness: input.update.harness.id },
    ))
  }
  input.store.bindSession({
    scope: input.binding.scope,
    sessionId: input.sessionId,
    workspaceId: input.binding.workspaceId,
    directory: input.session.directory ?? "",
    connectionId: input.binding.connectionId,
    upstreamSessionId: input.binding.upstreamSessionId,
    title: input.session.title ?? undefined,
    agentSessionId: previousAgentSessionId,
    ownerKey: previousOwnerKey,
  })
  input.store.updateSessionConfig(input.sessionId, {
    harness: input.current.harness,
    model: input.current.model ?? null,
    variant: input.current.variant ?? null,
    agent: input.current.agent ?? null,
    handoff: input.current.handoff ?? null,
  })
  if (rollbackFailure !== undefined) throw new HandoffRollbackError(handoffError, rollbackFailure)
}

function diagnostic(
  code: string,
  error: unknown,
  fallback: string,
  method: string,
  details: Record<string, unknown>,
): AgentRuntimeEvent {
  return {
    type: "diagnostic",
    diagnostic: {
      code,
      message: error instanceof Error ? error.message : fallback,
      severity: "error",
      source: "agent-sdk-runtime",
      method,
      details,
    },
  }
}

/** Owns the prepare/configure/commit/rollback boundary for a harness switch. */
export async function executeHandoffTransaction(input: HandoffTransactionInput): Promise<SessionConfig> {
  const previousAgentSessionId = input.store.getAgentSessionId(input.sessionId)
  if (!previousAgentSessionId) throw new Error(`Session ${input.sessionId} has no native harness session`)
  const previousOwnerKey = input.store.getSessionOwnerKey?.(input.sessionId) ?? null
  const targetDirectory = input.directory ?? input.session.directory
  const transcript = renderSessionHandoff(
    input.store.getMessages(input.sessionId),
    input.current.harness,
  )
  if (!input.target.createHandoffSession) {
    throw new Error(`Harness ${input.update.harness.id} does not support conversation handoff`)
  }

  let prepared: Awaited<ReturnType<NonNullable<AgentHarnessAdapter["createHandoffSession"]>>> | undefined
  try {
    prepared = await input.target.createHandoffSession(
      targetDirectory,
      input.session.title ?? undefined,
      input.sessionId,
      { system: transcript },
    )
    input.store.bindSession({
      scope: input.binding.scope,
      sessionId: input.sessionId,
      workspaceId: input.binding.workspaceId,
      directory: targetDirectory ?? "",
      connectionId: connectionIdForHarness(input.update.harness),
      upstreamSessionId: prepared.agentSessionId ?? prepared.id,
      title: input.session.title ?? undefined,
      agentSessionId: prepared.agentSessionId ?? prepared.id,
      ownerKey: prepared.ownerKey ?? null,
    })
    const targetBinding: AgentExecutionBinding = {
      ...input.binding, directory: targetDirectory ?? "",
      connectionId: connectionIdForHarness(input.update.harness),
      upstreamSessionId: prepared.agentSessionId ?? prepared.id,
    }
    const configured = await input.target.updateSessionConfig(targetBinding, {
      ...input.update,
      ...(input.update.model === undefined ? { model: null } : {}),
      ...(input.update.variant === undefined ? { variant: null } : {}),
      ...(input.update.agent === undefined ? { agent: null } : {}),
    })
    const next = input.store.updateSessionConfig(input.sessionId, {
      ...configured,
      harness: input.update.harness,
      model: configured.model ?? null,
      variant: configured.variant ?? null,
      agent: configured.agent ?? null,
      handoff: { from: input.current.harness, pending: true, transcript },
    })!
    const markerId = `handoff-${randomUUID()}`
    const createdAt = Date.now()
    const markerModel = configured.model ?? { providerID: input.update.harness.id, modelID: "default" }
    input.commit(messageUpdated(buildUserMessage({
      id: markerId,
      sessionID: input.sessionId,
      agent: configured.agent ?? "build",
      model: markerModel,
      created: createdAt,
    })))
    input.commit(messagePartUpdated({
      id: `${markerId}-part`,
      sessionID: input.sessionId,
      messageID: markerId,
      type: "handoff",
      from: input.current.harness,
      to: input.update.harness,
    }))
    await releaseSource(input, previousAgentSessionId, previousOwnerKey, targetDirectory)
    return next
  } catch (error) {
    await rollbackHandoff(input, prepared, previousAgentSessionId, previousOwnerKey, error)
    throw error
  }
}
