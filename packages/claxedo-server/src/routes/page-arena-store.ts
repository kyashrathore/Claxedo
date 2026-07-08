import { createHash } from "node:crypto"
import { ClaxedoDB } from "../storage/db"
import type { ArenaSignal } from "./page-arena-format"

export const arenaDefault = {
  max_agents: 5,
  max_rounds: 3,
  max_wave_runtime_ms: 90_000,
  max_turn_runtime_ms: 10 * 60 * 1000,
  max_relay_chars: 1800,
  recent_messages: 10,
}

export type ArenaStatus = "idle" | "running" | "paused" | "stopping" | "completed" | "failed"
export type WaveStatus = "running" | "completed" | "failed" | "stopped"

export type ArenaConfig = typeof arenaDefault & {
  agents: Array<{
    key: string
    name: string
    role: string
    duty: string
    model: string
    style?: string
    temperature?: number
  }>
}

export type ArenaRow = {
  id: string
  page_id: string
  directory: string
  parent_session_id: string
  status: ArenaStatus
  config_json: string
  synopsis: string
  active_wave_id: string
  current_round: number
  stop_reason: string
  last_error: string
  created_at: number
  updated_at: number
}

export type ArenaAgentRow = {
  id: string
  arena_id: string
  agent_key: string
  display_name: string
  role: string
  duty: string
  model: string
  style: string
  temperature: number
  session_id: string
  status: string
  settled: number
  last_signal: string
  created_at: number
  updated_at: number
}

export type ArenaMessageRow = {
  id: string
  arena_id: string
  wave_id: string
  round_num: number
  kind: string
  source_agent_key: string
  text: string
  raw_text: string
  control_signal: string
  metadata_json: string
  created_at: number
}

export type ArenaWaveRow = {
  id: string
  arena_id: string
  status: WaveStatus
  round_num: number
  target_json: string
  termination: string
  started_at: number
  finished_at: number
  updated_at: number
}

export function clean(value: unknown) {
  if (typeof value !== "string") return ""
  return value.trim()
}

