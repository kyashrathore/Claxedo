import type { AgentSession, SessionConfig, SessionConfigUpdate } from "../../index"
import type { AgentRuntimeStore } from "./runtime-store"

export function acceptedSessionUpdate(
  store: AgentRuntimeStore,
  sessionId: string,
  updates: { title?: string; time?: { archived?: number } },
): AgentSession | null {
  const current = store.getSession(sessionId) as AgentSession | null
  if (!current) return null
  return {
    ...current,
    ...(updates.title !== undefined ? { title: updates.title } : {}),
    time: {
      created: current.time?.created ?? Date.now(),
      ...current.time,
      updated: Date.now(),
      ...(updates.time?.archived !== undefined ? { archived: updates.time.archived } : {}),
    },
  }
}

export function acceptedSessionConfig(
  current: SessionConfig,
  update: SessionConfigUpdate,
): SessionConfig {
  return {
    harness: update.harness ?? current.harness,
    ...(update.model === undefined
      ? current.model ? { model: current.model } : {}
      : update.model ? { model: update.model } : {}),
    variant: update.variant === undefined ? current.variant ?? null : update.variant,
    agent: update.agent === undefined ? current.agent ?? null : update.agent,
    ...(update.handoff === undefined
      ? current.handoff !== undefined ? { handoff: current.handoff } : {}
      : { handoff: update.handoff }),
  }
}

export function completeSessionConfigUpdate(
  current: SessionConfig,
  update: SessionConfigUpdate,
): SessionConfigUpdate {
  const desired = acceptedSessionConfig(current, update)
  return {
    harness: desired.harness,
    model: desired.model ?? null,
    variant: desired.variant ?? null,
    agent: desired.agent ?? null,
    handoff: desired.handoff ?? null,
  }
}
