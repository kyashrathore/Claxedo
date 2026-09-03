import type { ModelKey } from "@/features/session/composer/model-strategy"
import type { PanePreferenceStorage } from "@/features/session/preferences/pane"
import { Persist } from "@/platform/persistence/persist"
import { isHarnessId, type HarnessId } from "@/platform/identity/session-ref"

const VERSION = 2
const KEY = "session.draft-default.v1"
const MAX_ID_LENGTH = 512
const MAX_LABEL_LENGTH = 120

export type DraftDefaultLabels = {
  provider?: string
  model?: string
}

/**
 * What ONE harness remembers in one workspace: the model last chosen for it.
 *
 * Per harness, because the harnesses do not share a model namespace — picking
 * Codex and then Claude used to overwrite the Codex model with a Claude one, so
 * switching back landed on "Choose a model" every time.
 */
export type DraftDefaultHarnessChoice = {
  model?: ModelKey
  labels?: DraftDefaultLabels
}

/** The (harness, model) a new draft in this workspace opens with. */
export type DraftDefault = DraftDefaultHarnessChoice & {
  harness: HarnessId
}

/**
 * The stored record for one (server, workspace): every harness's own slot plus
 * the harness the user last used here, which is the one a new draft opens with.
 */
type DraftDefaultRecord = {
  version: typeof VERSION
  byHarness: Partial<Record<HarnessId, DraftDefaultHarnessChoice>>
  lastHarness: HarnessId
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

/**
 * Decode a stored payload, upgrading the v1 single-slot record on the way.
 *
 * v1 was `{ version: 1, harness, model?, labels? }` — one pair for the whole
 * workspace. It becomes the `lastHarness` slot of the v2 record and nothing
 * else; `read` writes the upgraded record back on the spot, so no reader below
 * this function ever sees v1.
 */
export function decodeDraftDefaultRecord(input: string | null) {
  if (!input) return undefined
  try {
    const row = object(JSON.parse(input))
    if (!row) return undefined
    if (row.version === 1) {
      const upgraded = upgradeFromV1(row)
      return upgraded && { record: upgraded, migrated: true }
    }
    if (row.version !== VERSION) return undefined
    const record = decodeRecord(row)
    return record && { record, migrated: false }
  } catch {
    return undefined
  }
}

export function createDraftDefaultPreferences(storage: DraftDefaultStorage) {
  const key = (serverUrl: string, workspaceKey: string) => draftDefaultStorageKey({ serverUrl, workspaceKey })

  const load = (input: DraftDefaultScope) => {
    const canonicalKey = key(input.serverUrl, input.workspaceKey)
    const canonical = safeRead(storage, canonicalKey)
    if (canonical) {
      // The upgrade is a WRITE, not a read-time reinterpretation: persisting it
      // here is what makes v1 a one-time migration instead of a branch every
      // reader has to keep.
      if (canonical.migrated) safeWrite(storage, canonicalKey, canonical.record)
      return canonical.record
    }

    const fallbackKey = input.fallbackWorkspaceKey
    if (!fallbackKey || fallbackKey === input.workspaceKey) return undefined
    const fallbackStorageKey = key(input.serverUrl, fallbackKey)
    const fallback = safeRead(storage, fallbackStorageKey)
    if (!fallback) return undefined
    if (!safeWrite(storage, canonicalKey, fallback.record)) return fallback.record
    safeRemove(storage, fallbackStorageKey)
    return fallback.record
  }

  return {
    /** The harness this workspace was last used with, and its own model. */
    read(input: DraftDefaultScope): DraftDefault | undefined {
      const record = load(input)
      if (!record) return undefined
      return { harness: record.lastHarness, ...(record.byHarness[record.lastHarness] ?? {}) }
    },
    /** What ONE harness remembers here, whichever harness was last used. */
    readHarness(input: DraftDefaultScope, harness: HarnessId): DraftDefaultHarnessChoice | undefined {
      return load(input)?.byHarness[harness]
    },
    save(input: Omit<DraftDefaultScope, "fallbackWorkspaceKey">, value: DraftDefault) {
      const choice = decodeChoice(value)
      if (!choice || !isHarnessId(value.harness) || !modelBelongsToHarness(choice.model, value.harness)) return false
      const current = load(input)
      const record = decodeRecord({
        version: VERSION,
        byHarness: { ...(current?.byHarness ?? {}), [value.harness]: choice },
        lastHarness: value.harness,
      })
      if (!record) return false
      return safeWrite(storage, key(input.serverUrl, input.workspaceKey), record)
    },
  }
}

function upgradeFromV1(row: Record<string, unknown>): DraftDefaultRecord | undefined {
  if (!isHarnessId(row.harness)) return undefined
  const choice = decodeChoice({ model: row.model, labels: row.labels })
  if (!choice || !modelBelongsToHarness(choice.model, row.harness)) return undefined
  return {
    version: VERSION,
    byHarness: { [row.harness]: choice },
    lastHarness: row.harness,
  }
}

function decodeRecord(row: Record<string, unknown>): DraftDefaultRecord | undefined {
  if (!isHarnessId(row.lastHarness)) return undefined
  const stored = object(row.byHarness)
  if (!stored) return undefined
  const byHarness: Partial<Record<HarnessId, DraftDefaultHarnessChoice>> = {}
  for (const [harness, value] of Object.entries(stored)) {
    if (!isHarnessId(harness)) continue
    const choice = decodeChoice(value)
    if (!choice || !modelBelongsToHarness(choice.model, harness)) continue
    byHarness[harness] = choice
  }
  return { version: VERSION, byHarness, lastHarness: row.lastHarness }
}

function decodeChoice(input: unknown): DraftDefaultHarnessChoice | undefined {
  const row = object(input)
  if (!row) return undefined

  const model = decodeModel(row.model)
  if (row.model !== undefined && !model) return undefined

  const labels = decodeLabels(row.labels)
  if (row.labels !== undefined && !labels) return undefined

  return {
    ...(model ? { model } : {}),
    ...(labels && (labels.provider || labels.model) ? { labels } : {}),
  }
}

/**
 * OpenCode and Pi route to any provider; every other harness answers only for
 * itself, so a model filed under it whose provider is something else was
 * written by a different harness and is not a choice this one can restore.
 */
function modelBelongsToHarness(model: ModelKey | undefined, harness: HarnessId) {
  if (!model) return true
  if (harness === "opencode" || harness === "pi") return true
  return model.providerID === harness
}

function decodeModel(input: unknown): ModelKey | undefined {
  if (input === undefined) return undefined
  const row = object(input)
  if (!row) return undefined
  const providerID = id(row.providerID)
  const modelID = id(row.modelID)
  if (!providerID || !modelID) return undefined

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
    return decodeDraftDefaultRecord(storage.getItem(key))
  } catch {
    return undefined
  }
}

function safeWrite(storage: DraftDefaultStorage, key: string, record: DraftDefaultRecord) {
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
