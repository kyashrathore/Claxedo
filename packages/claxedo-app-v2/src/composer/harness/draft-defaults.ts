import { checksum } from "@opencode-ai/ui/utils/encode"
import type { ModelKey } from "./model-key"
import { harnessSelectionKey, isHarnessSelection, type HarnessSelection } from "@/lib/harness-selection"
import { isCatalogHarnessId } from "@/lib/harness-selection"
import { asRecord } from "@/lib/record"

const VERSION = 3
const KEY = "session.draft-default.v1"
const MAX_ID_LENGTH = 512
const MAX_LABEL_LENGTH = 120

export type DraftDefaultLabels = {
  provider?: string
  model?: string
}

/**
 * What one harness remembers in one workspace: the model last chosen for it.
 *
 * Per harness, because the harnesses do not share a model namespace — sharing
 * one slot would let picking Claude after Codex overwrite the Codex model
 * with a Claude one, landing back on "Choose a model" every time you switch
 * back.
 */
export type DraftDefaultHarnessChoice = {
  model?: ModelKey
  labels?: DraftDefaultLabels
}

/** The (harness, model) a new draft in this workspace opens with. */
export type DraftDefault = DraftDefaultHarnessChoice & {
  harness: HarnessSelection
}

/**
 * The stored record for one (server, workspace): every harness's own slot plus
 * the harness the user last used here, which is the one a new draft opens with.
 */
type DraftDefaultRecord = {
  version: typeof VERSION
  byHarness: Record<string, DraftDefaultHarnessChoice>
  lastHarness: HarnessSelection
}

export type DraftDefaultScope = {
  serverUrl: string
  workspaceKey: string
  fallbackWorkspaceKey?: string
}

export type DraftDefaultStorage = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem?: (key: string) => void
}

/** Today's app files the record under this key, so a draft default carries over between the two. */
export function draftDefaultStorageKey(input: Omit<DraftDefaultScope, "fallbackWorkspaceKey">) {
  return `${serverWorkspaceStorage(input.serverUrl, input.workspaceKey)}:workspace:${KEY}`
}

function serverWorkspaceStorage(serverUrl: string, dir: string) {
  const scoped = scopeUrl(serverUrl)
  const serverHead =
    scoped
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "")
      .replace(/[^a-z0-9.-]/gi, "-")
      .slice(0, 24) || "server"
  const serverSum = checksum(scoped) ?? "0"
  const dirHead = (dir.slice(0, 12) || "workspace").replace(/[^a-zA-Z0-9._-]/g, "-")
  const dirSum = checksum(dir) ?? "0"
  return `claxedo.server.${serverHead}.${serverSum}.workspace.${dirHead}.${dirSum}.dat`
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
    const record = decodeRecord(row)
    return record
  } catch {
    return undefined
  }
}

export function createDraftDefaultPreferences(storage: DraftDefaultStorage) {
  const key = (serverUrl: string, workspaceKey: string) => draftDefaultStorageKey({ serverUrl, workspaceKey })

  const load = (input: DraftDefaultScope) => {
    const canonicalKey = key(input.serverUrl, input.workspaceKey)
    const canonical = safeRead(storage, canonicalKey)
    if (canonical) return canonical

    const fallbackKey = input.fallbackWorkspaceKey
    if (!fallbackKey || fallbackKey === input.workspaceKey) return undefined
    const fallbackStorageKey = key(input.serverUrl, fallbackKey)
    const fallback = safeRead(storage, fallbackStorageKey)
    if (!fallback) return undefined
    if (!safeWrite(storage, canonicalKey, fallback)) return fallback
    safeRemove(storage, fallbackStorageKey)
    return fallback
  }

  return {
    /** The harness this workspace was last used with, and its own model. */
    read(input: DraftDefaultScope): DraftDefault | undefined {
      const record = load(input)
      if (!record) return undefined
      return { harness: record.lastHarness, ...record.byHarness[harnessSelectionKey(record.lastHarness)] }
    },
    /** What one harness remembers here, whichever harness was last used. */
    readHarness(input: DraftDefaultScope, harness: HarnessSelection): DraftDefaultHarnessChoice | undefined {
      return load(input)?.byHarness[harnessSelectionKey(harness)]
    },
    save(input: Omit<DraftDefaultScope, "fallbackWorkspaceKey">, value: DraftDefault) {
      const choice = decodeChoice(value)
      if (!choice || !isHarnessSelection(value.harness) || !modelBelongsToHarness(choice.model, value.harness)) return false
      const current = load(input)
      const record = decodeRecord({
        version: VERSION,
        byHarness: { ...current?.byHarness, [harnessSelectionKey(value.harness)]: choice },
        lastHarness: value.harness,
      })
      if (!record) return false
      return safeWrite(storage, key(input.serverUrl, input.workspaceKey), record)
    },
  }
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

function modelBelongsToHarness(model: ModelKey | undefined, harness: HarnessSelection) {
  if (!model) return true
  if (harness.kind === "connection" || isCatalogHarnessId(harness.harnessId)) return true
  return model.providerID === harness.harnessId
}

function decodeModel(input: unknown): ModelKey | undefined {
  if (input === undefined) return undefined
  const row = asRecord(input)
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
  const row = asRecord(input)
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
