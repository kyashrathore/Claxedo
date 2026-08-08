import { createReadStream, readFileSync } from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { DatabaseSync } from "node:sqlite"

import { classifyToolCall } from "./classify.js"

function at(value, keys) {
  for (const key of keys) {
    if (value == null || typeof value !== "object") return undefined
    value = value[key]
  }
  return value
}

function stringAt(value, keys) {
  const result = at(value, keys)
  return typeof result === "string" ? result : undefined
}

function timestamp(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null
    return value < 10_000_000_000 ? value * 1000 : value
  }
  if (typeof value !== "string") return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function parseInput(value) {
  if (typeof value !== "string") return object(value)
  try {
    return object(JSON.parse(value))
  } catch {
    return { command: value }
  }
}

function commandFrom(input) {
  if (typeof input === "string") return input
  if (!input || typeof input !== "object" || Array.isArray(input)) return ""
  for (const key of ["command", "cmd", "script"]) if (typeof input[key] === "string") return input[key]
  return commandFrom(input.input)
}

function compactInput(name, input) {
  const normalized = name.toLowerCase().replaceAll("-", "_")
  if (normalized === "exec" && typeof input === "string") return input
  if (["apply_patch", "edit", "patch", "replace", "write"].some((value) => normalized.includes(value))) return {}
  const command = commandFrom(input)
  return command ? { command } : {}
}

class ParserState {
  constructor(harness, file) {
    this.session = { id: `${path.basename(path.dirname(file))}:${path.parse(file).name}`, harness, calls: [] }
    this.pending = new Map()
    this.grokPending = new Map()
    this.sequence = 0
    this.turn = null
    this.parseErrors = 0
  }

  addCall(id, name, input, start) {
    const compact = compactInput(name, input)
    const call = {
      id,
      name,
      start,
      end: null,
      turn_id: this.turn,
      classification: classifyToolCall({ name, input: compact }),
    }
    this.session.calls.push(call)
    this.pending.set(id, call)
  }

  complete(id, end) {
    const call = this.pending.get(id)
    if (!call) return
    this.pending.delete(id)
    if (Number.isFinite(end)) call.end = end
  }
}

function parseCodex(row, state) {
  if (row.type === "session_meta")
    state.session.id = stringAt(row, ["payload", "id"]) ?? stringAt(row, ["payload", "session_id"]) ?? state.session.id
  if (row.type === "turn_context") state.turn = stringAt(row, ["payload", "turn_id"]) ?? state.turn
  if (row.type !== "response_item") return
  const type = stringAt(row, ["payload", "type"])
  if (type === "function_call" || type === "custom_tool_call") {
    const id = stringAt(row, ["payload", "call_id"]) ?? stringAt(row, ["payload", "id"])
    const name = stringAt(row, ["payload", "name"])
    if (!id || !name) return
    const input = parseInput(at(row, ["payload", "arguments"]) ?? at(row, ["payload", "input"]))
    if (input.command == null && input.cmd != null) input.command = input.cmd
    state.turn = stringAt(row, ["payload", "internal_chat_message_metadata_passthrough", "turn_id"]) ?? state.turn
    state.addCall(id, name, input, timestamp(row.timestamp))
  }
  if (type === "function_call_output" || type === "custom_tool_call_output") {
    const id = stringAt(row, ["payload", "call_id"])
    if (id) state.complete(id, timestamp(row.timestamp))
  }
}

function parseClaude(row, state) {
  state.session.id = typeof row.sessionId === "string" ? row.sessionId : state.session.id
  const time = timestamp(row.timestamp)
  const content = at(row, ["message", "content"])
  if (row.type === "user") {
    if (Array.isArray(content))
      for (const item of content)
        if (item.type === "tool_result" && item.tool_use_id) state.complete(item.tool_use_id, time)
    state.turn = row.promptId ?? row.uuid ?? state.turn
  }
  if (row.type !== "assistant" || !Array.isArray(content)) return
  for (const item of content)
    if (item.type === "tool_use" && item.id && item.name) state.addCall(item.id, item.name, object(item.input), time)
}

function parseOpenAI(row, state) {
  const time = timestamp(row.timestamp ?? row.created_at ?? row.createdAt)
  if (row.role === "user" && row.tool_call_id == null) state.turn = row.id ?? `turn-${state.sequence++}`
  if (row.role === "assistant" && Array.isArray(row.tool_calls)) {
    for (const item of row.tool_calls) {
      const fn = item.function ?? item
      if (item.id && fn.name) state.addCall(item.id, fn.name, parseInput(fn.arguments ?? fn.input), time)
    }
  }
  if (row.role === "tool" && row.tool_call_id) state.complete(row.tool_call_id, time)
}

function parsePi(row, state) {
  if (row.type === "session" && row.id) state.session.id = row.id
  if (row.type !== "message") return
  const message = row.message ?? {}
  const time = timestamp(message.timestamp ?? row.timestamp)
  if (message.role === "user") state.turn = row.id ?? state.turn
  if (!Array.isArray(message.content)) return
  for (const item of message.content) {
    if (
      (item.type === "toolCall" || item.type === "tool_use") &&
      (item.id ?? item.toolCallId) &&
      (item.name ?? item.toolName)
    ) {
      state.addCall(item.id ?? item.toolCallId, item.name ?? item.toolName, object(item.arguments ?? item.input), time)
    } else if (item.type === "toolResult" || item.type === "tool_result") {
      const id = item.toolCallId ?? item.tool_use_id
      if (id) state.complete(id, time)
    }
  }
}

