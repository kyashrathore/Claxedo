import fs from "node:fs"
import path from "node:path"

type Observation = { kind: "http"; method: string; route: string; status: number; body: unknown }
  | { kind: "stream"; route: string; frames: unknown[] }

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function frameEntity(frame: unknown): string {
  const data = object(object(frame).data)
  const payload = object(data.payload)
  const properties = object(payload.properties)
  const typeValue = payload.type ?? data.type
  const type = typeof typeValue === "string" ? typeValue : "unknown"
  const nested = type === "message.part.updated" ? object(properties.part)
    : type === "message.updated" ? object(properties.info)
      : type === "subagent.updated" ? object(properties.update) : {}
  const identity = type.startsWith("message.part.") ? properties.partID ?? nested.id
    : type.startsWith("message.") || type === "session.usage" ? properties.messageID ?? nested.id
      : type.startsWith("permission.") || type.startsWith("question.") ? properties.requestID ?? properties.id
        : type === "subagent.updated" ? nested.childSessionId ?? nested.sessionID ?? nested.id
          : type.startsWith("goal.") ? object(properties.goal).id ?? properties.sessionID
          : type === "pty.created" ? object(payload.info).id
            : properties.sessionID ?? properties.sessionId ?? payload.sessionID ?? payload.sessionId
              ?? object(payload.start).sessionId ?? object(payload.info).id
  const kind = type.startsWith("message.part.") ? "part"
    : type.startsWith("message.") || type === "session.usage" ? "message"
      : type.startsWith("permission.") ? "permission"
        : type.startsWith("question.") ? "question"
          : type === "subagent.updated" ? "child"
            : type.startsWith("goal.") ? "goal"
              : type === "pty.created" ? "terminal" : "session"
  return `${kind}:${typeof identity === "string" || typeof identity === "number" ? String(identity) : "stream"}`
}

export function orderFramesByEntity(frames: unknown[]): Array<{ key: string; frames: unknown[] }> {
  const groups = new Map<string, unknown[]>()
  for (const frame of frames) {
    const key = frameEntity(frame)
    const group = groups.get(key) ?? []
    group.push(frame)
    groups.set(key, group)
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, frames]) => ({ key, frames }))
}

function faultedObservations(rows: Observation[]): Observation[] {
  const fault = process.env.CLAXEDO_E2E_CORPUS_FAULT
  if (fault !== "same-key-reorder" && fault !== "cross-key-swap") return rows
  const altered = structuredClone(rows)
  for (const row of altered) {
    if (row.kind !== "stream") continue
    for (let first = 0; first < row.frames.length; first++) {
      for (let second = first + 1; second < row.frames.length; second++) {
        const same = frameEntity(row.frames[first]) === frameEntity(row.frames[second])
        if (same !== (fault === "same-key-reorder")) continue
        ;[row.frames[first], row.frames[second]] = [row.frames[second], row.frames[first]]
        return altered
      }
    }
  }
  throw new Error(`No frame pair for ${fault}`)
}

export function comparisonShape(rows: Observation[]) {
  const ids = new Map<string, string>()
  const specials = new Map<string, string>()
  const http = rows.map((row) => {
    if (row.kind !== "http") return undefined
    if (flow === "H35.intermediate-release" && row.method === "GET" && /^\/session\/[^/]+$/.test(row.route.split("?")[0] ?? "")) {
      return normalize({ ...row, body: { id: object(row.body).id } }, ids, specials)
    }
    if (row.method === "GET" && row.route.startsWith("/api/claxedo/usage")) {
      const source = object(row.body)
      const breakdown = object(source.breakdown)
      const body: Record<string, unknown> = { claxedo: source.claxedo }
      if (Array.isArray(breakdown.rows)) {
        body.breakdown = { rows: [...breakdown.rows].sort((a, b) => {
          const aKey = String(normalize(object(a).value, new Map(ids), new Map(specials)))
          const bKey = String(normalize(object(b).value, new Map(ids), new Map(specials)))
          return aKey.localeCompare(bKey)
        }) }
      }
      return normalize({ ...row, body }, ids, specials)
    }
    return normalize(row, ids, specials)
  })
  return rows.map((row, index) => {
    if (row.kind === "http") return http[index]
    const frames = row.frames.filter((frame) => {
      const data = object(object(frame).data)
      return data.type !== "heartbeat" || "payload" in data
    }).map((frame) => {
      const { id: _id, event: _event, ...comparable } = object(frame)
      return comparable
    })
    const groups = orderFramesByEntity(frames).sort((a, b) => {
      const aKey = String(normalize(a.key, new Map(ids), new Map(specials)))
      const bKey = String(normalize(b.key, new Map(ids), new Map(specials)))
      return aKey.localeCompare(bKey)
    })
    const entities = groups.map((group) => ({
      key: normalize(group.key, ids, specials),
      frames: group.frames.map((frame) => normalize(frame, ids, specials)),
    })).sort((a, b) => String(a.key).localeCompare(String(b.key)))
    return { kind: row.kind, route: normalize(row.route, ids, specials), entities }
  })
}

