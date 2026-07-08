import {
  arenaDefault,
  clean,
  positive,
  type ArenaConfig,
} from "./page-arena-store"

export type PageArenaSettings = {
  agent: string
  model: string
}

export function arenaSettings(env: Record<string, string | undefined> | undefined) {
  return {
    agent: clean(env?.PAGES_ARENA_AGENT) || "build",
    model: clean(env?.PAGES_AI_MODEL) || "opencode/big-pickle",
  }
}

export function createArenaConfig(body: Record<string, unknown>, settings: PageArenaSettings): ArenaConfig {
  const base = body.config && typeof body.config === "object" ? (body.config as Record<string, unknown>) : {}
  const agents = sanitizeAgents(base.agents, settings)
  return {
    max_agents: Math.min(arenaDefault.max_agents, Math.max(1, positive(base.max_agents, arenaDefault.max_agents))),
    max_rounds: Math.max(1, Math.min(8, positive(base.max_rounds, arenaDefault.max_rounds))),
    max_wave_runtime_ms: Math.max(20_000, positive(base.max_wave_runtime_ms, arenaDefault.max_wave_runtime_ms)),
    max_turn_runtime_ms: Math.max(60_000, positive(base.max_turn_runtime_ms, arenaDefault.max_turn_runtime_ms)),
    max_relay_chars: Math.max(200, positive(base.max_relay_chars, arenaDefault.max_relay_chars)),
    recent_messages: Math.max(4, Math.min(24, positive(base.recent_messages, arenaDefault.recent_messages))),
    agents: agents.slice(0, arenaDefault.max_agents),
  }
}

export function parseMentions(text: string, keys: string[]) {
  const found = new Set<string>()
  const lower = text.toLowerCase()
  keys.forEach((key) => {
    if (lower.includes(`@${key.toLowerCase()}`)) found.add(key)
  })
  return [...found]
}

function sanitizeAgents(input: unknown, settings: PageArenaSettings) {
  const raw = Array.isArray(input) ? input : []
  const picked = raw.slice(0, arenaDefault.max_agents)
  const keys = new Set<string>()
  const agents = picked
    .map((item, idx) => {
      const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {}
      const name = clean(row.name) || `agent-${idx + 1}`
      const role = clean(row.role) || "participant"
      const duty = clean(row.duty) || "Contribute toward the user goal."
      const model = clean(row.model) || settings.model
      const style = clean(row.style)
      const temperature = positive(row.temperature, 0.2)
      const base =
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || `agent-${idx + 1}`
      let key = base
      let n = 2
      while (keys.has(key)) {
        key = `${base}-${n}`
        n += 1
      }
      keys.add(key)
      return { key, name, role, duty, model, style, temperature }
    })
    .filter((item) => !!item.name)
  if (agents.length > 0) return agents
  return [
    {
      key: "builder",
      name: "builder",
      role: "implementer",
      duty: "Propose concrete implementation steps and tradeoffs.",
      model: settings.model,
      style: "",
      temperature: 0.2,
    },
    {
      key: "critic",
      name: "critic",
      role: "challenger",
      duty: "Challenge weak assumptions and identify risks.",
      model: settings.model,
      style: "",
      temperature: 0.2,
    },
    {
      key: "editor",
      name: "editor",
      role: "synthesizer",
      duty: "Synthesize converged decisions clearly.",
      model: settings.model,
      style: "",
      temperature: 0.2,
    },
  ]
}
