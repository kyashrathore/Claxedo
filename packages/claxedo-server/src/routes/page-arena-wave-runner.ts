import { ClaxedoDB } from "../storage/db"
import {
  compactDocument,
  compactRelay,
  extractTools,
  modelRef,
  parseFooter,
  promptForAgent,
  type ArenaSignal,
} from "./page-arena-format"
import { arenaRuntime, emitArenaEvent, waitPaused } from "./page-arena-events"
import { promptSession } from "./page-arena-opencode"
import type { PageArenaSettings } from "./page-arena-settings"
import { arenaState } from "./page-arena-state"
import {
  addDelivery,
  addMessage,
  agentsForArena,
  arenaByID,
  arenaDefault,
  asJson,
  clean,
  now,
  positive,
  summarize,
  updateAgent,
  updateArena,
  updateWave,
  type ArenaAgentRow,
  type ArenaConfig,
  type ArenaMessageRow,
  type ArenaStatus,
  type ArenaWaveRow,
} from "./page-arena-store"

export async function runArenaWave(input: {
  origin: string
  page_id: string
  arena_id: string
  wave_id: string
  settings: PageArenaSettings
}) {
  const runtime = arenaRuntime(input.arena_id)
  if (runtime.processing) return
  runtime.processing = true
  runtime.abort = new AbortController()
  runtime.paused = false

  try {
    const arena = arenaByID(input.arena_id)
    if (!arena) return
    const cfg = asJson<ArenaConfig>(arena.config_json || "{}", { ...arenaDefault, agents: [] })
    const maxRounds = Math.max(1, positive(cfg.max_rounds, arenaDefault.max_rounds))
    const maxTurn = Math.max(10_000, positive(cfg.max_turn_runtime_ms, arenaDefault.max_turn_runtime_ms))
    const maxWave = Math.max(20_000, positive(cfg.max_wave_runtime_ms, arenaDefault.max_wave_runtime_ms))
    const maxRelay = Math.max(200, positive(cfg.max_relay_chars, arenaDefault.max_relay_chars))
    const started = now()

    const wave = ClaxedoDB.raw().prepare("SELECT * FROM claxedo_page_arena_wave WHERE id = ?").get(input.wave_id) as
      | ArenaWaveRow
      | undefined
    if (!wave) return

    const agents = agentsForArena(input.arena_id)
    if (agents.length === 0) {
      updateWave(input.wave_id, { status: "failed", termination: "no_agents", finished_at: now() })
      updateArena(input.arena_id, { status: "failed", last_error: "No arena agents configured" })
      emitArenaEvent(input.arena_id, { type: "arena.failed", reason: "no_agents" })
      return
    }

    const targetSet = new Set(asJson<string[]>(wave.target_json || "[]", []))
    const target = targetSet.size > 0 ? agents.filter((agent) => targetSet.has(agent.agent_key)) : agents
    if (target.length === 0) {
      updateWave(input.wave_id, { status: "failed", termination: "no_targets", finished_at: now() })
      updateArena(input.arena_id, { status: "failed", last_error: "No matching targets" })
      emitArenaEvent(input.arena_id, { type: "arena.failed", reason: "no_targets" })
      return
    }

    const user = ClaxedoDB.raw()
      .prepare(
        "SELECT * FROM claxedo_page_arena_message WHERE wave_id = ? AND kind = 'user' ORDER BY created_at ASC LIMIT 1",
      )
      .get(input.wave_id) as ArenaMessageRow | undefined
    if (!user) {
      updateWave(input.wave_id, { status: "failed", termination: "missing_user", finished_at: now() })
      updateArena(input.arena_id, { status: "failed", last_error: "Wave has no user prompt" })
      return
    }

    const userMeta = asJson<Record<string, unknown>>(user.metadata_json || "{}", {})
    const document = compactDocument(typeof userMeta.page_context === "string" ? userMeta.page_context : "", 6000)
    const settled = new Set<string>()
    const inbound = new Map<string, string[]>()
    for (const agent of target) {
      updateAgent(agent.id, { settled: 0, status: "running", last_signal: "" })
      inbound.set(agent.agent_key, [user.text])
    }

    updateArena(input.arena_id, {
      status: "running",
      current_round: 1,
      active_wave_id: input.wave_id,
      stop_reason: "",
      last_error: "",
    })
    emitArenaEvent(input.arena_id, { type: "arena.status", status: "running" })

    let round = 1
    let termination = "max_rounds"
    while (round <= maxRounds) {
      if (runtime.abort.signal.aborted) {
        termination = "stopped"
        break
      }
      if (now() - started > maxTurn) {
        termination = "turn_timeout"
        break
      }
      if (now() - started > maxWave) {
        termination = "wave_timeout"
        break
      }
      await waitPaused(input.arena_id, runtime)
      if (runtime.abort.signal.aborted) {
        termination = "stopped"
        break
      }

      updateArena(input.arena_id, { status: "running", current_round: round })
      updateWave(input.wave_id, { status: "running", round_num: round })
      emitArenaEvent(input.arena_id, { type: "arena.round", round })

      const replies = await runArenaRound({
        input,
        target,
        settled,
        inbound,
        document,
        round,
        runtimeAbort: runtime.abort.signal,
      })
      if (runtime.abort.signal.aborted) {
        termination = "stopped"
        break
      }
      if (settled.size >= target.length) {
        termination = "all_done"
        break
      }
      if (!relayReplies(input.arena_id, input.wave_id, round, target, settled, replies, maxRelay, inbound)) {
        termination = "no_new_content"
        break
      }
      round += 1
    }

    const final = now()
    updateWave(input.wave_id, {
      status: termination === "stopped" ? "stopped" : "completed",
      round_num: Math.max(1, round),
      termination,
      finished_at: final,
    })
    const synopsis = summarize(input.arena_id)
    const status: ArenaStatus = termination === "stopped" ? "completed" : "idle"
    updateArena(input.arena_id, {
      status,
      synopsis,
      current_round: Math.max(1, round),
      stop_reason: termination,
      active_wave_id: "",
    })
    emitArenaEvent(input.arena_id, {
      type: "arena.completed",
      termination,
      state: arenaState(input.page_id),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    updateArena(input.arena_id, {
      status: "failed",
      last_error: message,
      active_wave_id: "",
    })
    updateWave(input.wave_id, {
      status: "failed",
      termination: "error",
      finished_at: now(),
    })
    emitArenaEvent(input.arena_id, {
      type: "arena.failed",
      error: message,
      state: arenaState(input.page_id),
    })
  } finally {
    const runtime = arenaRuntime(input.arena_id)
    runtime.processing = false
  }
}

async function runArenaRound(input: {
  input: {
    origin: string
    page_id: string
    arena_id: string
    wave_id: string
    settings: PageArenaSettings
  }
  target: ArenaAgentRow[]
  settled: Set<string>
  inbound: Map<string, string[]>
  document: string
  round: number
  runtimeAbort: AbortSignal
}) {
  const replies: Array<{
    agent: ArenaAgentRow
    message: ReturnType<typeof addMessage>
    signal: ArenaSignal
  }> = []
  for (const agent of input.target) {
    if (input.runtimeAbort.aborted) break
    if (input.settled.has(agent.agent_key)) continue
    const packets = input.inbound.get(agent.agent_key) || []
    if (packets.length === 0) continue
    await promptArenaAgent(input, agent, packets, replies)
    if (input.runtimeAbort.aborted) break
  }
  return replies
}

async function promptArenaAgent(
  input: Parameters<typeof runArenaRound>[0],
  agent: ArenaAgentRow,
  packets: string[],
  replies: Array<{
    agent: ArenaAgentRow
    message: ReturnType<typeof addMessage>
    signal: ArenaSignal
  }>,
) {
  updateAgent(agent.id, { status: "running" })
  emitArenaEvent(input.input.arena_id, {
    type: "arena.agent_status",
    wave_id: input.input.wave_id,
    round: input.round,
    agent: agent.agent_key,
    status: "running",
  })

  const freshArena = arenaByID(input.input.arena_id)
  const synopsis = clean(freshArena?.synopsis || "")
  const prompt = promptForAgent({ agent, synopsis, packets, document: input.document, round: input.round })
  try {
    const result = await promptSession(
      input.input.origin,
      clean(freshArena?.directory || ""),
      agent.session_id,
      prompt.system,
      prompt.prompt,
      modelRef(agent.model),
      input.input.settings,
      input.runtimeAbort,
    )
    if (input.runtimeAbort.aborted) return
    const parsed = parseFooter(result.text)
    const tools = extractTools(result.parts)
    const msg = addMessage({
      arena_id: input.input.arena_id,
      wave_id: input.input.wave_id,
      round_num: input.round,
      kind: "agent",
      source_agent_key: agent.agent_key,
      text: parsed.visible,
      raw_text: result.text,
      control_signal: parsed.signal,
      metadata: {
        parse_warning: parsed.parse_warning,
        tools,
      },
    })
    updateAgent(agent.id, {
      status: parsed.signal === "done" ? "done" : parsed.signal,
      settled: parsed.signal === "done" ? 1 : 0,
      last_signal: parsed.signal,
    })
    emitArenaEvent(input.input.arena_id, {
      type: "arena.agent_status",
      wave_id: input.input.wave_id,
      round: input.round,
      agent: agent.agent_key,
      status: parsed.signal === "done" ? "done" : parsed.signal,
    })
    if (parsed.signal === "done") input.settled.add(agent.agent_key)
    replies.push({ agent, message: msg, signal: parsed.signal })
    emitArenaEvent(input.input.arena_id, {
      type: "arena.message",
      message: {
        id: msg.id,
        kind: "agent",
        source: agent.agent_key,
        text: parsed.visible,
        signal: parsed.signal,
        round: input.round,
        meta: { tools },
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    updateAgent(agent.id, { status: "failed", settled: 1, last_signal: "question" })
    emitArenaEvent(input.input.arena_id, {
      type: "arena.agent_status",
      wave_id: input.input.wave_id,
      round: input.round,
      agent: agent.agent_key,
      status: "failed",
    })
    input.settled.add(agent.agent_key)
    addMessage({
      arena_id: input.input.arena_id,
      wave_id: input.input.wave_id,
      round_num: input.round,
      kind: "system",
      source_agent_key: agent.agent_key,
      text: `Agent ${agent.display_name} failed: ${message}`,
      control_signal: "question",
      metadata: { error: true },
    })
    emitArenaEvent(input.input.arena_id, { type: "arena.agent_failed", agent: agent.agent_key, error: message })
  }
}

function relayReplies(
  arenaID: string,
  waveID: string,
  round: number,
  target: ArenaAgentRow[],
  settled: Set<string>,
  replies: Array<{
    agent: ArenaAgentRow
    message: ReturnType<typeof addMessage>
    signal: ArenaSignal
  }>,
  maxRelay: number,
  inbound: Map<string, string[]>,
) {
  const next = new Map<string, string[]>()
  for (const agent of target) {
    if (settled.has(agent.agent_key)) continue
    next.set(agent.agent_key, [])
  }

  for (const reply of replies) {
    if (reply.signal === "done") continue
    const packet = compactRelay(
      `@${reply.agent.agent_key} (${reply.agent.role || "agent"}): ${reply.message.text}`,
      maxRelay,
    )
    for (const agent of target) {
      if (agent.agent_key === reply.agent.agent_key) continue
      if (settled.has(agent.agent_key)) continue
      const rows = next.get(agent.agent_key)
      if (!rows) continue
      rows.push(packet)
      addDelivery({
        arena_id: arenaID,
        wave_id: waveID,
        message_id: reply.message.id,
        source_agent_key: reply.agent.agent_key,
        target_agent_key: agent.agent_key,
        status: "done",
      })
    }
  }

  const hasRelay = [...next.values()].some((rows) => rows.length > 0)
  emitArenaEvent(arenaID, {
    type: "arena.relay",
    wave_id: waveID,
    round,
    has_relay: hasRelay,
  })
  if (!hasRelay) return false
  for (const [key, rows] of next.entries()) inbound.set(key, rows)
  return true
}
