import {
  agentsForArena,
  arenaDefault,
  arenaForPage,
  asJson,
  clean,
  messagesForArena,
  wavesForArena,
  type ArenaConfig,
} from "./page-arena-store"
import type { ArenaSignal } from "./page-arena-format"

export function arenaState(pageID: string) {
  const arena = arenaForPage(pageID)
  if (!arena) return { arena: null, agents: [], waves: [], messages: [] }
  const agents = agentsForArena(arena.id).map((agent) => ({
    key: agent.agent_key,
    name: agent.display_name,
    role: agent.role,
    duty: agent.duty,
    model: agent.model,
    status: agent.status,
    settled: !!agent.settled,
    signal: clean(agent.last_signal || ""),
  }))
  const waves = wavesForArena(arena.id).map((wave) => ({
    id: wave.id,
    status: wave.status,
    round: wave.round_num,
    targets: asJson<string[]>(wave.target_json || "[]", []),
    termination: clean(wave.termination || ""),
    started_at: wave.started_at,
    finished_at: wave.finished_at,
  }))
  const messages = messagesForArena(arena.id).map((message) => ({
    id: message.id,
    wave_id: message.wave_id,
    round: message.round_num,
    kind: message.kind,
    source: clean(message.source_agent_key || "") || (message.kind === "user" ? "user" : "system"),
    text: message.text,
    signal: clean(message.control_signal || "continue") as ArenaSignal,
    meta: asJson<Record<string, unknown>>(message.metadata_json || "{}", {}),
    created_at: message.created_at,
  }))
  return {
    arena: {
      id: arena.id,
      page_id: arena.page_id,
      status: arena.status,
      parent_session_id: arena.parent_session_id,
      current_round: arena.current_round,
      stop_reason: clean(arena.stop_reason || ""),
      last_error: clean(arena.last_error || ""),
      synopsis: clean(arena.synopsis || ""),
      config: asJson<ArenaConfig>(arena.config_json || "{}", { ...arenaDefault, agents: [] }),
      created_at: arena.created_at,
      updated_at: arena.updated_at,
    },
    agents,
    waves,
    messages,
  }
}
