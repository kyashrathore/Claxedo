import type { AgentSession, SessionConfig, SessionConfigUpdate } from "../../index"
import type { AgentRuntimeStoreCore } from "./runtime-store"

export function acceptedSessionUpdate(
  store: AgentRuntimeStoreCore,
  sessionId: string,
  updates: { title?: string; time?: { archived?: number } },
): AgentSession | null {
  const current = store.getSession(sessionId)
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
    ...(update.permissionMode === undefined
      ? current?.permissionMode && (!update.harness || (update.harness.id === current.harness.id && update.harness.access === current.harness.access)) ? { permissionMode: current.permissionMode } : {}
      : update.permissionMode ? { permissionMode: update.permissionMode } : {}),
    ...(update.permissionState === undefined
      ? current?.permissionState && (!update.harness || (update.harness.id === current.harness.id && update.harness.access === current.harness.access)) ? { permissionState: current.permissionState } : {}
      : update.permissionState ? { permissionState: update.permissionState } : {}),
    ...(update.model === undefined
      ? current.model ? { model: current.model } : {}
      : update.model ? { model: update.model } : {}),
    variant: update.variant === undefined ? current.variant ?? null : update.variant,
    agent: update.agent === undefined ? current.agent ?? null : update.agent,
    ...(update.instructions === undefined
      ? current.instructions ? { instructions: current.instructions } : {}
      : update.instructions ? { instructions: update.instructions } : {}),
    ...(update.group === undefined
      ? current.group ? { group: current.group } : {}
      : update.group ? { group: update.group } : {}),
    ...(update.handoff === undefined
      ? current.handoff !== undefined ? { handoff: current.handoff } : {}
      : { handoff: update.handoff }),
  }
}
