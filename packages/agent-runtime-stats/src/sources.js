import { readdirSync, statSync } from "node:fs"
import path from "node:path"

import { parseCursorDatabase, parseJsonFile, parseJsonlFile, parseOpenCodeDatabase } from "./parsers.js"

const definitions = {
  codex: {
    locations: [".codex/sessions", ".codex/archived_sessions"],
    kind: "jsonl",
    match: (file) => file.endsWith(".jsonl"),
  },
  claude: { locations: [".claude/projects"], kind: "jsonl", match: (file) => file.endsWith(".jsonl") },
  cursor: {
    locations: [".cursor/acp-sessions"],
    kind: "cursor-db",
    status: "partial",
    match: (file) => path.basename(file) === "store.db",
    note: "Cursor ACP tool records use proprietary protobuf; JSON messages are detected, but some tool calls may be unavailable.",
  },
  grok: { locations: [".grok/sessions"], kind: "jsonl", match: (file) => path.basename(file) === "updates.jsonl" },
  kimi: {
    locations: [".kimi/sessions"],
    kind: "jsonl",
    match: (file) => /^context(?:_sub_.*)?\.jsonl$/.test(path.basename(file)),
  },
  pi: { locations: [".pi/agent/sessions"], kind: "jsonl", match: (file) => file.endsWith(".jsonl") },
  gemini: {
    locations: [".gemini/tmp"],
    kind: "json",
    match: (file) => file.endsWith(".json") && file.split(path.sep).includes("chats"),
  },
  antigravity: {
    locations: [".gemini/antigravity-ide/conversations"],
    kind: "unsupported",
    status: "partial",
    match: (file) => file.endsWith(".pb"),
    note: "Detected only: local conversations are protobuf and no stable public schema is available.",
  },
  opencode: {
    locations: [".local/share/opencode"],
    kind: "opencode-db",
    match: (file) => /^opencode(?:-.*)?\.db$/.test(path.basename(file)),
  },
}

export const HARNESSES = Object.keys(definitions)

function filesUnder(root, match) {
  try {
    if (statSync(root).isFile()) return match(root) ? [root] : []
  } catch {
    return []
  }
  const files = []
  const pending = [root]
  while (pending.length) {
    const directory = pending.pop()
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) pending.push(file)
      else if (entry.isFile() && match(file)) files.push(file)
    }
  }
  return files.sort()
}

export function discoverSources(home, dataHome, selected, overrides = new Map()) {
  return selected.map((harness) => {
    const definition = definitions[harness]
    if (!definition) return { harness, kind: "unsupported", status: "unsupported", files: [], note: "Unknown harness." }
    let roots = overrides.get(harness)
    if (!roots)
      roots =
        harness === "opencode" && dataHome
          ? [path.join(dataHome, "opencode")]
          : definition.locations.map((location) => path.join(home, location))
    const files = [...new Set(roots.flatMap((root) => filesUnder(root, definition.match)))].sort()
    return {
      harness,
      kind: definition.kind,
      status: files.length ? (definition.status ?? "ready") : "not-found",
      files,
      note: definition.note,
    }
  })
}

export async function loadSessions(sources, onProgress = () => {}) {
  const sessions = []
  const errors = []
  const warnings = []
  let completed = 0
  for (const source of sources) {
    if (source.kind === "unsupported") continue
    for (const file of source.files) {
      onProgress({ completed, harness: source.harness })
      try {
        let parsed
        if (source.kind === "jsonl") parsed = [await parseJsonlFile(source.harness, file)]
        else if (source.kind === "json") parsed = [parseJsonFile(source.harness, file)]
        else if (source.kind === "cursor-db") parsed = [parseCursorDatabase(file)]
        else if (source.kind === "opencode-db") {
          parsed = parseOpenCodeDatabase(file).map((session) => ({ session, parseErrors: 0 }))
        } else throw new Error(`Unsupported source parser: ${source.kind}`)
        for (const item of parsed) {
          if (item.parseErrors)
            warnings.push({
              harness: source.harness,
              file,
              message: `${item.parseErrors} malformed JSONL lines skipped`,
            })
          sessions.push(item.session)
        }
      } catch (error) {
        errors.push({ harness: source.harness, file, message: error instanceof Error ? error.message : String(error) })
      } finally {
        onProgress({ completed: ++completed, harness: source.harness })
      }
    }
  }
  return { sessions: mergeSessions(sessions), errors, warnings }
}

function mergeSessions(sessions) {
  const merged = new Map()
  for (const session of sessions) {
    const id = `${session.harness}:${session.id}`
    const target = merged.get(id) ?? { id, harness: session.harness, calls: [] }
    target.calls.push(...session.calls)
    merged.set(id, target)
  }
  for (const session of merged.values()) {
    const seen = new Set()
    session.calls = session.calls.filter((call) => {
      const key = `${call.id}\0${call.start}\0${call.name}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
  return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id))
}
