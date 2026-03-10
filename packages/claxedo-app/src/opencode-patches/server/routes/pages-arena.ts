import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { lazy } from "@/util/lazy"
import { createHash } from "node:crypto"
import { Instance } from "@/project/instance"
import { ClaxedoDB } from "@/storage/claxedo-db"

const arenaDefault = {
  max_agents: 5,
  max_rounds: 3,
  max_wave_runtime_ms: 90_000,
  max_turn_runtime_ms: 10 * 60 * 1000,
  max_relay_chars: 1800,
  recent_messages: 10,
}

const arenaDebug = process.env.CLAXEDO_ARENA_DEBUG !== "0"

function arenaLog(event: string, data?: Record<string, unknown>) {
  if (!arenaDebug) return
  if (data) {
    console.info(`[pages-arena] ${event}`, data)
    return
  }
  console.info(`[pages-arena] ${event}`)
}

type ArenaSignal = "continue" | "done" | "question"
type ArenaStatus = "idle" | "running" | "paused" | "stopping" | "completed" | "failed"
type WaveStatus = "running" | "completed" | "failed" | "stopped"

type ArenaConfig = typeof arenaDefault & {
  agents: Array<{
    name: string
    role: string
    duty: string
    model: string
    style?: string
    temperature?: number
  }>
}

