import fs from "fs"
import path from "path"
import {
  type SessionConfig as AgentSessionConfig,
  type SessionConfigUpdate as AgentSessionConfigUpdate,
  type SessionHarness as AgentSessionHarness,
  harnessKey,
  normalizeHarnessIdentity,
} from "@claxedo/agent-sdk-runtime"
import { AGENT_HARNESS_ACCESSES } from "@claxedo/agent-sdk-runtime"
import { isOneOf, jsonRecord, jsonString } from "@claxedo/server-core/platform/runtime/lib/json"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"

export type SessionHarness = AgentSessionHarness
export type SessionConfig = AgentSessionConfig
export type SessionConfigUpdate = AgentSessionConfigUpdate

export function meteringHarnessId(harness: SessionHarness) {
  const key = harnessKey(harness)
  if (!key) throw new Error(`Unsupported harness identity: ${harness.access}:${harness.id}`)
  return key
}

type Row = {
  workspaceId: string
  sessionId: string
  config: SessionConfig
  updatedAt: number
}

// Bounded TTL so the in-memory cache is periodically refetched from disk even
// when the data-dir root is unchanged (guards against another process writing
// the file). 60s keeps behavior identical within the window and cheap on the
// common single-box case, where all writes go through save() anyway.
const CACHE_TTL_MS = 60_000

let cache: Map<string, Row> | undefined
let cacheRoot: string | undefined
let cacheLoadedAt = 0

function rootDir() {
  return path.join(dataDir(), "agent-core")
}

function filePath(root = rootDir()) {
  return path.join(root, "session-harnesses.json")
}

function key(workspaceId: string, sessionId: string) {
  return `${workspaceId}:${sessionId}`
}

function merge(input: SessionConfig): SessionConfig {
  return {
    harness: normalize(input.harness),
    ...(input.model ? { model: input.model } : {}),
    variant: input.variant ?? null,
    agent: input.agent ?? null,
    ...(input.handoff !== undefined ? { handoff: input.handoff } : {}),
  }
}

/**
 * Read one persisted session config.
 *
 * This module's own `save()` is the only writer, so a well-formed file round
 * trips; anything else (a hand-edited file, a downgrade) reads as `undefined`
 * and the row is skipped, which is what `load()`'s guards already did for the
 * surrounding fields.
 */
function sessionConfig(value: unknown): SessionConfig | undefined {
  const row = jsonRecord(value)
  const harness = jsonRecord(row?.harness)
  const id = harness && jsonString(harness.id)
  if (!row || !id || !isOneOf(harness.access, AGENT_HARNESS_ACCESSES)) return undefined
  const model = jsonRecord(row.model)
  const providerID = model && jsonString(model.providerID)
  const modelID = model && jsonString(model.modelID)
  const handoff = jsonRecord(row.handoff)
  const from = jsonRecord(handoff?.from)
  const fromId = from && jsonString(from.id)
  return {
    harness: { id, access: harness.access },
    ...(providerID && modelID ? { model: { providerID, modelID } } : {}),
    ...(typeof row.variant === "string" || row.variant === null ? { variant: row.variant } : {}),
    ...(typeof row.agent === "string" || row.agent === null ? { agent: row.agent } : {}),
    ...(row.handoff === null
      ? { handoff: null }
      : fromId && isOneOf(from.access, AGENT_HARNESS_ACCESSES) && typeof handoff?.transcript === "string"
        ? {
            handoff: {
              from: { id: fromId, access: from.access },
              pending: true as const,
              transcript: handoff.transcript,
            },
          }
        : {}),
  }
}

function load() {
  const root = rootDir()
  const previous = cacheRoot === root ? cache : undefined
  cacheRoot = root
  const loadedAt = Date.now()
  if (previous && loadedAt - cacheLoadedAt < CACHE_TTL_MS) return previous
  try {
    const next = new Map<string, Row>()
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath(root), "utf8"))
    for (const item of Array.isArray(parsed) ? parsed : []) {
      const row = jsonRecord(item)
      const workspaceId = row && jsonString(row.workspaceId)
      const sessionId = row && jsonString(row.sessionId)
      const updatedAt = row?.updatedAt
      if (!workspaceId || !sessionId || typeof updatedAt !== "number") continue
      const config = sessionConfig(row.config)
      if (!config?.harness?.id) continue
      next.set(key(workspaceId, sessionId), {
        workspaceId,
        sessionId,
        config: merge(config),
        updatedAt,
      })
    }
    cache = next
  } catch {
    // A refresh can observe a transient read error or another process between
    // write and rename. Preserve the last-known-good snapshot for this root.
    cache = previous ?? new Map()
  }
  cacheLoadedAt = loadedAt
  return cache
}

function save() {
  const root = rootDir()
  fs.mkdirSync(root, { recursive: true, mode: 0o755 })
  const target = filePath(root)
  const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temp, JSON.stringify([...load().values()], null, 2) + "\n", { mode: 0o644 })
  fs.renameSync(temp, target)
}

export function normalize(input: SessionHarness): SessionHarness {
  const identity = normalizeHarnessIdentity(input)
  if (!identity) throw new Error("Unsupported harness identity")
  return {
    ...input,
    id: identity.id,
    access: identity.access,
  }
}

export function getSessionConfig(workspaceId: string, sessionId: string) {
  return load().get(key(workspaceId, sessionId))?.config
}

export function setSessionConfig(workspaceId: string, sessionId: string, config: SessionConfig) {
  load().set(key(workspaceId, sessionId), {
    workspaceId,
    sessionId,
    config: merge(config),
    updatedAt: Date.now(),
  })
  save()
}

export function updateSessionConfig(workspaceId: string, sessionId: string, update: SessionConfigUpdate) {
  const prev = getSessionConfig(workspaceId, sessionId)
  const harness = update.harness ?? prev?.harness
  if (!harness) return undefined
  const next = merge({
    harness,
    ...(update.model === undefined
      ? prev?.model
        ? { model: prev.model }
        : {}
      : update.model
      ? { model: update.model }
      : {}),
    variant: update.variant === undefined ? prev?.variant ?? null : update.variant,
    agent: update.agent === undefined ? prev?.agent ?? null : update.agent,
    ...(update.handoff === undefined
      ? prev?.handoff !== undefined ? { handoff: prev.handoff } : {}
      : { handoff: update.handoff }),
  })
  setSessionConfig(workspaceId, sessionId, next)
  return next
}

export function getSessionHarness(workspaceId: string, sessionId: string) {
  return getSessionConfig(workspaceId, sessionId)?.harness
}

export function setSessionHarness(workspaceId: string, sessionId: string, harness: SessionHarness) {
  updateSessionConfig(workspaceId, sessionId, { harness: normalize(harness) })
}

export function deleteSessionHarness(workspaceId: string, sessionId: string) {
  if (!load().delete(key(workspaceId, sessionId))) return
  save()
}

export function listSessionHarnesses(workspaceId: string) {
  return [...load().values()]
    .filter((row) => row.workspaceId === workspaceId)
    .map((row) => ({
      workspaceId: row.workspaceId,
      sessionId: row.sessionId,
      harness: row.config.harness,
      config: row.config,
      updatedAt: row.updatedAt,
    }))
}
