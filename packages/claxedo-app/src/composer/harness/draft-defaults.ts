import type { ModelChoice, PlacementId } from "@/server"
import { preferenceKey } from "@/lib/persisted"
import { harnessSelectionKey, isHarnessSelection, type HarnessSelection } from "@/lib/harness-selection"
import { isCatalogHarnessId } from "@/lib/harness-selection"
import { asRecord } from "@claxedo/helpers/guards"

const VERSION = 3
const MAX_ID_LENGTH = 512
const MAX_LABEL_LENGTH = 120

export type DraftDefaultLabels = {
  provider?: string
  model?: string
}

export type DraftDefaultHarnessChoice = {
  model?: ModelChoice
  labels?: DraftDefaultLabels
}

export type DraftDefault = DraftDefaultHarnessChoice & {
  harness: HarnessSelection
}

type DraftDefaultRecord = {
  version: typeof VERSION
  byHarness: Record<string, DraftDefaultHarnessChoice>
  lastHarness: HarnessSelection
}

export type DraftDefaultScope = {
  serverUrl: string
  placementId: PlacementId
}

export type DraftDefaultStorage = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export function draftDefaultStorageKey(input: DraftDefaultScope) {
  return preferenceKey("draft-default", scopeUrl(input.serverUrl), input.placementId)
}

function scopeUrl(url: string) {
  try {
    const next = new URL(url)
    if (next.hostname === "127.0.0.1") next.hostname = "localhost"
    return next.toString().replace(/\/+$/, "")
  } catch {
    return url
      .trim()
      .replace(/^http:\/\/127\.0\.0\.1\b/i, "http://localhost")
      .replace(/^https:\/\/127\.0\.0\.1\b/i, "https://localhost")
      .replace(/\/+$/, "")
  }
}

export function decodeDraftDefaultRecord(input: string | null) {
  if (!input) return undefined
  try {
    const row = asRecord(JSON.parse(input))
    if (!row) return undefined
    if (row.version !== VERSION) return undefined
    return decodeRecord(row)
  } catch (error) {
    console.warn("A saved draft default is not JSON and is ignored", error)
    return undefined
  }
}

export function createDraftDefaultPreferences(storage: DraftDefaultStorage) {
  const load = (input: DraftDefaultScope) => safeRead(storage, draftDefaultStorageKey(input))

  return {
    read(input: DraftDefaultScope): DraftDefault | undefined {
      const record = load(input)
      if (!record) return undefined
      return { harness: record.lastHarness, ...record.byHarness[harnessSelectionKey(record.lastHarness)] }
    },
    readHarness(input: DraftDefaultScope, harness: HarnessSelection): DraftDefaultHarnessChoice | undefined {
      return load(input)?.byHarness[harnessSelectionKey(harness)]
    },
    save(input: DraftDefaultScope, value: DraftDefault) {
      if (!isHarnessSelection(value.harness)) return false
      const slot = harnessSelectionKey(value.harness)
      const choice: DraftDefaultHarnessChoice = { ...(value.model ? { model: value.model } : {}), ...(value.labels ? { labels: value.labels } : {}) }
      const record = decodeRecord(storedRecord({ version: VERSION, byHarness: { ...load(input)?.byHarness, [slot]: choice }, lastHarness: value.harness }))
      if (!record?.byHarness[slot]) return false
      return safeWrite(storage, draftDefaultStorageKey(input), record)
    },
  }
}

function storedRecord(record: DraftDefaultRecord): Record<string, unknown> {
  const byHarness = Object.fromEntries(Object.entries(record.byHarness).map(([slot, choice]) => [slot, {
    ...choice,
    ...(choice.model ? { model: { providerID: choice.model.providerId, modelID: choice.model.modelId, ...(choice.model.variant ? { variant: choice.model.variant } : {}) } } : {}),
  }]))
  return { ...record, byHarness }
}

function decodeRecord(row: Record<string, unknown>): DraftDefaultRecord | undefined {
  if (!isHarnessSelection(row.lastHarness)) return undefined
  const stored = asRecord(row.byHarness)
  if (!stored) return undefined
  const byHarness: Record<string, DraftDefaultHarnessChoice> = {}
  for (const [key, value] of Object.entries(stored)) {
    let harness: unknown
    try { harness = JSON.parse(key) } catch { continue }
    if (!isHarnessSelection(harness)) continue
    const choice = decodeChoice(value)
    if (!choice || !modelBelongsToHarness(choice.model, harness)) continue
    byHarness[harnessSelectionKey(harness)] = choice
  }
  return { version: VERSION, byHarness, lastHarness: row.lastHarness }
}

function decodeChoice(input: unknown): DraftDefaultHarnessChoice | undefined {
  const row = asRecord(input)
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

function modelBelongsToHarness(model: ModelChoice | undefined, harness: HarnessSelection) {
  if (!model) return true
  if (harness.kind === "connection" || isCatalogHarnessId(harness.harnessId)) return true
  return model.providerId === harness.harnessId
}

function decodeModel(input: unknown): ModelChoice | undefined {
  if (input === undefined) return undefined
  const row = asRecord(input)
  if (!row) return undefined
  const providerId = id(row.providerID)
  const modelId = id(row.modelID)
  if (!providerId || !modelId) return undefined

  const variant = row.variant === undefined ? undefined : id(row.variant)
  if (row.variant !== undefined && !variant) return undefined
  return { providerId, modelId, ...(variant ? { variant } : {}) }
}

function decodeLabels(input: unknown): DraftDefaultLabels | undefined {
  if (input === undefined) return undefined
  const row = asRecord(input)
  if (!row) return undefined
  const provider = storedLabel(row.provider)
  const model = storedLabel(row.model)
  if (row.provider !== undefined && !provider) return undefined
  if (row.model !== undefined && !model) return undefined
  return { ...(provider ? { provider } : {}), ...(model ? { model } : {}) }
}

function safeRead(storage: DraftDefaultStorage, key: string) {
  try {
    return decodeDraftDefaultRecord(storage.getItem(key))
  } catch (error) {
    console.warn(`The draft default ${key} could not be read`, error)
    return undefined
  }
}

function safeWrite(storage: DraftDefaultStorage, key: string, record: DraftDefaultRecord) {
  try {
    storage.setItem(key, JSON.stringify(storedRecord(record)))
    return true
  } catch (error) {
    console.warn(`The draft default ${key} could not be saved`, error)
    return false
  }
}

function id(input: unknown) {
  if (typeof input !== "string") return undefined
  const value = input.trim()
  if (!value || value !== input || value.length > MAX_ID_LENGTH) return undefined
  return value
}

function storedLabel(input: unknown) {
  if (typeof input !== "string") return undefined
  const value = input.trim()
  if (!value || value.length > MAX_LABEL_LENGTH) return undefined
  return value
}
