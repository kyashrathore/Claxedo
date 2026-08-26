import { shellDataKeys } from "@/platform/sync/keys"
import type { LocalSelectionState } from "./local-selection-handoff"

const sessionConfigSelectionPart = "config-selection"
const sessionConfigRawPart = "config-raw"
const sessionConfigSelectionSyncPart = "config-selection-sync"

export function sessionConfigSelectionQueryKey(sessionID: string) {
  return shellDataKeys.sessionId(sessionID, sessionConfigSelectionPart)
}

export function sessionConfigRawQueryKey(sessionID: string) {
  return shellDataKeys.sessionId(sessionID, sessionConfigRawPart)
}

export function sessionConfigSelectionSyncQueryKey(sessionID: string) {
  return shellDataKeys.sessionId(sessionID, sessionConfigSelectionSyncPart)
}

export function localSelectionStateFromSessionConfig(input: unknown): LocalSelectionState | undefined {
  const row = object(input)
  if (!row) return

  const model = modelKey(row.model)
  const agent = typeof row.agent === "string" && row.agent ? row.agent : undefined
  const variant =
    typeof row.variant === "string" || row.variant === null
      ? row.variant
      : typeof model?.variant === "string"
        ? model.variant
        : undefined

  if (!agent && !model && variant === undefined) return
  return {
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(variant !== undefined ? { variant } : {}),
  }
}

export function sessionConfigPatchFromLocalSelection(input: LocalSelectionState) {
  return {
    harness: { id: "opencode", access: "native" },
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

function object(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  return input as Record<string, unknown>
}

function modelKey(input: unknown) {
  const row = object(input)
  if (!row) return
  if (typeof row.providerID !== "string" || typeof row.modelID !== "string") return
  return {
    providerID: row.providerID,
    modelID: row.modelID,
    ...(typeof row.variant === "string" ? { variant: row.variant } : {}),
  }
}
