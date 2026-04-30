import fs from "fs"
import path from "path"
import type { SessionConfig as AgentSessionConfig, SessionConfigPatch as AgentSessionConfigPatch } from "../../workspace-runtime/src/adapters"
import { dataDir } from "./paths"
import { defaultRunner, type UserAgentConfig } from "./agent-config"

export type SessionRunner = NonNullable<UserAgentConfig["runner"]>
export type SessionConfig = AgentSessionConfig
export type SessionConfigPatch = AgentSessionConfigPatch

type Row = {
  workspaceId: string
  sessionId: string
  config: SessionConfig
  updatedAt: number
}

const root = path.join(dataDir(), "agent-core")
const file = path.join(root, "session-runners.json")

let cache: Map<string, Row> | undefined

function key(workspaceId: string, sessionId: string) {
  return `${workspaceId}:${sessionId}`
}

function merge(input: SessionConfig): SessionConfig {
  return {
    runner: normalize(input.runner),
    ...(input.model ? { model: input.model } : {}),
    variant: input.variant ?? null,
    agent: input.agent ?? null,
  }
}

function load() {
  if (cache) return cache
  cache = new Map()
  try {
    const rows = JSON.parse(fs.readFileSync(file, "utf8")) as Array<Row | {
      workspaceId: string
      sessionId: string
      runner: SessionRunner
      updatedAt?: number
    }>
    for (const row of rows) {
      if (!row?.workspaceId || !row?.sessionId) continue
      const config = "config" in row
        ? row.config
        : row.runner
        ? { runner: row.runner }
        : undefined
      if (!config?.runner?.type) continue
      cache.set(key(row.workspaceId, row.sessionId), {
        workspaceId: row.workspaceId,
        sessionId: row.sessionId,
        config: merge(config),
        updatedAt: row.updatedAt ?? Date.now(),
      })
    }
  } catch {
    // best effort
  }
  return cache
}

function save() {
  fs.mkdirSync(root, { recursive: true, mode: 0o755 })
  fs.writeFileSync(file, JSON.stringify([...load().values()], null, 2) + "\n", { mode: 0o644 })
}

export function normalize(input: SessionRunner): SessionRunner {
  return defaultRunner({
    mcp: {},
    auth: {},
    runner: input,
  })
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

export function updateSessionConfig(workspaceId: string, sessionId: string, patch: SessionConfigPatch) {
  const prev = getSessionConfig(workspaceId, sessionId)
  const runner = patch.runner ?? prev?.runner
  if (!runner) return
  const next = merge({
    runner,
    ...(patch.model === undefined
      ? prev?.model
        ? { model: prev.model }
        : {}
      : patch.model
      ? { model: patch.model }
      : {}),
    variant: patch.variant === undefined ? prev?.variant ?? null : patch.variant,
    agent: patch.agent === undefined ? prev?.agent ?? null : patch.agent,
  })
  setSessionConfig(workspaceId, sessionId, next)
  return next
}

export function getSessionRunner(workspaceId: string, sessionId: string) {
  return getSessionConfig(workspaceId, sessionId)?.runner
}

export function setSessionRunner(workspaceId: string, sessionId: string, runner: SessionRunner) {
  updateSessionConfig(workspaceId, sessionId, { runner: normalize(runner) })
}

export function deleteSessionRunner(workspaceId: string, sessionId: string) {
  if (!load().delete(key(workspaceId, sessionId))) return
  save()
}

export function listSessionRunners(workspaceId: string) {
  return [...load().values()]
    .filter((row) => row.workspaceId === workspaceId)
    .map((row) => ({
      workspaceId: row.workspaceId,
      sessionId: row.sessionId,
      runner: row.config.runner,
      config: row.config,
      updatedAt: row.updatedAt,
    }))
}