export function hash(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

export function id(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

export function positive(value: unknown, fallback: number) {
  const raw = typeof value === "string" ? value : typeof value === "number" ? String(value) : ""
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return parsed
}

export function asJson<T>(value: string, fallback: T): T {
  try {
    const parsed = JSON.parse(value)
    return (parsed as T) ?? fallback
  } catch {
    return fallback
  }
}

export function now() {
  return Date.now()
}

export function arenaForPage(pageID: string) {
  return ClaxedoDB.raw()
    .prepare("SELECT * FROM claxedo_page_arena WHERE page_id = ? ORDER BY updated_at DESC LIMIT 1")
    .get(pageID) as ArenaRow | undefined
}

export function arenaByID(arenaID: string) {
  return ClaxedoDB.raw().prepare("SELECT * FROM claxedo_page_arena WHERE id = ?").get(arenaID) as ArenaRow | undefined
}

export function agentsForArena(arenaID: string) {
  return ClaxedoDB.raw()
    .prepare("SELECT * FROM claxedo_page_arena_agent WHERE arena_id = ? ORDER BY created_at ASC")
    .all(arenaID) as ArenaAgentRow[]
}

export function wavesForArena(arenaID: string, limit = 8) {
  return ClaxedoDB.raw()
    .prepare("SELECT * FROM claxedo_page_arena_wave WHERE arena_id = ? ORDER BY started_at DESC LIMIT ?")
    .all(arenaID, limit) as ArenaWaveRow[]
}

export function messagesForArena(arenaID: string, limit = 200) {
  return ClaxedoDB.raw()
    .prepare("SELECT * FROM claxedo_page_arena_message WHERE arena_id = ? ORDER BY created_at ASC LIMIT ?")
    .all(arenaID, limit) as ArenaMessageRow[]
}

export function latestWave(arenaID: string) {
  return ClaxedoDB.raw()
    .prepare("SELECT * FROM claxedo_page_arena_wave WHERE arena_id = ? ORDER BY started_at DESC LIMIT 1")
    .get(arenaID) as ArenaWaveRow | undefined
}

export function latestUserMessage(arenaID: string) {
  return ClaxedoDB.raw()
    .prepare(
      "SELECT * FROM claxedo_page_arena_message WHERE arena_id = ? AND kind = 'user' ORDER BY created_at DESC LIMIT 1",
    )
    .get(arenaID) as ArenaMessageRow | undefined
}

export function updateArena(arenaID: string, patch: Partial<Omit<ArenaRow, "id" | "page_id" | "created_at">>) {
  const arena = arenaByID(arenaID)
  if (!arena) return
  const next = {
    ...arena,
    ...patch,
    updated_at: now(),
  }
  ClaxedoDB.raw()
    .prepare(
      `UPDATE claxedo_page_arena
        SET directory = ?, parent_session_id = ?, status = ?, config_json = ?, synopsis = ?, active_wave_id = ?,
            current_round = ?, stop_reason = ?, last_error = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(
      next.directory,
      next.parent_session_id,
      next.status,
      next.config_json,
      next.synopsis,
      next.active_wave_id,
      next.current_round,
      next.stop_reason,
      next.last_error,
      next.updated_at,
      arenaID,
    )
}

export function updateWave(waveID: string, patch: Partial<Omit<ArenaWaveRow, "id" | "arena_id" | "started_at">>) {
  const wave = ClaxedoDB.raw().prepare("SELECT * FROM claxedo_page_arena_wave WHERE id = ?").get(waveID) as
    | ArenaWaveRow
    | undefined
  if (!wave) return
  const next = {
    ...wave,
    ...patch,
    updated_at: now(),
  }
  ClaxedoDB.raw()
    .prepare(
      `UPDATE claxedo_page_arena_wave
        SET status = ?, round_num = ?, target_json = ?, termination = ?, finished_at = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(next.status, next.round_num, next.target_json, next.termination, next.finished_at, next.updated_at, waveID)
}

export function updateAgent(
  agentID: string,
  patch: Partial<Omit<ArenaAgentRow, "id" | "arena_id" | "agent_key" | "created_at">>,
) {
  const row = ClaxedoDB.raw().prepare("SELECT * FROM claxedo_page_arena_agent WHERE id = ?").get(agentID) as
    | ArenaAgentRow
    | undefined
  if (!row) return
  const next = {
    ...row,
    ...patch,
    updated_at: now(),
  }
  ClaxedoDB.raw()
    .prepare(
      `UPDATE claxedo_page_arena_agent
        SET display_name = ?, role = ?, duty = ?, model = ?, style = ?, temperature = ?, session_id = ?,
            status = ?, settled = ?, last_signal = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(
      next.display_name,
      next.role,
      next.duty,
      next.model,
      next.style,
      next.temperature,
      next.session_id,
      next.status,
      next.settled,
      next.last_signal,
      next.updated_at,
      agentID,
    )
}

export function addMessage(input: {
  arena_id: string
  wave_id: string
  round_num: number
  kind: "user" | "agent" | "relay" | "system"
  source_agent_key?: string
  text: string
  raw_text?: string
  control_signal?: ArenaSignal
  metadata?: Record<string, unknown>
}) {
  const row = {
    id: id("arm"),
    arena_id: input.arena_id,
    wave_id: input.wave_id,
    round_num: input.round_num,
    kind: input.kind,
    source_agent_key: clean(input.source_agent_key || ""),
    text: input.text,
    raw_text: input.raw_text || input.text,
    control_signal: input.control_signal || "continue",
    metadata_json: JSON.stringify(input.metadata || {}),
    created_at: now(),
  }
  ClaxedoDB.raw()
    .prepare(
      `INSERT INTO claxedo_page_arena_message
        (id, arena_id, wave_id, round_num, kind, source_agent_key, text, raw_text, control_signal, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.arena_id,
      row.wave_id,
      row.round_num,
      row.kind,
      row.source_agent_key,
      row.text,
      row.raw_text,
      row.control_signal,
      row.metadata_json,
      row.created_at,
    )
  return row
}

export function addDelivery(input: {
  arena_id: string
  wave_id: string
  message_id: string
  source_agent_key: string
  target_agent_key: string
  status?: string
  error?: string
}) {
  const created = now()
  ClaxedoDB.raw()
    .prepare(
      `INSERT OR IGNORE INTO claxedo_page_arena_delivery
        (id, arena_id, wave_id, message_id, source_agent_key, target_agent_key, status, attempt, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id("ard"),
      input.arena_id,
      input.wave_id,
      input.message_id,
      input.source_agent_key,
      input.target_agent_key,
      clean(input.status || "done") || "done",
      1,
      clean(input.error || ""),
      created,
      created,
    )
}

export function summarize(arenaID: string) {
  const rows = ClaxedoDB.raw()
    .prepare(
      "SELECT kind, source_agent_key, text FROM claxedo_page_arena_message WHERE arena_id = ? ORDER BY created_at DESC LIMIT 12",
    )
    .all(arenaID) as Array<{ kind: string; source_agent_key: string; text: string }>
  if (!rows.length) return ""
  const out = rows
    .reverse()
    .map((row) => {
      const who = row.kind === "user" ? "user" : clean(row.source_agent_key || row.kind || "agent")
      return `- ${who}: ${clean(row.text).replace(/\s+/g, " ").slice(0, 180)}`
    })
    .join("\n")
  return out.slice(0, 1800)
}
