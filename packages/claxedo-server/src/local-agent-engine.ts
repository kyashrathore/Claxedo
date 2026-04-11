import fs from "fs"
import path from "path"
import { ACPAdapter, OpenCodeAdapter, type AgentAdapter } from "../../workspace-runtime/src"
import { dataDir } from "./paths"
import { defaultRunner, getRuntimeConfigSnapshot, loadUserConfig, type RuntimeConfigSnapshot } from "./agent-config"
import {
  deleteSessionRunner,
  getSessionConfig,
  getSessionRunner,
  listSessionRunners,
  normalize,
  setSessionConfig,
  setSessionRunner,
  updateSessionConfig,
  type SessionConfig,
  type SessionConfigPatch,
  type SessionRunner,
} from "./session-runner"
import type { Workspace } from "./workspace-store"
import { opencodeHeaders } from "./opencode-auth"

type State = {
  ws: Workspace
  key: string
  snapshot: RuntimeConfigSnapshot
  applied?: string
  adapter: AgentAdapter
  error?: string
}

let upstream = process.env.OPENCODE_URL ?? "http://127.0.0.1:4096"

const states = new Map<string, State>()
const optionsFile = path.join(dataDir(), "agent-core", "runner-options.json")
let options: Map<string, { key: string; options: unknown[]; updatedAt: number }> | undefined

function storeRoot(workspaceId: string) {
  return path.join(dataDir(), "agent-core", workspaceId)
}

function snapshotKey(snapshot: RuntimeConfigSnapshot) {
  return JSON.stringify({
    type: snapshot.runner.type,
    binary: snapshot.runner.binary ?? "",
  })
}

function optionsKey(runner: SessionRunner) {
  const item = normalize(runner)
  return JSON.stringify({
    type: item.type,
    binary: item.binary ?? "",
  })
}

function loadOptions() {
  if (options) return options
  options = new Map()
  try {
    const rows = JSON.parse(fs.readFileSync(optionsFile, "utf8")) as Array<{
      key: string
      options: unknown[]
      updatedAt: number
    }>
    for (const row of rows) {
      if (!row?.key || !Array.isArray(row.options)) continue
      options.set(row.key, {
        key: row.key,
        options: row.options,
        updatedAt: row.updatedAt ?? Date.now(),
      })
    }
  } catch {
    // best effort
  }
  return options
}

function saveOptions() {
  fs.mkdirSync(path.dirname(optionsFile), { recursive: true, mode: 0o755 })
  fs.writeFileSync(optionsFile, JSON.stringify([...loadOptions().values()], null, 2) + "\n", { mode: 0o644 })
}

export function getLocalRunnerOptions(runner: SessionRunner) {
  return loadOptions().get(optionsKey(runner))?.options
}

export function setLocalRunnerOptions(runner: SessionRunner, input: unknown[]) {
  loadOptions().set(optionsKey(runner), {
    key: optionsKey(runner),
    options: input,
    updatedAt: Date.now(),
  })
  saveOptions()
}

function adapterRunner(runner?: SessionRunner) {
  if (!runner) return
  if (runner.type === "opencode") return { type: "opencode" } as const
  return normalize({
    type: runner.type,
    ...(runner.binary ? { binary: runner.binary } : {}),
  })
}

async function currentConfig() {
  const config = await loadUserConfig()
  return config
}

async function currentSnapshot(runner?: SessionRunner) {
  const config = await currentConfig()
  const next = normalize(adapterRunner(runner) ?? adapterRunner(defaultRunner(config))!)
  const base = await getRuntimeConfigSnapshot(next)
  return {
    ...base,
    runner: next,
  }
}

function createAdapter(ws: Workspace, snapshot: RuntimeConfigSnapshot): AgentAdapter {
  if (snapshot.runner.type === "pi") {
    throw new Error("pi runner is central-backed and cannot be created via local-agent-engine")
  }
  if (snapshot.runner.type === "opencode") {
    return new OpenCodeAdapter(upstream, { headers: opencodeHeaders() })
  }
  return new ACPAdapter({
    binary: snapshot.runner.binary!,
    type: snapshot.runner.type,
    storeRoot: path.join(storeRoot(ws.id), snapshotKey(snapshot).replaceAll(/[^a-zA-Z0-9_-]/g, "_")),
  })
}

