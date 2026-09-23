import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime"
import {
  connectionIdForHarness,
  sameSessionHarness,
  type AgentExecutionBinding,
} from "@claxedo/agent-runtime-contract"
import type { AgentHarnessAdapter } from "../adapter-contract"
import { messagePartUpdated, type CompatEvent } from "../compat-events"
import type { SessionConfig, SessionConfigUpdate, SessionHandoff, SessionHandoffSource, SessionHarness } from "../index"
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
  diagnose: (event: AgentRuntimeEvent) => void
}

type NativeSession = { agentSessionId: string; ownerKey: string | null }

export class HandoffRollbackError extends AggregateError {
  readonly code = "session_handoff_rollback_failed"

  constructor(readonly handoffError: unknown, readonly rollbackError: unknown) {
    super([handoffError, rollbackError], "Session handoff failed and the target cleanup also failed", { cause: handoffError })
    this.name = "HandoffRollbackError"
  }
}

function withoutSource({ source: _source, ...handoff }: SessionHandoff) {
  return handoff
}

async function releaseNativeSession(input: {
  adapter: AgentHarnessAdapter | Promise<AgentHarnessAdapter>
  harness: SessionHarness
  sessionId: string
  session: NativeSession
  directory: string | undefined
  diagnose: (event: AgentRuntimeEvent) => void
}) {
  try {
    const adapter = await input.adapter
    await adapter.releaseHandoffSource?.(input.sessionId, input.session.agentSessionId, input.session.ownerKey, input.directory)
  } catch (error) {
    input.diagnose(diagnostic(
      "session_handoff_source_cleanup_failed",
      error,
      "Source harness cleanup failed",
      "session.handoff.source-cleanup",
      { sessionId: input.sessionId, sourceHarness: input.harness.id },
    ))
  }
}

