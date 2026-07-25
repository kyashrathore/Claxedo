import fs from "node:fs/promises"
import path from "node:path"
import { workspaceRuntimePtyHistoryDir } from "../env"
import { safeTrimStart } from "./safe-slice"

export function historyPath(directory: string, id: string, root = workspaceRuntimePtyHistoryDir()) {
  const key = Buffer.from(directory).toString("base64url")
  return path.join(root, key, `${id}.log`)
}

export async function renameHistory(
  directory: string,
  oldId: string,
  newId: string,
  root = workspaceRuntimePtyHistoryDir(),
) {
  const oldPath = historyPath(directory, oldId, root)
  const newPath = historyPath(directory, newId, root)
  await fs.mkdir(path.dirname(newPath), { recursive: true })
  await fs.rename(oldPath, newPath)
}

/**
 * Delete history files nothing will ever restore from.
 *
 * A file is only useful to a session that names its id via `previousPtyId`, and
 * that only happens on the next attach after a loss. Once a file is older than
 * `maxAgeMs` with no session having claimed it, nothing ever will — it is a
 * transcript of a terminal the user closed or abandoned days ago.
 *
 * Without this, buckets grow without bound: a single project directory was
 * observed holding 314 log files, several megabytes each.
 */
export async function cleanupOrphanedHistory(
  root = workspaceRuntimePtyHistoryDir(),
  maxAgeMs = 7 * 24 * 60 * 60 * 1000,
) {
  const now = Date.now()
  let removed = 0
  let dirs: string[]
  try {
    dirs = await fs.readdir(root)
  } catch {
    return { removed }
  }
  for (const dir of dirs) {
    const dirPath = path.join(root, dir)
    let stat
    try {
      stat = await fs.stat(dirPath)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    let files: string[]
    try {
      files = await fs.readdir(dirPath)
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith(".log")) continue
      const filePath = path.join(dirPath, file)
      try {
        const fstat = await fs.stat(filePath)
        if (now - fstat.mtimeMs > maxAgeMs) {
          await fs.rm(filePath, { force: true })
          removed += 1
        }
      } catch {}
    }
    // Deliberately NOT removing empty buckets. A session creates its bucket at
    // startup and writes the file ~8ms later on the first flush; a sweep landing
    // in that window would delete the directory out from under a LIVE terminal
    // and every subsequent append would fail with ENOENT. The race is inherent
    // — there is no atomic "remove if still empty" — and an empty directory
    // costs a few bytes, so the trade is not close. Caught by
    // `index.test.ts > remove closes subscribers, flushes history`.
  }
  return { removed }
}

/**
 * Append-only transcript of one PTY, on disk.
 *
 * ## Why nothing is mirrored in memory
 *
 * This used to keep the ENTIRE history — up to `limit`, default 16 MB — in a
 * `string[]` in RAM as well as on disk, so `snapshot()` could be synchronous.
 * Two call sites needed it: compaction, and the cold-restore seed. Both can
 * read the file, and both happen at most once per session lifetime.
 *
 * That mirror was the single largest per-terminal cost on the server: 16M code
 * units is 16–32 MB of heap depending on content, held for the life of every
 * open terminal, for data that was already durable on disk and almost never
 * read. Six terminals could hold ~200 MB of scrollback nobody was looking at.
 *
 * The live tail a running session serves (`Pty.snapshot`) comes from
 * `session.buffer`, which has its own separate 2 MB cap — so removing this
 * changed nothing about what a live client sees.
 */
export async function createDiskHistory(input: { directory: string; id: string; limit: number }) {
  const file = historyPath(input.directory, input.id)
  /** Approximate on-disk size. Only ever used to decide when to compact, so a
   *  code-unit/byte discrepancy on non-ASCII content is harmless. */
  let bytes = 0
  let staged = ""
  let timer: ReturnType<typeof setTimeout> | undefined
  let queue = Promise.resolve()

  /** Trim the FILE to its last `limit` on a safe boundary. */
  const compact = async () => {
    try {
      const existing = await fs.readFile(file, "utf8")
      if (existing.length <= input.limit) {
        bytes = existing.length
        return
      }
      // Cut on a safe boundary: a raw slice can leave the retained history
      // starting mid-escape, which xterm prints as literal junk on restore.
      const kept = safeTrimStart(existing, input.limit)
      await fs.writeFile(file, kept)
      bytes = kept.length
    } catch {}
  }

  const flush = () => {
    if (!staged) return queue
    const chunk = staged
    staged = ""
    queue = queue
      .then(() => fs.appendFile(file, chunk))
      .then(() => {
        bytes += chunk.length
        if (bytes <= input.limit) return
        return compact()
      })
      .catch(() => {})
    return queue
  }

  // Startup only stats the file — it is deliberately NOT read into memory.
  await fs
    .mkdir(path.dirname(file), { recursive: true })
    .then(() => fs.stat(file))
    .then((stat) => {
      bytes = stat.size
      if (bytes > input.limit) return compact()
    })
    .catch(() => {
      bytes = 0
    })

  return {
    append(data: string) {
      if (!data) return
      staged += data
      if (timer) return
      timer = setTimeout(() => {
        timer = undefined
        void flush()
      }, 8)
    },
    /**
     * The transcript tail, for seeding a replacement session. Async because the
     * history lives on disk; flushes anything staged first so a session that
     * dies immediately after output still restores it.
     */
    async snapshot(max = input.limit) {
      await flush()
      await queue
      const cap = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : input.limit
      if (cap <= 0) return ""
      try {
        const content = await fs.readFile(file, "utf8")
        return safeTrimStart(content, cap)
      } catch {
        return ""
      }
    },
    size() {
      return bytes
    },
    async close() {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      await flush()
      await queue
    },
    async clear() {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      staged = ""
      bytes = 0
      await queue
      await fs.rm(file, { force: true }).catch(() => {})
    },
  }
}
