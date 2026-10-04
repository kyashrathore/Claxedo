import fs from "fs"
import path from "path"
import { Worker } from "node:worker_threads"
import { machineFileIndex, isFileIndexIgnoredName } from "@claxedo/workspace-runtime/file-index"

export async function globSearch(
  searchDir: string,
  query: string,
  type: "file" | "directory" | "any",
  limit: number,
) {
  const q = query.trim().toLowerCase()
  if (limit < 1) return []

  const root = path.resolve(searchDir)
  if (type === "directory") return directorySearch(root, q, limit)
  const found = await machineFileIndex.get(root, { gitTimeoutMs: 1_500 })
  const paths = type === "file" ? found.files : found.all
  return paths.filter((item) => !q || item.toLowerCase().includes(q)).slice(0, limit)
}

const DIRECTORY_SEARCH_DEPTH = 3
const DIRECTORY_SEARCH_BUDGET = 400

// Folder pickers include empty directories. A file index cannot supply those,
// and indexing every file under a home directory exceeds the picker's budget.
async function directorySearch(root: string, q: string, limit: number) {
  const out: string[] = []
  const queue: Array<{ rel: string; depth: number }> = [{ rel: "", depth: 0 }]
  const depthLimit = q ? DIRECTORY_SEARCH_DEPTH : 1
  for (let head = 0; head < queue.length && head < DIRECTORY_SEARCH_BUDGET && out.length < limit; head += 1) {
    const { rel, depth } = queue[head]
    let rows: fs.Dirent[]
    try {
      rows = await fs.promises.readdir(rel ? path.join(root, rel) : root, { withFileTypes: true })
    } catch {
      continue
    }
    rows.sort((a, b) => a.name.localeCompare(b.name))
    for (const row of rows) {
      if (!row.isDirectory() || row.name.startsWith(".") || isFileIndexIgnoredName(row.name)) continue
      const next = rel ? `${rel}/${row.name}` : row.name
      if (!q || row.name.toLowerCase().includes(q)) {
        out.push(next)
        if (out.length >= limit) break
      }
      if (depth + 1 < depthLimit) queue.push({ rel: next, depth: depth + 1 })
    }
  }
  return out
}

// Text search budget. The engine backs `/find` with ripgrep; the compat layer
// has no ripgrep binary, so the pure-Node scan is bounded to keep a
// no-match pattern from reading an entire monorepo.
const GREP_MAX_FILES = 5_000
const GREP_MAX_FILE_BYTES = 1_000_000

export type GrepMatch = {
  path: { text: string }
  lines: { text: string }
  line_number: number
  absolute_offset: number
  submatches: { match: { text: string }; start: number; end: number }[]
}

// The caller-named pattern runs inside a one-off worker on a deadline: regex
// backtracking is synchronous, so no in-process cap or timer can interrupt a
// catastrophic pattern on the server thread — only `terminate()` can. Matches
// collected before the deadline stand, which the response contract already
// tolerates through `limit`. Same convention as the elicitation pattern
// evaluator in agent-runtime-contract. A burst of searches must not fan out into
// unbounded threads, so the worker count is capped as well.
const GREP_SCAN_TIMEOUT_MS = 2_000
const GREP_SCAN_MAX_WORKERS = 4

type GrepFileMatch = Omit<GrepMatch, "path">

// Serialized into the worker source below, so it must stay self-contained: no
// module-scope references, and untrusted input only ever arrives through `job`.
function grepScanFile(job: { pattern: string; text: string }): GrepFileMatch[] {
  const re = new RegExp(job.pattern, "g")
  const found: GrepFileMatch[] = []
  let offset = 0
  let lineNumber = 0
  for (const raw of job.text.split("\n")) {
    lineNumber++
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    const submatches = Array.from(line.matchAll(re)).map((hit) => ({
      match: { text: hit[0] },
      start: hit.index,
      end: hit.index + hit[0].length,
    }))
    if (submatches.length) {
      found.push({
        lines: { text: line },
        line_number: lineNumber,
        absolute_offset: offset,
        submatches,
      })
    }
    offset += Buffer.byteLength(raw, "utf-8") + 1
  }
  return found
}

const GREP_SCAN_SOURCE = `const {parentPort}=require('node:worker_threads');const scan=(${grepScanFile.toString()});parentPort.on('message',(job)=>{try{parentPort.postMessage({id:job.id,matches:scan(job)})}catch{parentPort.postMessage({id:job.id,matches:[]})}});`

let activeGrepScans = 0

// Mirrors the engine's `findText` handler (ripgrep.grep -> LegacyMatch), which
// caps results at 10 and reports 1-based line numbers with byte offsets.
export async function grepSearch(root: string, pattern: string, limit = 10): Promise<GrepMatch[]> {
  const out: GrepMatch[] = []
  if (!pattern.trim() || !root.trim() || limit < 1) return out
  try {
    new RegExp(pattern, "g")
  } catch {
    return out
  }
  const files = await machineFileIndex.list(root, { gitTimeoutMs: 1_500 })
  if (activeGrepScans >= GREP_SCAN_MAX_WORKERS) return out
  let worker: Worker
  try {
    worker = new Worker(GREP_SCAN_SOURCE, {
      eval: true,
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 2 },
    })
  } catch {
    return out
  }
  activeGrepScans += 1
  let alive = true
  const dead = new Promise<void>((resolve) => {
    worker.once("error", () => {
      alive = false
      resolve()
    })
    worker.once("exit", () => {
      alive = false
      resolve()
    })
  })
  const timer = setTimeout(() => {
    alive = false
    void worker.terminate()
  }, GREP_SCAN_TIMEOUT_MS)
  let scanned = 0
  let job = 0
  try {
    for (const rel of files) {
      if (out.length >= limit || scanned >= GREP_MAX_FILES || !alive) break
      const abs = path.join(root, rel)
      let buf: Buffer
      try {
        const stat = await fs.promises.stat(abs)
        if (!stat.isFile() || stat.size > GREP_MAX_FILE_BYTES) continue
        buf = await fs.promises.readFile(abs)
      } catch {
        continue
      }
      scanned++
      if (buf.includes(0)) continue
      let text: string
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buf)
      } catch {
        continue
      }
      const id = ++job
      const matches = await Promise.race([
        new Promise<GrepFileMatch[]>((resolve) => {
          const onReply = (reply: { id: number; matches: GrepFileMatch[] }) => {
            if (reply.id !== id) return
            worker.off("message", onReply)
            resolve(reply.matches)
          }
          worker.on("message", onReply)
          worker.postMessage({ id, pattern, text })
        }),
        dead.then(() => undefined),
      ])
      if (!matches || !alive) break
      for (const hit of matches) {
        out.push({ path: { text: rel }, ...hit })
        if (out.length >= limit) break
      }
    }
  } finally {
    clearTimeout(timer)
    activeGrepScans -= 1
    worker.removeAllListeners()
    await worker.terminate()
  }
  return out
}
