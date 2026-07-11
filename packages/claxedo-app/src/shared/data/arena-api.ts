/**
 * Frontend API client for Arena swarm runs.
 *
 * Arena runs are hosted under a page's routes (`/pages/:id/arena/*`) on
 * claxedo-server, so this client reuses the Pages URL builder + JSON request
 * helper. Kept separate from `pages-api.ts` so Pages CRUD and Arena swarm
 * control read as distinct wire clients.
 */
import { pagesUrl, request } from "./pages-api"

export type ArenaControlSignal = "continue" | "done" | "question"
export type ArenaStatus = "idle" | "running" | "paused" | "stopping" | "completed" | "failed"

export type ArenaAgentConfig = {
  name: string
  role: string
  duty: string
  model: string
  style?: string
  temperature?: number
}

export type ArenaConfig = {
  max_agents?: number
  max_rounds?: number
  max_wave_runtime_ms?: number
  max_turn_runtime_ms?: number
  max_relay_chars?: number
  recent_messages?: number
  agents?: ArenaAgentConfig[]
}

export type ArenaMessage = {
  id: string
  wave_id: string
  round: number
  kind: "user" | "agent" | "relay" | "system"
  source: string
  text: string
  signal: ArenaControlSignal
  meta: Record<string, unknown>
  created_at: number
}

export type ArenaAgentState = {
  key: string
  name: string
  role: string
  duty: string
  model: string
  status: string
  settled: boolean
  signal: string
}

export type ArenaWaveState = {
  id: string
  status: string
  round: number
  targets: string[]
  termination: string
  started_at: number
  finished_at: number
}

export type ArenaState = {
  arena: {
    id: string
    page_id: string
    status: ArenaStatus
    parent_session_id: string
    current_round: number
    stop_reason: string
    last_error: string
    synopsis: string
    config: ArenaConfig
    created_at: number
    updated_at: number
  } | null
  agents: ArenaAgentState[]
  waves: ArenaWaveState[]
  messages: ArenaMessage[]
}

export type ArenaStartRequest = {
  directory?: string
  parent_session_id?: string
  parentSessionId?: string
  config?: ArenaConfig
}

export type ArenaMessageRequest = {
  text: string
  targets?: string[]
  mentions?: string[]
  page_context?: string
}

export type ArenaControlRequest = {
  action: "pause" | "resume" | "stop" | "retry"
}

function cleanDir(value: unknown) {
  if (typeof value !== "string") return ""
  return value.trim()
}

export const arenaApi = {
  start(id: string, input: ArenaStartRequest): Promise<ArenaState> {
    return request<ArenaState>(pagesUrl({ pageId: id, path: "arena/start" }), {
      method: "POST",
      body: JSON.stringify(input),
    })
  },

  state(id: string): Promise<ArenaState> {
    return request<ArenaState>(pagesUrl({ pageId: id, path: "arena/state" }))
  },

  message(
    id: string,
    input: ArenaMessageRequest,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; wave_id: string; state: ArenaState }> {
    return request<{ ok: boolean; wave_id: string; state: ArenaState }>(pagesUrl({
      pageId: id,
      path: "arena/message",
    }), {
      method: "POST",
      body: JSON.stringify(input),
      signal,
    })
  },

  control(id: string, input: ArenaControlRequest): Promise<{ ok: boolean; state: ArenaState }> {
    return request<{ ok: boolean; state: ArenaState }>(pagesUrl({
      pageId: id,
      path: "arena/control",
    }), {
      method: "POST",
      body: JSON.stringify(input),
    })
  },

  eventsUrl(id: string, directory?: string) {
    const dir = cleanDir(directory)
    return String(pagesUrl({
      pageId: id,
      path: "arena/events",
      query: { directory: dir || undefined },
    }))
  },
}