async function sync(state: State, snapshot: RuntimeConfigSnapshot) {
  const stamp = JSON.stringify(snapshot)
  if (state.applied === stamp) return
  try {
    await state.adapter.applyConfig(snapshot as unknown as Record<string, unknown>)
    state.snapshot = snapshot
    state.applied = stamp
    state.error = undefined
  } catch (err) {
    state.snapshot = snapshot
    state.error = err instanceof Error ? err.message : String(err)
    throw err
  }
}

export function configureLocalAgentEngine(opencodeUrl: string) {
  upstream = opencodeUrl
}

export async function getLocalAgentAdapter(ws: Workspace, runner?: SessionRunner) {
  const snapshot = await currentSnapshot(runner)
  const key = snapshotKey(snapshot)
  const id = `${ws.id}:${key}`
  const hit = states.get(id)
  if (!hit || hit.key !== key) {
    hit?.adapter.dispose()
    const state: State = {
      ws,
      key,
      snapshot,
      adapter: createAdapter(ws, snapshot),
    }
    states.set(id, state)
    await sync(state, snapshot)
    return state.adapter
  }
  await sync(hit, snapshot)
  return hit.adapter
}

export async function getLocalSessionRunner(ws: Workspace, sessionId?: string, runner?: SessionRunner) {
  if (runner) return normalize(runner)
  if (sessionId) {
    const hit = getSessionRunner(ws.id, sessionId)
    if (hit) return hit
  }
  return (await currentSnapshot()).runner
}

export async function getLocalSessionAdapter(ws: Workspace, sessionId?: string, runner?: SessionRunner) {
  return getLocalAgentAdapter(ws, await getLocalSessionRunner(ws, sessionId, runner))
}

export async function createLocalSession(ws: Workspace, runner: SessionRunner, title?: string) {
  const live = normalize(runner)
  const adapter = await getLocalAgentAdapter(ws, live)
  const session = await adapter.createSession(ws.directory, title)
  setSessionConfig(ws.id, session.id, {
    runner: live,
    ...(live.type !== "opencode" && live.type !== "pi" && live.model
      ? { model: { providerID: live.type, modelID: live.model } }
      : {}),
    variant: null,
    agent: null,
  })
  return session
}

export async function setLocalSessionModel(ws: Workspace, sessionId: string, model: string) {
  const hit = await getLocalSessionRunner(ws, sessionId)
  await updateLocalSessionConfig(ws, sessionId, {
    ...(hit.type === "opencode" || hit.type === "pi" ? {} : { model: { providerID: hit.type, modelID: model } }),
    ...(hit.type === "opencode" || hit.type === "pi"
      ? {}
      : {
          runner: {
            ...hit,
            model,
          },
        }),
  })
}

export async function deleteLocalSessionBinding(ws: Workspace, sessionId: string) {
  deleteSessionRunner(ws.id, sessionId)
}

export async function getLocalSessionConfig(ws: Workspace, sessionId: string): Promise<SessionConfig> {
  const saved = getSessionConfig(ws.id, sessionId)
  if (saved) return saved
  const runner = await getLocalSessionRunner(ws, sessionId)
  return {
    runner,
    ...(runner.type !== "opencode" && runner.type !== "pi" && runner.model
      ? { model: { providerID: runner.type, modelID: runner.model } }
      : {}),
    variant: null,
    agent: null,
  }
}

export async function updateLocalSessionConfig(ws: Workspace, sessionId: string, patch: SessionConfigPatch) {
  const prev = await getLocalSessionConfig(ws, sessionId)
  const next = {
    runner: patch.runner ?? prev.runner,
    ...(patch.model === undefined
      ? prev.model
        ? { model: prev.model }
        : {}
      : patch.model
      ? { model: patch.model }
      : {}),
    variant: patch.variant === undefined ? prev.variant ?? null : patch.variant,
    agent: patch.agent === undefined ? prev.agent ?? null : patch.agent,
  } satisfies SessionConfig

  if (patch.runner) {
    const changed = prev.runner.type !== patch.runner.type
      || (prev.runner.binary ?? "") !== (patch.runner.binary ?? "")
    if (changed) {
      const adapter = await getLocalSessionAdapter(ws, sessionId, prev.runner)
      const rows = await adapter.getMessages(sessionId, ws.directory).catch(() => [])
      if (Array.isArray(rows) && rows.length > 0) {
        throw new Error("Runner changes are only supported before a session is created")
      }
    }
  }

  updateSessionConfig(ws.id, sessionId, next)

  if (next.runner.type === "opencode") return next
  if (next.runner.type === "pi") return next
  const adapter = await getLocalSessionAdapter(ws, sessionId, next.runner)
  await adapter.updateSessionConfig(sessionId, next, ws.directory)
  return next
}

