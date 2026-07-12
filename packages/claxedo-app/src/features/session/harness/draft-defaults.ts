import type { ModelKey } from "@/features/session/composer/model-strategy"
import type { PanePreferenceStorage } from "@/features/session/preferences/pane"
import { Persist } from "@/platform/persistence/persist"
import { isHarnessId, type HarnessId } from "@/platform/identity/session-ref"

const VERSION = 1
const KEY = "session.draft-default.v1"
const MAX_ID_LENGTH = 512
const MAX_LABEL_LENGTH = 120

export type DraftDefaultLabels = {
  provider?: string
  model?: string
}

export type DraftDefault = {
  version: typeof VERSION
  harness: HarnessId
  model?: ModelKey
  labels?: DraftDefaultLabels
}

export type DraftDefaultScope = {
  serverUrl: string
  workspaceKey: string
  fallbackWorkspaceKey?: string
}

type DraftDefaultStorage = PanePreferenceStorage & {
  removeItem?: (key: string) => void
}

export function draftDefaultStorageKey(input: Omit<DraftDefaultScope, "fallbackWorkspaceKey">) {
  const target = Persist.serverWorkspace(input.serverUrl, input.workspaceKey, KEY)
  return `${target.storage ?? "default"}:${target.key}`
}

export function decodeDraftDefault(input: string | null): DraftDefault | undefined {
  if (!input) return undefined
  try {
    return decodeRecord(JSON.parse(input))
  } catch {
    return undefined
  }
}

export function createDraftDefaultPreferences(storage: DraftDefaultStorage) {
  const key = (serverUrl: string, workspaceKey: string) => draftDefaultStorageKey({ serverUrl, workspaceKey })

  return {
    read(input: DraftDefaultScope) {
      const canonical = safeRead(storage, key(input.serverUrl, input.workspaceKey))
      if (canonical) return canonical

      const fallbackKey = input.fallbackWorkspaceKey
      if (!fallbackKey || fallbackKey === input.workspaceKey) return undefined
      const fallbackStorageKey = key(input.serverUrl, fallbackKey)
      const fallback = safeRead(storage, fallbackStorageKey)
      if (!fallback) return undefined

      const canonicalStorageKey = key(input.serverUrl, input.workspaceKey)
      if (!safeWrite(storage, canonicalStorageKey, fallback)) return fallback
      safeRemove(storage, fallbackStorageKey)
      return fallback
    },
    save(input: Omit<DraftDefaultScope, "fallbackWorkspaceKey">, value: Omit<DraftDefault, "version">) {
      const record = decodeRecord({ ...value, version: VERSION })
      if (!record) return false
      return safeWrite(storage, key(input.serverUrl, input.workspaceKey), record)
    },
  }
}

function decodeRecord(input: unknown): DraftDefault | undefined {
  const row = object(input)
  if (!row || row.version !== VERSION || !isHarnessId(row.harness)) return undefined

  const model = decodeModel(row.model, row.harness)
  if (row.model !== undefined && !model) return undefined

  const labels = decodeLabels(row.labels)
  if (row.labels !== undefined && !labels) return undefined

  return {
    version: VERSION,
    harness: row.harness,
    ...(model ? { model } : {}),
    ...(labels && (labels.provider || labels.model) ? { labels } : {}),
  }
}

function decodeModel(input: unknown, harness: HarnessId): ModelKey | undefined {
  if (input === undefined) return undefined
  const row = object(input)
  if (!row) return undefined
  const providerID = id(row.providerID)
  const modelID = id(row.modelID)
  if (!providerID || !modelID) return undefined
  if (harness !== "opencode" && harness !== "pi" && providerID !== harness) return undefined

  const variant = row.variant === undefined ? undefined : id(row.variant)
  if (row.variant !== undefined && !variant) return undefined
  return { providerID, modelID, ...(variant ? { variant } : {}) }
}

function decodeLabels(input: unknown): DraftDefaultLabels | undefined {
  if (input === undefined) return undefined
  const row = object(input)
  if (!row) return undefined
  const provider = label(row.provider)
  const model = label(row.model)
  if (row.provider !== undefined && !provider) return undefined
  if (row.model !== undefined && !model) return undefined
  return { ...(provider ? { provider } : {}), ...(model ? { model } : {}) }
}

function safeRead(storage: DraftDefaultStorage, key: string) {
  try {
    return decodeDraftDefault(storage.getItem(key))
  } catch {
    return undefined
  }
}

function safeWrite(storage: DraftDefaultStorage, key: string, record: DraftDefault) {
  try {
    storage.setItem(key, JSON.stringify(record))
    return true
  } catch {
    return false
  }
}

function safeRemove(storage: DraftDefaultStorage, key: string) {
  try {
    storage.removeItem?.(key)
  } catch {}
}

function object(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  return input as Record<string, unknown>
}

function id(input: unknown) {
  if (typeof input !== "string") return undefined
  const value = input.trim()
  if (!value || value !== input || value.length > MAX_ID_LENGTH) return undefined
  return value
}

function label(input: unknown) {
  if (typeof input !== "string") return undefined
  const value = input.trim()
  if (!value || value.length > MAX_LABEL_LENGTH) return undefined
  return value
}