type ArenaRow = {
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

type ArenaAgentRow = {
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

type ArenaMessageRow = {
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

type ArenaWaveRow = {
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

type OpencodePart = {
  type?: string
  text?: string
  ignored?: boolean
  toolName?: string
  state?: { status?: string; output?: unknown } | null
  title?: string
}

type OpencodeError = {
  name?: string
  message?: string
  data?: { message?: string; providerID?: string; modelID?: string }
}

type OpencodePromptResult = {
  info?: { id?: string; providerID?: string; modelID?: string; error?: OpencodeError | null }
  parts?: OpencodePart[]
}

type ArenaRuntime = {
  processing: boolean
  paused: boolean
  abort: AbortController
}

const runtimes = new Map<string, ArenaRuntime>()
const listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>()

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

function positive(value: unknown, fallback: number) {
  const raw = typeof value === "string" ? value : typeof value === "number" ? String(value) : ""
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return parsed
}

function asJson<T>(value: string, fallback: T): T {
  try {
    const parsed = JSON.parse(value)
    return (parsed as T) ?? fallback
  } catch {
    return fallback
  }
}

function now() {
  return Date.now()
}

function arenaForPage(pageID: string) {
  return ClaxedoDB.raw()
    .query("SELECT * FROM claxedo_page_arena WHERE page_id = ? ORDER BY updated_at DESC LIMIT 1")
    .get(pageID) as ArenaRow | undefined
}

function arenaByID(arenaID: string) {
  return ClaxedoDB.raw().query("SELECT * FROM claxedo_page_arena WHERE id = ?").get(arenaID) as ArenaRow | undefined
}

function agentsForArena(arenaID: string) {
  return ClaxedoDB.raw()
    .query("SELECT * FROM claxedo_page_arena_agent WHERE arena_id = ? ORDER BY created_at ASC")
    .all(arenaID) as ArenaAgentRow[]
}

function wavesForArena(arenaID: string, limit = 8) {
  return ClaxedoDB.raw()
    .query("SELECT * FROM claxedo_page_arena_wave WHERE arena_id = ? ORDER BY started_at DESC LIMIT ?")
    .all(arenaID, limit) as ArenaWaveRow[]
}

function messagesForArena(arenaID: string, limit = 200) {
  return ClaxedoDB.raw()
    .query("SELECT * FROM claxedo_page_arena_message WHERE arena_id = ? ORDER BY created_at ASC LIMIT ?")
    .all(arenaID, limit) as ArenaMessageRow[]
}

function latestWave(arenaID: string) {
  return ClaxedoDB.raw()
    .query("SELECT * FROM claxedo_page_arena_wave WHERE arena_id = ? ORDER BY started_at DESC LIMIT 1")
    .get(arenaID) as ArenaWaveRow | undefined
}

function latestUserMessage(arenaID: string) {
  return ClaxedoDB.raw()
    .query("SELECT * FROM claxedo_page_arena_message WHERE arena_id = ? AND kind = 'user' ORDER BY created_at DESC LIMIT 1")
    .get(arenaID) as ArenaMessageRow | undefined
}

function relayRuntime(arenaID: string) {
  const existing = runtimes.get(arenaID)
  if (existing) return existing
  const created: ArenaRuntime = {
    processing: false,
    paused: false,
    abort: new AbortController(),
  }
  runtimes.set(arenaID, created)
  return created
}

function emit(arenaID: string, event: Record<string, unknown>) {
  const set = listeners.get(arenaID)
  if (!set || set.size === 0) return
  const payload = {
    id: id("evt"),
    arena_id: arenaID,
    ts: now(),
    ...event,
  }
  for (const fn of set.values()) fn(payload)
}

function onEvent(arenaID: string, fn: (event: Record<string, unknown>) => void) {
  let set = listeners.get(arenaID)
  if (!set) {
    set = new Set()
    listeners.set(arenaID, set)
  }
  set.add(fn)
  return () => {
    set?.delete(fn)
    if (set && set.size === 0) listeners.delete(arenaID)
  }
}

function modelRef(value: string) {
  const source = clean(value)
  if (!source) return undefined
  const idx = source.indexOf("/")
  if (idx < 1 || idx >= source.length - 1) return undefined
  return {
    providerID: source.slice(0, idx),
    modelID: source.slice(idx + 1),
  }
}

function apiPath(pathname: string, directory: string) {
  if (!directory) return pathname
  const join = pathname.includes("?") ? "&" : "?"
  return `${pathname}${join}directory=${encodeURIComponent(directory)}`
}

function parseFooter(text: string) {
  const source = text.trimEnd()
  const match = /(?:\r?\n)?@arena:(continue|done|question)\s*$/i.exec(source)
  if (!match) {
    return {
      visible: source,
      signal: "continue" as ArenaSignal,
      parse_warning: true,
    }
  }
  const signal = match[1].toLowerCase() as ArenaSignal
  const visible = source.slice(0, match.index).trimEnd()
  return {
    visible: visible || source,
    signal,
    parse_warning: false,
  }
}

function extractText(parts: OpencodePart[] | undefined) {
  const text = (parts || [])
    .filter((part) => part.type === "text" && !part.ignored)
    .map((part) => part.text || "")
    .join("")
    .trim()
  if (text) return text
  const toolText = (parts || [])
    .filter((part) => part.type === "tool" && part.state?.status === "completed")
    .map((part) => {
      const output = part.state?.output
      if (typeof output === "string") return output
      if (!output || typeof output !== "object") return ""
      const value = (output as { text?: unknown }).text
      return typeof value === "string" ? value : ""
    })
    .join("\n")
    .trim()
  return toolText
}

function extractError(result: OpencodePromptResult | null | undefined) {
  const error = result?.info?.error
  if (!error) return ""
  const message = clean(error.data?.message || error.message)
  if (!message) return "OpenCode model request failed"
  const provider = clean(error.data?.providerID)
  if (!provider) return message
  return `${provider}: ${message}`
}

function compactRelay(text: string, max: number) {
  if (text.length <= max) return text
  const first = text
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .join(" ")
    .trim()
  if (first && first.length <= max) return `${first} …`
  return `${text.slice(0, Math.max(80, max - 2)).trimEnd()}…`
}

function compactDocument(text: string, max: number) {
  const source = clean(text)
  if (!source) return ""
  if (source.length <= max) return source
  const keep = Math.max(200, Math.floor((max - 20) / 2))
  const head = source.slice(0, keep).trimEnd()
  const tail = source.slice(-keep).trimStart()
  return `${head}\n\n...[document truncated]...\n\n${tail}`
}

function extractTools(parts: OpencodePart[] | undefined) {
  return (parts || [])
    .filter((part) => part.type === "tool" || part.type === "tool-invocation")
    .map((part) => {
      const output = part.state?.output
      const preview = typeof output === "string" ? output : JSON.stringify(output || "")
      return {
        name: clean(part.toolName || part.title || "tool"),
        status: clean(part.state?.status || "completed") || "completed",
        output: clean(preview).slice(0, 260),
      }
    })
    .filter((tool) => !!tool.name)
}

const opencodeFetch = async (origin: string, directory: string, pathname: string, init: RequestInit) => {
  const timeout = AbortSignal.timeout(90_000)
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  const res = await fetch(`${origin}${apiPath(pathname, directory)}`, {
    ...init,
    signal,
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  })
  if (res.ok) {
    if (res.status === 204) return null
    const text = await res.text()
    if (!text.trim()) return null
    return JSON.parse(text) as unknown
  }
  const body = await res.text().catch(() => "")
  const message = body || `OpenCode request failed (${res.status})`
  const error = new Error(message) as Error & { status?: number }
  error.status = res.status
  throw error
}

async function createSession(origin: string, directory: string, body: Record<string, unknown>) {
  const data = (await opencodeFetch(origin, directory, "/session", {
    method: "POST",
    body: JSON.stringify(body),
  })) as { id?: string; data?: { id?: string } } | null
  const sid = clean(data?.id || data?.data?.id)
  if (!sid) throw new Error("OpenCode did not return a session id")
  return sid
}

async function promptSession(
  origin: string,
  directory: string,
  sessionID: string,
  system: string,
  prompt: string,
  model: { providerID: string; modelID: string } | undefined,
  signal?: AbortSignal,
) {
  const arenaAgent = clean(process.env.PAGES_ARENA_AGENT) || "build"
  arenaLog("opencode.message.request", {
    session_id: sessionID,
    directory,
    agent: arenaAgent,
    model: model ? `${model.providerID}/${model.modelID}` : null,
    system_len: system.length,
    prompt_len: prompt.length,
  })
  const result = (await opencodeFetch(origin, directory, `/session/${encodeURIComponent(sessionID)}/message`, {
    method: "POST",
    signal,
    body: JSON.stringify({
      agent: arenaAgent,
      system,
      model,
      parts: [{ type: "text", text: prompt }],
    }),
  })) as OpencodePromptResult | null

  const firstErr = extractError(result)
  let full = result
  let text = extractText(result?.parts)
  if (!text && result?.info?.id) {
    const detail = (await opencodeFetch(
      origin,
      directory,
      `/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(result.info.id)}`,
      { method: "GET", signal },
    )) as OpencodePromptResult | null
    const nextErr = extractError(detail)
    if (nextErr) throw new Error(nextErr)
    full = detail || result
    text = extractText(detail?.parts)
  }
  if (!text && firstErr) throw new Error(firstErr)
  if (!text) throw new Error("OpenCode returned empty output")
  arenaLog("opencode.message.response", {
    session_id: sessionID,
    text_len: text.length,
    part_count: (full?.parts || result?.parts || []).length,
  })

  return {
    text,
    parts: full?.parts || result?.parts || [],
  }
}

function sanitizeAgents(input: unknown) {
  const raw = Array.isArray(input) ? input : []
  const picked = raw.slice(0, arenaDefault.max_agents)
  const keys = new Set<string>()
  const agents = picked
    .map((item, idx) => {
      const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {}
      const name = clean(row.name) || `agent-${idx + 1}`
      const role = clean(row.role) || "participant"
      const duty = clean(row.duty) || "Contribute toward the user goal."
      const model = clean(row.model) || clean(process.env.PAGES_AI_MODEL) || "opencode/big-pickle"
      const style = clean(row.style)
      const temperature = positive(row.temperature, 0.2)
      const base = name
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
      model: clean(process.env.PAGES_AI_MODEL) || "opencode/big-pickle",
      style: "",
      temperature: 0.2,
    },
    {
      key: "critic",
      name: "critic",
      role: "challenger",
      duty: "Challenge weak assumptions and identify risks.",
      model: clean(process.env.PAGES_AI_MODEL) || "opencode/big-pickle",
      style: "",
      temperature: 0.2,
    },
    {
      key: "editor",
      name: "editor",
      role: "synthesizer",
      duty: "Synthesize converged decisions clearly.",
      model: clean(process.env.PAGES_AI_MODEL) || "opencode/big-pickle",
      style: "",
      temperature: 0.2,
    },
  ]
}

function parseMentions(text: string, keys: string[]) {
  const found = new Set<string>()
  const lower = text.toLowerCase()
  keys.forEach((key) => {
    if (lower.includes(`@${key.toLowerCase()}`)) found.add(key)
  })
  return [...found]
}

function arenaState(pageID: string) {
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

function updateArena(arenaID: string, patch: Partial<Omit<ArenaRow, "id" | "page_id" | "created_at">>) {
  const arena = arenaByID(arenaID)
  if (!arena) return
  const next = {
    ...arena,
    ...patch,
    updated_at: now(),
  }
  ClaxedoDB.raw()
    .query(
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

function updateWave(waveID: string, patch: Partial<Omit<ArenaWaveRow, "id" | "arena_id" | "started_at">>) {
  const wave = ClaxedoDB.raw().query("SELECT * FROM claxedo_page_arena_wave WHERE id = ?").get(waveID) as ArenaWaveRow | undefined
  if (!wave) return
  const next = {
    ...wave,
    ...patch,
    updated_at: now(),
  }
  ClaxedoDB.raw()
    .query(
      `UPDATE claxedo_page_arena_wave
        SET status = ?, round_num = ?, target_json = ?, termination = ?, finished_at = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(next.status, next.round_num, next.target_json, next.termination, next.finished_at, next.updated_at, waveID)
}

function updateAgent(agentID: string, patch: Partial<Omit<ArenaAgentRow, "id" | "arena_id" | "agent_key" | "created_at">>) {
  const row = ClaxedoDB.raw().query("SELECT * FROM claxedo_page_arena_agent WHERE id = ?").get(agentID) as ArenaAgentRow | undefined
  if (!row) return
  const next = {
    ...row,
    ...patch,
    updated_at: now(),
  }
  ClaxedoDB.raw()
    .query(
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

function addMessage(input: {
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
    .query(
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

function addDelivery(input: {
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
    .query(
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

function summarize(arenaID: string) {
  const rows = ClaxedoDB.raw()
    .query(
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

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function waitPaused(arenaID: string, runtime: ArenaRuntime) {
  while (runtime.paused && !runtime.abort.signal.aborted) {
    updateArena(arenaID, { status: "paused" })
    emit(arenaID, { type: "arena.status", status: "paused" })
    await wait(200)
  }
}

function promptForAgent(input: {
  agent: ArenaAgentRow
  synopsis: string
  packets: string[]
  document: string
  round: number
}) {
  const style = clean(input.agent.style)
  const directives = [
    `You are ${input.agent.display_name}.`,
    `Role: ${input.agent.role}.`,
    `Duty: ${input.agent.duty}.`,
    "Speak naturally and stay tightly relevant to the user goal.",
    "If document context is provided below, treat it as the document under discussion unless the user overrides it.",
    "Keep your visible response under ~180 words when possible.",
    "At the end of your final line, append exactly one control tag: @arena:continue OR @arena:done OR @arena:question.",
    "Do not include any extra control syntax.",
  ]
  if (style) directives.push(`Style: ${style}.`)
  const intro = directives.join("\n")
  const synopsis = clean(input.synopsis)
  const packet = input.packets.length > 0 ? input.packets.join("\n\n") : "(no new peer input)"
  const body = [
    `Round: ${input.round}`,
    input.document ? `Document context (current page markdown):\n${input.document}` : "",
    synopsis ? `Arena synopsis:\n${synopsis}` : "",
    `Incoming discussion packets:\n${packet}`,
    "Respond now.",
  ]
    .filter(Boolean)
    .join("\n\n")
  return { system: intro, prompt: body }
}

async function runWave(input: {
  origin: string
  page_id: string
  arena_id: string
  wave_id: string
}) {
  arenaLog("wave.start", {
    page_id: input.page_id,
    arena_id: input.arena_id,
    wave_id: input.wave_id,
  })
  const runtime = relayRuntime(input.arena_id)
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

    const wave = ClaxedoDB.raw().query("SELECT * FROM claxedo_page_arena_wave WHERE id = ?").get(input.wave_id) as ArenaWaveRow | undefined
    if (!wave) return

    const agents = agentsForArena(input.arena_id)
    if (agents.length === 0) {
      updateWave(input.wave_id, { status: "failed", termination: "no_agents", finished_at: now() })
      updateArena(input.arena_id, { status: "failed", last_error: "No arena agents configured" })
      emit(input.arena_id, { type: "arena.failed", reason: "no_agents" })
      return
    }

    const targetSet = new Set(asJson<string[]>(wave.target_json || "[]", []))
    const target = targetSet.size > 0 ? agents.filter((agent) => targetSet.has(agent.agent_key)) : agents
    arenaLog("wave.targets", {
      page_id: input.page_id,
      arena_id: input.arena_id,
      wave_id: input.wave_id,
      target_count: target.length,
      targets: target.map((item) => item.agent_key),
      agent_count: agents.length,
    })

    if (target.length === 0) {
      updateWave(input.wave_id, { status: "failed", termination: "no_targets", finished_at: now() })
      updateArena(input.arena_id, { status: "failed", last_error: "No matching targets" })
      emit(input.arena_id, { type: "arena.failed", reason: "no_targets" })
      return
    }

    const user = ClaxedoDB.raw()
      .query("SELECT * FROM claxedo_page_arena_message WHERE wave_id = ? AND kind = 'user' ORDER BY created_at ASC LIMIT 1")
      .get(input.wave_id) as ArenaMessageRow | undefined

    if (!user) {
      updateWave(input.wave_id, { status: "failed", termination: "missing_user", finished_at: now() })
      updateArena(input.arena_id, { status: "failed", last_error: "Wave has no user prompt" })
      return
    }
    const userMeta = asJson<Record<string, unknown>>(user.metadata_json || "{}", {})
    const document = compactDocument(typeof userMeta.page_context === "string" ? userMeta.page_context : "", 6000)
    arenaLog("wave.context", {
      page_id: input.page_id,
      arena_id: input.arena_id,
      wave_id: input.wave_id,
      user_text_len: user.text.length,
      page_context_len: document.length,
    })

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
    emit(input.arena_id, { type: "arena.status", status: "running" })

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
      emit(input.arena_id, { type: "arena.round", round })
      arenaLog("round.start", {
        page_id: input.page_id,
        arena_id: input.arena_id,
        wave_id: input.wave_id,
        round,
        settled_count: settled.size,
      })

      const replies: Array<{
        agent: ArenaAgentRow
        message: ReturnType<typeof addMessage>
        signal: ArenaSignal
      }> = []

      for (const agent of target) {
        if (settled.has(agent.agent_key)) continue
        const packets = inbound.get(agent.agent_key) || []
        if (packets.length === 0) continue

        updateAgent(agent.id, { status: "running" })
        emit(input.arena_id, {
          type: "arena.agent_status",
          wave_id: input.wave_id,
          round,
          agent: agent.agent_key,
          status: "running",
        })

        const freshArena = arenaByID(input.arena_id)
        const synopsis = clean(freshArena?.synopsis || "")
        const prompt = promptForAgent({ agent, synopsis, packets, document, round })
        arenaLog("agent.prompt", {
          page_id: input.page_id,
          arena_id: input.arena_id,
          wave_id: input.wave_id,
          round,
          agent_key: agent.agent_key,
          session_id: agent.session_id,
          packet_count: packets.length,
          packet_chars: packets.join("\n").length,
        })

        try {
          const result = await promptSession(
            input.origin,
            clean(freshArena?.directory || ""),
            agent.session_id,
            prompt.system,
            prompt.prompt,
            modelRef(agent.model),
            runtime.abort.signal,
          )
          if (runtime.abort.signal.aborted) {
            termination = "stopped"
            break
          }
          const parsed = parseFooter(result.text)
          const tools = extractTools(result.parts)
          arenaLog("agent.reply", {
            page_id: input.page_id,
            arena_id: input.arena_id,
            wave_id: input.wave_id,
            round,
            agent_key: agent.agent_key,
            signal: parsed.signal,
            parse_warning: parsed.parse_warning,
            text_len: parsed.visible.length,
            tool_count: tools.length,
            tools: tools.map((tool) => tool.name),
          })
          const msg = addMessage({
            arena_id: input.arena_id,
            wave_id: input.wave_id,
            round_num: round,
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
          emit(input.arena_id, {
            type: "arena.agent_status",
            wave_id: input.wave_id,
            round,
            agent: agent.agent_key,
            status: parsed.signal === "done" ? "done" : parsed.signal,
          })
          if (parsed.signal === "done") settled.add(agent.agent_key)
          replies.push({ agent, message: msg, signal: parsed.signal })
          emit(input.arena_id, {
            type: "arena.message",
            message: {
              id: msg.id,
              kind: "agent",
              source: agent.agent_key,
              text: parsed.visible,
              signal: parsed.signal,
              round,
              meta: { tools },
            },
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          arenaLog("agent.error", {
            page_id: input.page_id,
            arena_id: input.arena_id,
            wave_id: input.wave_id,
            round,
            agent_key: agent.agent_key,
            error: message,
          })
          updateAgent(agent.id, { status: "failed", settled: 1, last_signal: "question" })
          emit(input.arena_id, {
            type: "arena.agent_status",
            wave_id: input.wave_id,
            round,
            agent: agent.agent_key,
            status: "failed",
          })
          settled.add(agent.agent_key)
          addMessage({
            arena_id: input.arena_id,
            wave_id: input.wave_id,
            round_num: round,
            kind: "system",
            source_agent_key: agent.agent_key,
            text: `Agent ${agent.display_name} failed: ${message}`,
            control_signal: "question",
            metadata: { error: true },
          })
          emit(input.arena_id, { type: "arena.agent_failed", agent: agent.agent_key, error: message })
        }
      }
      if (termination === "stopped") break

      if (settled.size >= target.length) {
        termination = "all_done"
        break
      }

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
            arena_id: input.arena_id,
            wave_id: input.wave_id,
            message_id: reply.message.id,
            source_agent_key: reply.agent.agent_key,
            target_agent_key: agent.agent_key,
            status: "done",
          })
        }
      }

      const hasRelay = [...next.values()].some((rows) => rows.length > 0)
      emit(input.arena_id, {
        type: "arena.relay",
        wave_id: input.wave_id,
        round,
        has_relay: hasRelay,
      })
      arenaLog("round.relay", {
        page_id: input.page_id,
        arena_id: input.arena_id,
        wave_id: input.wave_id,
        round,
        relay_targets: [...next.entries()].map(([key, rows]) => ({
          key,
          packets: rows.length,
        })),
        has_relay: hasRelay,
      })
      if (!hasRelay) {
        termination = "no_new_content"
        break
      }

      for (const [key, rows] of next.entries()) inbound.set(key, rows)
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
    arenaLog("wave.done", {
      page_id: input.page_id,
      arena_id: input.arena_id,
      wave_id: input.wave_id,
      termination,
      rounds_used: Math.max(1, round),
      settled_count: settled.size,
      target_count: target.length,
    })
    emit(input.arena_id, {
      type: "arena.completed",
      termination,
      state: arenaState(input.page_id),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    arenaLog("wave.failed", {
      page_id: input.page_id,
      arena_id: input.arena_id,
      wave_id: input.wave_id,
      error: message,
    })
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
    emit(input.arena_id, {
      type: "arena.failed",
      error: message,
      state: arenaState(input.page_id),
    })
  } finally {
    const runtime = relayRuntime(input.arena_id)
    runtime.processing = false
  }
}

function createArenaConfig(body: Record<string, unknown>): ArenaConfig {
  const base = body.config && typeof body.config === "object" ? (body.config as Record<string, unknown>) : {}
  const agents = sanitizeAgents(base.agents)
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

function pickDirectory(query: string, header: string, body: string) {
  return clean(query || header || body)
}

export const PageArenaRoutes = lazy(() =>
  new Hono()
    .post("/start", async (c) => {
      const pageID = c.req.param("id")
      const body = (await c.req.json<Record<string, unknown>>().catch(() => ({}))) || {}
      const origin = new URL(c.req.url).origin
      const directory = pickDirectory(
        c.req.query("directory") || "",
        c.req.header("x-opencode-directory") || "",
        clean(body.directory),
      )
      const config = createArenaConfig(body)
      const parentInput = clean(body.parent_session_id || body.parentSessionId)
      arenaLog("route.start", {
        page_id: pageID,
        directory,
        parent_input: parentInput || null,
        agents: config.agents.map((item) => ({
          key: item.key,
          name: item.name,
          model: item.model,
        })),
      })

      const existing = arenaForPage(pageID)
      if (existing && (existing.status === "running" || existing.status === "paused" || existing.status === "stopping")) {
        const run = relayRuntime(existing.id)
        run.abort.abort()
        run.paused = false
        updateArena(existing.id, { status: "completed", stop_reason: "restarted" })
      }

      const parentSessionID =
        parentInput ||
        (await createSession(origin, directory, {
          title: `Page Arena • ${pageID}`,
        }))
      arenaLog("route.start.parent", {
        page_id: pageID,
        arena_parent_session_id: parentSessionID,
      })

      const arenaID = id("arena")
      const created = now()
      ClaxedoDB.raw()
        .query(
          `INSERT INTO claxedo_page_arena
            (id, page_id, directory, parent_session_id, status, config_json, synopsis, active_wave_id, current_round, stop_reason, last_error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(arenaID, pageID, directory, parentSessionID, "idle", JSON.stringify(config), "", "", 0, "", "", created, created)

      for (const row of config.agents) {
        const sessionID = await createSession(origin, directory, {
          parentID: parentSessionID,
          title: `Arena • ${row.name}`,
        })
        arenaLog("route.start.child", {
          page_id: pageID,
          arena_id: arenaID,
          agent_key: row.key,
          agent_name: row.name,
          child_session_id: sessionID,
        })
        const ts = now()
        ClaxedoDB.raw()
          .query(
            `INSERT INTO claxedo_page_arena_agent
              (id, arena_id, agent_key, display_name, role, duty, model, style, temperature, session_id, status, settled, last_signal, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id("ara"),
            arenaID,
            row.key,
            row.name,
            row.role,
            row.duty,
            row.model,
            row.style || "",
            row.temperature,
            sessionID,
            "idle",
            0,
            "",
            ts,
            ts,
          )
      }

      const state = arenaState(pageID)
      emit(arenaID, { type: "arena.started", state })
      arenaLog("route.start.done", {
        page_id: pageID,
        arena_id: arenaID,
        child_count: config.agents.length,
      })
      return c.json(state)
    })
    .get("/state", async (c) => {
      const pageID = c.req.param("id")
      return c.json(arenaState(pageID))
    })
    .post("/message", async (c) => {
      const pageID = c.req.param("id")
      const body = (await c.req.json<Record<string, unknown>>().catch(() => ({}))) || {}
      const text = clean(body.text)
      if (!text) return c.json({ error: "text is required" }, 400)
      const page_context = compactDocument(typeof body.page_context === "string" ? body.page_context : "", 6000)

      const arena = arenaForPage(pageID)
      if (!arena) return c.json({ error: "Arena not started" }, 404)
      if (arena.status === "stopping") return c.json({ error: "Arena is stopping" }, 409)

      const targetInput = Array.isArray(body.targets)
        ? body.targets.map((item) => clean(item)).filter(Boolean)
        : Array.isArray(body.mentions)
          ? body.mentions.map((item) => clean(item)).filter(Boolean)
          : []

      const all = agentsForArena(arena.id)
      const allKeys = all.map((agent) => agent.agent_key)
      const mention = parseMentions(text, allKeys)
      const target = [...new Set([...targetInput, ...mention])].filter((key) => allKeys.includes(key))
      arenaLog("route.message", {
        page_id: pageID,
        arena_id: arena.id,
        text_len: text.length,
        target_input: targetInput,
        mention_target: mention,
        target,
        page_context_len: page_context.length,
      })

      const waveID = id("wave")
      const started = now()
      ClaxedoDB.raw()
        .query(
          `INSERT INTO claxedo_page_arena_wave
            (id, arena_id, status, round_num, target_json, termination, started_at, finished_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(waveID, arena.id, "running", 0, JSON.stringify(target), "", started, 0, started)

      const msg = addMessage({
        arena_id: arena.id,
        wave_id: waveID,
        round_num: 0,
        kind: "user",
        source_agent_key: "user",
        text,
        control_signal: "continue",
        metadata: { hash: hash(text), targets: target, ...(page_context ? { page_context } : {}) },
      })

      updateArena(arena.id, {
        status: "running",
        active_wave_id: waveID,
        current_round: 0,
        stop_reason: "",
        last_error: "",
      })

      emit(arena.id, {
        type: "arena.message",
        message: {
          id: msg.id,
          kind: "user",
          source: "user",
          text,
          signal: "continue",
          round: 0,
          meta: { targets: target },
        },
      })

      void runWave({
        origin: new URL(c.req.url).origin,
        page_id: pageID,
        arena_id: arena.id,
        wave_id: waveID,
      })
      arenaLog("route.message.dispatched", {
        page_id: pageID,
        arena_id: arena.id,
        wave_id: waveID,
      })

      return c.json({ ok: true, wave_id: waveID, state: arenaState(pageID) })
    })
    .post("/control", async (c) => {
      const pageID = c.req.param("id")
      const body = (await c.req.json<Record<string, unknown>>().catch(() => ({}))) || {}
      const action = clean(body.action)
      const arena = arenaForPage(pageID)
      if (!arena) return c.json({ error: "Arena not started" }, 404)
      arenaLog("route.control", {
        page_id: pageID,
        arena_id: arena.id,
        action: action || null,
      })

      const runtime = relayRuntime(arena.id)

      if (action === "pause") {
        runtime.paused = true
        updateArena(arena.id, { status: "paused" })
        emit(arena.id, { type: "arena.status", status: "paused", state: arenaState(pageID) })
        return c.json({ ok: true, state: arenaState(pageID) })
      }

      if (action === "resume") {
        runtime.paused = false
        updateArena(arena.id, { status: "running" })
        emit(arena.id, { type: "arena.status", status: "running", state: arenaState(pageID) })
        const wave = latestWave(arena.id)
        if (wave && wave.status === "running" && !runtime.processing) {
          void runWave({
            origin: new URL(c.req.url).origin,
            page_id: pageID,
            arena_id: arena.id,
            wave_id: wave.id,
          })
        }
        return c.json({ ok: true, state: arenaState(pageID) })
      }

      if (action === "stop") {
        runtime.paused = false
        runtime.abort.abort()
        updateArena(arena.id, { status: "completed", stop_reason: "stopped_by_user", active_wave_id: "" })
        const wave = latestWave(arena.id)
        if (wave && wave.status === "running") {
          updateWave(wave.id, { status: "stopped", termination: "stopped_by_user", finished_at: now() })
        }
        emit(arena.id, { type: "arena.status", status: "completed", state: arenaState(pageID) })
        return c.json({ ok: true, state: arenaState(pageID) })
      }

      if (action === "retry") {
        const last = latestUserMessage(arena.id)
        if (!last) return c.json({ error: "No previous user message" }, 400)
        const meta = asJson<Record<string, unknown>>(last.metadata_json || "{}", {})
        const target = Array.isArray(meta.targets) ? meta.targets.map((item) => clean(item)).filter(Boolean) : []
        const waveID = id("wave")
        const started = now()
        ClaxedoDB.raw()
          .query(
            `INSERT INTO claxedo_page_arena_wave
              (id, arena_id, status, round_num, target_json, termination, started_at, finished_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(waveID, arena.id, "running", 0, JSON.stringify(Array.isArray(target) ? target : []), "", started, 0, started)
        addMessage({
          arena_id: arena.id,
          wave_id: waveID,
          round_num: 0,
          kind: "user",
          source_agent_key: "user",
          text: last.text,
          control_signal: "continue",
          metadata: {
            retry_of: last.id,
            ...(typeof meta.page_context === "string" && clean(meta.page_context)
              ? { page_context: compactDocument(meta.page_context, 6000) }
              : {}),
          },
        })
        updateArena(arena.id, {
          status: "running",
          active_wave_id: waveID,
          stop_reason: "",
          last_error: "",
        })
        void runWave({
          origin: new URL(c.req.url).origin,
          page_id: pageID,
          arena_id: arena.id,
          wave_id: waveID,
        })
        emit(arena.id, { type: "arena.retry", state: arenaState(pageID) })
        return c.json({ ok: true, state: arenaState(pageID) })
      }

      return c.json({ error: "Invalid action" }, 400)
    })
    .get("/events", async (c) => {
      const pageID = c.req.param("id")
      const arena = arenaForPage(pageID)
      arenaLog("route.events.open", {
        page_id: pageID,
        arena_id: arena?.id || null,
      })

      c.header("X-Accel-Buffering", "no")
      c.header("X-Content-Type-Options", "nosniff")

      return streamSSE(c, async (stream) => {
        stream.writeSSE({
          data: JSON.stringify({
            type: "arena.snapshot",
            state: arenaState(pageID),
          }),
        })

        let off = () => {}
        if (arena) {
          off = onEvent(arena.id, async (event) => {
            await stream.writeSSE({ data: JSON.stringify(event) })
          })
        }

        const heartbeat = setInterval(() => {
          stream.writeSSE({
            data: JSON.stringify({ type: "arena.heartbeat", ts: now() }),
          })
        }, 10_000)

        await new Promise<void>((resolve) => {
          stream.onAbort(() => {
            clearInterval(heartbeat)
            off()
            arenaLog("route.events.close", {
              page_id: pageID,
              arena_id: arena?.id || null,
            })
            resolve()
          })
        })
      })
    }),
)