function parseGrok(row, state) {
  if (typeof row.method === "string" && row.method.endsWith("session/update")) {
    state.session.id = at(row, ["params", "sessionId"]) ?? state.session.id
    const update = at(row, ["params", "update"])
    const id = update?.toolCallId ?? update?.tool_call_id
    if (!id) return
    const time = timestamp(row.timestamp)
    if (update.rawInput != null && !state.pending.has(id)) {
      const metaTool = at(update, ["_meta", "x.ai/tool"])
      const name =
        (typeof metaTool === "string" ? metaTool : metaTool?.name) ?? update.title ?? update.tool_name ?? "tool"
      state.addCall(id, name, object(update.rawInput), time)
    }
    if (["completed", "failed", "cancelled"].includes(String(update.status).toLowerCase())) state.complete(id, time)
    return
  }
  const time = timestamp(row.ts ?? row.timestamp)
  if (row.type === "turn_started")
    state.turn = `${row.session_id ?? state.session.id}:${row.turn_number ?? state.sequence}`
  if (row.type === "tool_started" && row.tool_name) {
    const id = `${row.tool_name}:${state.sequence++}`
    const queue = state.grokPending.get(row.tool_name) ?? { values: [], head: 0 }
    queue.values.push(id)
    state.grokPending.set(row.tool_name, queue)
    state.addCall(id, row.tool_name, {}, time)
  }
  if (row.type === "tool_completed" && row.tool_name) {
    const queue = state.grokPending.get(row.tool_name)
    if (!queue) return
    const id = queue.values[queue.head++]
    if (queue.head === queue.values.length) state.grokPending.delete(row.tool_name)
    if (id) state.complete(id, time)
  }
}

function parseGemini(row, state) {
  const time = timestamp(row.timestamp)
  if (row.type === "user") state.turn = row.id ?? state.turn
  if (row.type !== "gemini" || !Array.isArray(row.toolCalls)) return
  for (const item of row.toolCalls) {
    if (!item.name) continue
    const id = item.id ?? `${item.name}:${state.sequence++}`
    const started = timestamp(item.timestamp) ?? time
    state.addCall(id, item.name, object(item.args), started)
    const completed = timestamp(item.endTimestamp ?? item.endTime ?? item.completedAt ?? item.end_time)
    if (completed != null) state.complete(id, completed)
  }
}

function parseRow(harness, row, state) {
  if (harness === "codex") parseCodex(row, state)
  else if (harness === "claude") parseClaude(row, state)
  else if (harness === "grok") parseGrok(row, state)
  else if (harness === "pi") parsePi(row, state)
  else if (harness === "gemini") parseGemini(row, state)
  else parseOpenAI(row, state)
}

export async function parseJsonlFile(harness, file) {
  const state = new ParserState(harness, file)
  const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) continue
    try {
      parseRow(harness, JSON.parse(line), state)
    } catch {
      state.parseErrors++
    }
  }
  return { session: state.session, parseErrors: state.parseErrors }
}

export function parseJsonFile(harness, file) {
  const value = JSON.parse(readFileSync(file, "utf8"))
  const rows = Array.isArray(value) ? value : (value.messages ?? value.history ?? value.conversation ?? [])
  const state = new ParserState(harness, file)
  state.session.id = value.id ?? value.sessionId ?? state.session.id
  for (const row of rows) parseRow(harness, row, state)
  return { session: state.session, parseErrors: state.parseErrors }
}

export function parseOpenCodeDatabase(file) {
  const database = new DatabaseSync(file, { readOnly: true })
  try {
    const sessions = new Map(
      database
        .prepare("SELECT id FROM session")
        .all()
        .map(({ id }) => [id, { id: `${path.basename(file)}:${id}`, harness: "opencode", calls: [] }]),
    )
    for (const row of database
      .prepare("SELECT message_id, session_id, data FROM part ORDER BY time_created")
      .iterate()) {
      const session = sessions.get(row.session_id)
      if (!session) continue
      let value
      try {
        value = JSON.parse(row.data)
      } catch {
        continue
      }
      if (value.type !== "tool") continue
      const start = timestamp(at(value, ["state", "time", "start"]))
      const name = value.tool ?? "tool"
      const compact = compactInput(name, object(at(value, ["state", "input"])))
      session.calls.push({
        id: value.callID ?? value.id ?? "tool",
        name,
        start,
        end: timestamp(at(value, ["state", "time", "end"])),
        turn_id: row.message_id,
        classification: classifyToolCall({ name, input: compact }),
      })
    }
    return [...sessions.values()]
  } finally {
    database.close()
  }
}

export function parseCursorDatabase(file) {
  const database = new DatabaseSync(file, { readOnly: true })
  const state = new ParserState("cursor", file)
  try {
    for (const { data } of database.prepare("SELECT data FROM blobs WHERE substr(data, 1, 1) = x'7B'").iterate()) {
      try {
        parseOpenAI(JSON.parse(Buffer.from(data).toString("utf8")), state)
      } catch {}
    }
    return { session: state.session, parseErrors: state.parseErrors }
  } finally {
    database.close()
  }
}