const mode = process.env.CLAXEDO_E2E_CORPUS
if (mode && mode !== "record" && mode !== "compare") throw new Error(`Unknown corpus mode: ${mode}`)
if (mode && process.argv.length !== 3) throw new Error("Corpus mode needs exactly one flow selector")
if (mode && process.argv[1]?.endsWith("/flows/run.ts")) throw new Error("Use e2e/harness/run-corpus-flow.ts for one named corpus flow")
const flow = process.argv[2]
const file = flow && path.resolve(import.meta.dirname, "../corpus", `${flow}.json`)
const observations: Observation[] = []
let active = false

function parsed(body: string): unknown {
  if (!body) return null
  try { return JSON.parse(body) as unknown } catch { return body }
}

function special(specials: Map<string, string>, kind: string, value: string) {
  const key = `${kind}:${value}`
  let mapped = specials.get(key)
  if (!mapped) {
    const count = [...specials.keys()].filter((item) => item.startsWith(`${kind}:`)).length + 1
    mapped = `<${kind}:${count}>`
    specials.set(key, mapped)
  }
  return mapped
}

function normalize(value: unknown, ids: Map<string, string>, specials: Map<string, string>, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => normalize(item, ids, specials, key))
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, normalize(item, ids, specials, name)]))
  }
  if (typeof value === "number" && (Math.abs(value) >= 100_000_000_000 || /(?:^ts$|^time$|^created$|^updated$|^archived$|^start$|^end$|at$|time$|timestamp|duration|elapsed|since|until)/i.test(key))) return "<time>"
  if (typeof value === "number" && key === "port") return "<port>"
  if (typeof value === "number" && key === "pid") return special(specials, "pid", String(value))
  if (typeof value !== "string") return value
  if (/^(?:state|phase)$/i.test(key)) return value
  if (/(?:^ts$|^time$|^created$|^updated$|^archived$|at$|time$|timestamp|duration|elapsed|since|until)/i.test(key)) return "<time>"
  if (key === "title" && /^Terminal [a-f0-9]{4}$/i.test(value)) return special(specials, "terminal-title", value)
  if ((key === "processId" || key === "pid") && /^\d+$/.test(value)) return special(specials, "pid", value)
  if ((key === "process_key" || key === "processKey") && /^[a-z][a-z0-9-]*:[a-f0-9]{32,}$/i.test(value)) {
    let mapped = ids.get(value)
    if (!mapped) { mapped = `<process:${ids.size + 1}>`; ids.set(value, mapped) }
    return mapped
  }
  if (/^(?:repoName|repo|name|workspaceName)$/.test(key) && /-[a-zA-Z0-9]{6}$/.test(value)) {
    let mapped = ids.get(value)
    if (!mapped) { mapped = `<repo:${ids.size + 1}>`; ids.set(value, mapped) }
    return mapped
  }
  let result = value.includes("%2F") ? decodeURIComponent(value) : value
  result = result.replace(/(?:\/private)?\/var\/folders\/[^/]+\/[^/]+\/T\/claxedo-e2e-[^/\s"?]+|\/tmp\/claxedo-e2e-[^/\s"?]+/g, "<data-dir>")
  result = result.replace(/<data-dir>\/workspaces\/[^/\s"?]+/g, (directory) => {
    let mapped = ids.get(directory)
    if (!mapped) { mapped = `<workspace:${ids.size + 1}>`; ids.set(directory, mapped) }
    return mapped
  })
  result = result.replace(/-private-var-folders-[^/]+/g, (directory) => special(specials, "encoded-workspace", directory))
  result = result.replace(/([?&](?:since|until)=)\d+/g, "$1<time>")
  result = result.replace(/(?:127\.0\.0\.1|localhost):\d+/g, "localhost:<port>")
  result = result.replace(/\/tmp\/cc-socks\/\d+\.sock/g, (socket) => special(specials, "socket", socket))
  result = result.replace(/\bpid (\d+)\b/g, (_match, pid: string) => `pid ${special(specials, "pid", pid)}`)
  result = result.replace(/-p (\d+)\b/g, (_match, pid: string) => `-p ${special(specials, "pid", pid)}`)
  result = result.replace(/subagent_[a-zA-Z0-9_-]+/g, (id) => special(specials, "subagent", id))
  result = result.replace(/subagent-[a-f0-9]{8}/gi, (id) => special(specials, "subagent", id))
  result = result.replace(/pty_[a-zA-Z0-9_-]+/g, (id) => special(specials, "pty", id))
  result = result.replace(/\b1[7-9]\d{11}\b/g, (timestamp) => special(specials, "time-id", timestamp))
  result = result.replace(/(goal\.updated:.*:)(1[7-9]\d{8,11})$/, (_match, prefix: string, timestamp: string) =>
    `${prefix}${special(specials, "time-id", timestamp)}`)
  result = result.replace(/(?:ses|msg|prt|per|que|op|turn|tool|call|req|workspace|project|goal)_[a-zA-Z0-9_-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (id) => {
    let mapped = ids.get(id)
    if (!mapped) { mapped = `<id:${ids.size + 1}>`; ids.set(id, mapped) }
    return mapped
  })
  if (/(?:^id$|id$)/i.test(key) && result === value && (/^[a-f0-9]{12,}$/i.test(value) || (value.length >= 18 && /[A-Z]/.test(value) && /\d/.test(value))) && !/\s|\//.test(value)) {
    let mapped = ids.get(value)
    if (!mapped) { mapped = `<id:${ids.size + 1}>`; ids.set(value, mapped) }
    return mapped
  }
  return result
}

