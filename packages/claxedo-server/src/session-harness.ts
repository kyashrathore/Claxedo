import fs from "fs"
import path from "path"
import {
  type SessionConfig as AgentSessionConfig,
  type SessionConfigUpdate as AgentSessionConfigUpdate,
  type SessionHarness as AgentSessionHarness,
  normalizeHarnessIdentity,
} from "@claxedo/agent-sdk-runtime"
import { dataDir } from "./lib/paths"
import { defaultHarness, type UserAgentConfig } from "./agent-config"

export type SessionHarness = NonNullable<UserAgentConfig["harness"]>
export type SessionConfig = AgentSessionConfig
export type SessionConfigUpdate = AgentSessionConfigUpdate

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

function legacyFilePath(root = rootDir()) {
  return path.join(root, "session-runners.json")
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
    const file = filePath(root)
    const legacyFile = legacyFilePath(root)
    const rows = JSON.parse(fs.readFileSync(fs.existsSync(file) ? file : legacyFile, "utf8")) as Array<Row | {
      workspaceId: string
      sessionId: string
      runner?: unknown
      harness?: AgentSessionHarness
      updatedAt?: number
    }>
    for (const row of rows) {
      if (!row?.workspaceId || !row?.sessionId) continue
      const config = "config" in row
        ? row.config?.harness
          ? row.config
          : legacyConfig((row.config as { runner?: unknown } | undefined)?.runner)
        : row.harness
        ? { harness: row.harness }
        : row.runner
        ? legacyConfig(row.runner)
        : undefined
      if (!config?.harness?.id) continue
      next.set(key(row.workspaceId, row.sessionId), {
        workspaceId: row.workspaceId,
        sessionId: row.sessionId,
        config: merge(config),
        updatedAt: row.updatedAt ?? Date.now(),
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
  return defaultHarness({
    mcp: {},
    auth: {},
    harness: input,
  })
}

function legacyConfig(input: unknown): SessionConfig | undefined {
  const identity = normalizeHarnessIdentity(input)
  if (!identity) return
  const row = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {}
  return {
    harness: {
      id: identity.id,
      access: identity.access,
      ...(typeof row.binary === "string" ? { connection: { kind: "process" as const, binary: row.binary } } : {}),
    },
    ...(typeof row.model === "string" ? { model: { providerID: identity.id, modelID: row.model } } : {}),
    variant: null,
    agent: null,
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
  if (!harness) return
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
