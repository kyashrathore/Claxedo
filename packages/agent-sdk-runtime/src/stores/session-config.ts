import type { SessionConfig, SessionConfigUpdate } from "@claxedo/agent-runtime-contract"

/**
 * A config field the harness itself accepted. A harness change invalidates it,
 * so the previous value only survives while the harness is unchanged.
 */
export function keepsSessionHarness(previous: SessionConfig["harness"] | undefined, next: SessionConfigUpdate["harness"]) {
  return !next || (next.id === previous?.id && next.access === previous?.access)
}

export function nextSessionConfig(prev: SessionConfig | undefined, update: SessionConfigUpdate, sameHarness: boolean): SessionConfig {
  const permissionCeiling = update.permissionCeiling ?? prev?.permissionCeiling
  const permissionState = harnessScopedField(update.permissionState, prev?.permissionState, sameHarness)
  const model = update.model === undefined ? prev?.model : update.model ?? undefined
  const instructions = update.instructions === undefined ? prev?.instructions : update.instructions
  const group = update.group === undefined ? prev?.group : update.group
  return {
    harness: update.harness ?? prev!.harness,
    ...(permissionCeiling ? { permissionCeiling } : {}),
    ...storedPermissionMode(update, prev, sameHarness),
    ...(permissionState ? { permissionState } : {}),
    ...(model ? { model } : {}),
    variant: update.variant === undefined ? prev?.variant ?? null : update.variant,
    agent: update.agent === undefined ? prev?.agent ?? null : update.agent,
    ...(instructions ? { instructions } : {}),
    ...(group ? { group } : {}),
    ...(update.handoff === undefined
      ? prev?.handoff !== undefined ? { handoff: prev.handoff } : {}
      : { handoff: update.handoff }),
  }
}

function storedPermissionMode(update: SessionConfigUpdate, prev: SessionConfig | undefined, sameHarness: boolean): Pick<SessionConfig, "permissionMode" | "permissionModeLabel"> {
  const permissionMode = harnessScopedField(update.permissionMode, prev?.permissionMode, sameHarness)
  const permissionModeLabel = update.permissionMode === undefined
    ? harnessScopedField(update.permissionModeLabel, prev?.permissionModeLabel, sameHarness)
    : update.permissionModeLabel ?? undefined
  return { ...(permissionMode ? { permissionMode } : {}), ...(permissionMode && permissionModeLabel ? { permissionModeLabel } : {}) }
}

function harnessScopedField<T>(update: T | null | undefined, prev: T | undefined, sameHarness: boolean) {
  if (update !== undefined) return update ?? undefined
  return sameHarness ? prev : undefined
}