export function normalizeWireCorpus(value: unknown): unknown {
  return normalize(value, new Map(), new Map())
}

export function difference(expected: unknown, actual: unknown, location = "$"): string | undefined {
  if (Object.is(expected, actual)) return undefined
  if (expected && actual && typeof expected === "object" && typeof actual === "object") {
    const before = expected as Record<string, unknown>
    const after = actual as Record<string, unknown>
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    for (const key of keys) {
      if (!(key in before)) return `${location}.${key}: unexpected ${JSON.stringify(after[key])}`
      if (!(key in after)) return `${location}.${key}: missing ${JSON.stringify(before[key])}`
      const nested = difference(before[key], after[key], `${location}.${key}`)
      if (nested) return nested
    }
    return undefined
  }
  return `${location}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`
}

export function activateCorpus() {
  if (mode) active = true
}

export function observeStream(url: URL) {
  if (!mode) return undefined
  active = true
  const row: Observation & { kind: "stream" } = { kind: "stream", route: `${url.pathname}${url.search}`, frames: [] }
  observations.push(row)
  return (frame: unknown) => {
    if (process.env.CLAXEDO_E2E_CORPUS_FAULT === "rename-frame-field" && frame && typeof frame === "object") {
      const original = frame as Record<string, unknown>
      const { data, ...rest } = original
      row.frames.push({ ...rest, renamedData: data })
    } else row.frames.push(frame)
  }
}

if (mode) {
  const nativeFetch = globalThis.fetch
  const observedFetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const target = new URL(input instanceof Request ? input.url : String(input))
    const method = init?.method ?? (input instanceof Request ? input.method : "GET")
    const accept = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("accept")
    const unsynchronizedReadback = method === "GET" && (
      (flow === "H7.unknown-held" && /^\/session\/[^/]+\/queue$/.test(target.pathname))
      || (flow !== "H0-smoke" && target.pathname === "/api/claxedo/health")
    )
    const capture = active && !unsynchronizedReadback && (target.hostname === "127.0.0.1" || target.hostname === "localhost") && accept !== "text/event-stream"
    const reply = await nativeFetch(input, init)
    if (capture && !reply.headers.get("content-type")?.includes("text/event-stream")) {
      observations.push({ kind: "http", method, route: `${target.pathname}${target.search}`, status: reply.status, body: parsed(await reply.clone().text()) })
    }
    return reply
  }
  globalThis.fetch = Object.assign(observedFetch, { preconnect: nativeFetch.preconnect }) as typeof fetch
}

if (mode) process.on("exit", (code) => {
  if (code !== 0) return
  if (!file) throw new Error("Corpus flow selector is missing")
  const current = { flow, observations: comparisonShape(faultedObservations(observations)) }
  if (mode === "record") {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(current)}\n`)
    console.log(`Recorded wire corpus ${file}`)
    return
  }
  const expected = JSON.parse(fs.readFileSync(file, "utf8")) as unknown
  const diff = difference(expected, current)
  if (diff && process.env.CLAXEDO_E2E_CORPUS_ACTUAL) {
    fs.writeFileSync(process.env.CLAXEDO_E2E_CORPUS_ACTUAL, `${JSON.stringify(current, null, 2)}\n`)
  }
  if (diff) { console.error(`Wire corpus mismatch for ${flow}: ${diff}`); process.exitCode = 1 }
  else console.log(`Wire corpus matched ${flow}`)
})