export async function listLocalSessions(ws: Workspace) {
  const merged = new Map<string, unknown>()
  const bound = new Map<string, SessionRunner>()
  const all = [normalize((await currentSnapshot()).runner), ...listSessionRunners(ws.id).map((row) => row.runner)]
  const uniq = new Map(all.map((runner) => [JSON.stringify({
    type: runner.type,
    binary: runner.binary ?? "",
  }), runner]))
  const stamp = (row: Record<string, unknown>) => {
    const time = row.time
    if (time && typeof time === "object") {
      const updated = (time as { updated?: unknown }).updated
      if (typeof updated === "number") return updated
      const created = (time as { created?: unknown }).created
      if (typeof created === "number") return created
    }
    const updated = row.updated_at
    if (typeof updated === "number") return updated
    const created = row.created_at
    if (typeof created === "number") return created
    return 0
  }
  await Promise.allSettled(
    [...uniq.values()].map(async (runner) => {
      const adapter = await getLocalAgentAdapter(ws, runner)
      const rows = await adapter.listSessions(ws.directory).catch(() => [])
      if (!Array.isArray(rows)) return
      for (const row of rows) {
        if (!row || typeof row !== "object") continue
        const id = (row as { id?: unknown }).id
        if (typeof id !== "string") continue
        const prev = merged.get(id)
        if (prev && stamp(prev as Record<string, unknown>) > stamp(row as Record<string, unknown>)) continue
        merged.set(id, row)
        bound.set(id, runner)
      }
    }),
  )
  for (const [id, runner] of bound) setSessionRunner(ws.id, id, runner)
  return [...merged.values()]
}

export async function listLocalPermissions(ws: Workspace) {
  const merged = new Map<string, unknown>()
  const all = [normalize((await currentSnapshot()).runner), ...listSessionRunners(ws.id).map((row) => row.runner)]
  const uniq = new Map(all.map((runner) => [JSON.stringify({
    type: runner.type,
    binary: runner.binary ?? "",
  }), runner]))
  await Promise.allSettled(
    [...uniq.values()].map(async (runner) => {
      const adapter = await getLocalAgentAdapter(ws, runner)
      const rows = await adapter.listPermissions(ws.directory).catch(() => [])
      if (!Array.isArray(rows)) return
      for (const row of rows) {
        if (!row || typeof row !== "object") continue
        const id = (row as { id?: unknown }).id
        if (typeof id !== "string" || merged.has(id)) continue
        merged.set(id, row)
      }
    }),
  )
  return [...merged.values()]
}

export async function localAgentStatus(ws: Workspace, sessionId?: string) {
  const runner = await getLocalSessionRunner(ws, sessionId)
  const snapshot = await currentSnapshot(runner)
  const id = `${ws.id}:${snapshotKey(snapshot)}`
  await getLocalAgentAdapter(ws, runner).catch((err) => err)
  const hit = states.get(id)
  const live = hit?.snapshot.runner ?? snapshot.runner

  // For ACP runners, verify the binary exists — spawn failures are async
  // so state.error may not be set yet.
  let error = hit?.error
  if (!error && live.type !== "opencode" && live.binary) {
    try {
      await fs.promises.access(live.binary, fs.constants.X_OK)
    } catch {
      error = `ACP binary not found or not executable: ${live.binary}`
    }
  }

  return {
    configured: snapshot.runner,
    active: live,
    ready: !error,
    error,
  }
}

export async function broadcastLocalAgentConfig() {
  await Promise.allSettled(
    [...states.values()].map(async (state) => {
      const snapshot = await currentSnapshot(state.snapshot.runner)
      const key = snapshotKey(snapshot)
      if (state.key !== key) {
        state.adapter.dispose()
        state.key = key
        state.adapter = createAdapter(state.ws, snapshot)
      }
      await sync(state, snapshot)
    }),
  )
}

export function listLocalAgentStates() {
  return [...states.entries()].map(([workspaceId, state]) => ({
    workspaceId,
    runner: state.snapshot.runner,
    error: state.error,
  }))
}

export async function shutdownLocalAgentEngine() {
  for (const state of states.values()) {
    state.adapter.dispose()
  }
  states.clear()
}
