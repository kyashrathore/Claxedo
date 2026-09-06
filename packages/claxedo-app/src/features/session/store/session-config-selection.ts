import { shellDataKeys } from "@/platform/sync/keys"
import type { LocalSelectionState } from "./local-selection-handoff"
import {
  sessionResourceAuthorityKey,
  type SessionResourceAuthorityScope,
} from "./session-resource-authority"
import { asRecord } from "@/lib/record"

const sessionConfigSelectionPart = "config-selection"
const sessionConfigRawPart = "config-raw"
const sessionConfigSelectionSyncPart = "config-selection-sync"

export type SessionConfigQueryScope = SessionResourceAuthorityScope

function sessionConfigQueryKey(scope: SessionConfigQueryScope, part: string) {
  return shellDataKeys.sessionId(scope.sessionID, part, sessionResourceAuthorityKey(scope))
}

export function sessionConfigSelectionQueryKey(scope: SessionConfigQueryScope) {
  return sessionConfigQueryKey(scope, sessionConfigSelectionPart)
}

export function sessionConfigRawQueryKey(scope: SessionConfigQueryScope) {
  return sessionConfigQueryKey(scope, sessionConfigRawPart)
}

export function sessionConfigSelectionSyncQueryKey(sessionID: string) {
  return shellDataKeys.sessionId(sessionID, sessionConfigSelectionSyncPart)
}

export function localSelectionStateFromSessionConfig(input: unknown): LocalSelectionState | undefined {
  const row = asRecord(input)
  if (!row) return undefined

  const model = modelKey(row.model)
  const agent = typeof row.agent === "string" && row.agent ? row.agent : undefined
  const variant = typeof row.variant === "string" || row.variant === null
    ? row.variant
    : typeof model?.variant === "string"
    ? model.variant
    : undefined

  if (!agent && !model && variant === undefined) return undefined
  return {
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(variant !== undefined ? { variant } : {}),
  }
}

export function sessionConfigPatchFromLocalSelection(input: LocalSelectionState) {
  return {
    ...(input.agent ? { agent: input.agent } : {}),
    model: input.model ?? null,
    variant: input.variant ?? null,
  }
}

export function shouldExposeDefaultLocalModelFallback(input: {
  existingSession: boolean
  hasSelection: boolean
  hasValidSelection?: boolean
  restoreLoading?: boolean
}) {
  const validSelection = input.hasValidSelection ?? input.hasSelection
  if (validSelection) return false
  if (input.restoreLoading) return false
  if (input.hasSelection) return true
  return !input.existingSession
}

function modelKey(input: unknown) {
  const row = asRecord(input)
  if (!row) return undefined
  if (typeof row.providerID !== "string" || typeof row.modelID !== "string") return undefined
  return {
    providerID: row.providerID,
    modelID: row.modelID,
    ...(typeof row.variant === "string" ? { variant: row.variant } : {}),
  }
}