async function rollbackHandoff(
  input: HandoffTransactionInput,
  prepared: Awaited<ReturnType<NonNullable<AgentHarnessAdapter["createHandoffSession"]>>> | undefined,
  previous: NativeSession,
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
    agentSessionId: previous.agentSessionId,
    ownerKey: previous.ownerKey,
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

/**
 * Owns the prepare/configure/commit/rollback boundary for a harness switch.
 *
 * The native session being left is kept on the pending handoff until a message
 * is sent on the new harness. Picking it back before then resumes it under the
 * config it had; a harness picked in between carried nothing and is released.
 */
export async function executeHandoffTransaction(input: HandoffTransactionInput): Promise<SessionConfig> {
  const agentSessionId = input.store.getAgentSessionId(input.sessionId)
  if (!agentSessionId) throw new Error(`Session ${input.sessionId} has no native harness session`)
  const previous: NativeSession = { agentSessionId, ownerKey: input.store.getSessionOwnerKey?.(input.sessionId) ?? null }
  const targetDirectory = input.directory ?? input.session.directory
  const pending = input.current.handoff
  const unsent = pending?.pending && !pending.announced && !pending.reason ? pending : undefined
  const from = unsent?.from ?? input.current.harness
  const source: SessionHandoffSource | undefined = unsent ? unsent.source : {
    ...previous,
    upstreamSessionId: input.binding.upstreamSessionId,
    ...(input.current.model ? { model: input.current.model } : {}),
    variant: input.current.variant ?? null,
    agent: input.current.agent ?? null,
    ...(input.current.handoff ? { handoff: withoutSource(input.current.handoff) } : {}),
  }
  const resumed = unsent?.source && sameSessionHarness(from, input.update.harness) ? unsent.source : undefined
  if (!resumed && !input.target.createHandoffSession) {
    throw new Error(`Harness ${input.update.harness.id} does not support conversation handoff`)
  }

  let prepared: Awaited<ReturnType<NonNullable<AgentHarnessAdapter["createHandoffSession"]>>> | undefined
  try {
    let native: Pick<SessionHandoffSource, "agentSessionId" | "upstreamSessionId" | "ownerKey"> | undefined = resumed
    let transcript: string | undefined
    if (!native) {
      transcript = renderSessionHandoff(input.store.getMessages(input.sessionId), from)
      prepared = await input.target.createHandoffSession!(
        targetDirectory,
        input.session.title ?? undefined,
        input.sessionId,
        { system: transcript },
      )
      const id = prepared.agentSessionId ?? prepared.id
      native = { agentSessionId: id, upstreamSessionId: id, ownerKey: prepared.ownerKey ?? null }
    }
    input.store.bindSession({
      scope: input.binding.scope,
      sessionId: input.sessionId,
      workspaceId: input.binding.workspaceId,
      directory: targetDirectory ?? "",
      connectionId: connectionIdForHarness(input.update.harness),
      upstreamSessionId: native.upstreamSessionId,
      title: input.session.title ?? undefined,
      agentSessionId: native.agentSessionId,
      ownerKey: native.ownerKey,
    })
    const targetBinding: AgentExecutionBinding = {
      ...input.binding, directory: targetDirectory ?? "",
      connectionId: connectionIdForHarness(input.update.harness),
      upstreamSessionId: native.upstreamSessionId,
    }
    const configured = await input.target.updateSessionConfig(targetBinding, {
      ...input.update,
      ...(input.update.model === undefined ? { model: resumed?.model ?? null } : {}),
      ...(input.update.variant === undefined ? { variant: resumed?.variant ?? null } : {}),
      ...(input.update.agent === undefined ? { agent: resumed?.agent ?? null } : {}),
    })
    const next = input.store.updateSessionConfig(input.sessionId, {
      ...configured,
      harness: input.update.harness,
      model: configured.model ?? null,
      variant: configured.variant ?? null,
      agent: configured.agent ?? null,
      handoff: transcript === undefined
        ? resumed?.handoff ?? null
        : { from, pending: true, transcript, ...(source ? { source } : {}) },
    })!
    if (unsent) {
      await releaseNativeSession({
        adapter: input.source,
        harness: input.current.harness,
        sessionId: input.sessionId,
        session: previous,
        directory: input.session.directory ?? targetDirectory,
        diagnose: input.diagnose,
      })
    }
    return next
  } catch (error) {
    await rollbackHandoff(input, prepared, previous, error)
    throw error
  }
}

type KeptSourceInput = {
  sessionId: string
  directory: string | undefined
  config: SessionConfig | null | undefined
  adapterFor(harness: SessionHarness): Promise<AgentHarnessAdapter>
  diagnose: (event: AgentRuntimeEvent) => void
}

/** Releases the native session a pending handoff still keeps. */
export async function releaseKeptHandoffSource(input: KeptSourceInput) {
  const handoff = input.config?.handoff
  if (!handoff?.source) return
  await releaseNativeSession({
    adapter: input.adapterFor(handoff.from),
    harness: handoff.from,
    sessionId: input.sessionId,
    session: handoff.source,
    directory: input.directory,
    diagnose: input.diagnose,
  })
}

/**
 * Writes the handoff part owed to the user message that opens a turn on a
 * switched harness, once, and releases the native session the handoff kept.
 * Nothing is owed when the harnesses picked since the last sent message came
 * back to the one the conversation left.
 */
export function announceHandoff(input: KeptSourceInput & {
  userMessageId: string
  store: Pick<AgentRuntimeStoreWithRecovery, "updateSessionConfig">
  commit(event: CompatEvent): void
}) {
  const { config } = input
  if (!config?.handoff?.pending || config.handoff.announced) return
  const handoff = config.handoff
  const from = { id: handoff.from.id, access: handoff.from.access }
  const to = { id: config.harness.id, access: config.harness.access }
  if (sameSessionHarness(from, to)) return
  input.commit(messagePartUpdated({
    id: `${input.userMessageId}-handoff`,
    sessionID: input.sessionId,
    messageID: input.userMessageId,
    type: "handoff",
    from,
    to,
  }))
  input.store.updateSessionConfig(input.sessionId, { handoff: { ...withoutSource(handoff), announced: true } })
  void releaseKeptHandoffSource(input)
}
