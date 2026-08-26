import fs from "node:fs/promises"
import path from "node:path"
import { workspaceRuntimePtyHistoryDir } from "../env"
import { safeTrimStartUtf8 } from "./safe-slice"

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
 * Two responsibilities needed it: bounded compaction and cold-restore seeding.
 * Both can read the authoritative file only when their lifecycle requires it.
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
  // `limit` is a hard UTF-8 on-disk cap. Compact to a lower watermark
  // BEFORE an append would cross it; retaining less than the maximum buys many
  // flushes before the next rewrite without ever leaving a crash-persistent 2x
  // file behind.
  const limit = Number.isFinite(input.limit) ? Math.max(0, Math.floor(input.limit)) : 0
  const lowWatermark = Math.floor(limit / 2)
  let bytes = 0
  let staged = ""
  let timer: ReturnType<typeof setTimeout> | undefined
  let queue = Promise.resolve()

  /** Trim the file to at most `keepBytes`, preserving its exact safe UTF-8 tail. */
  const compact = async (keepBytes: number): Promise<boolean> => {
    try {
      const existing = await fs.readFile(file, "utf8")
      const existingBytes = Buffer.byteLength(existing, "utf8")
      if (existingBytes <= keepBytes) {
        bytes = existingBytes
        return true
      }
      const kept = safeTrimStartUtf8(existing, keepBytes)
      await fs.writeFile(file, kept)
      bytes = Buffer.byteLength(kept, "utf8")
      return true
    } catch {
      return false
    }
  }

  const flush = () => {
    if (!staged) return queue
    let chunk = Buffer.from(staged, "utf8").toString("utf8")
    staged = ""
    queue = queue
      .then(async () => {
        let chunkBytes = Buffer.byteLength(chunk, "utf8")
        if (chunkBytes > limit) {
          chunk = safeTrimStartUtf8(chunk, limit)
          chunkBytes = Buffer.byteLength(chunk, "utf8")
        }
        if (bytes + chunkBytes > limit) {
          const existingBudget = Math.max(0, Math.min(lowWatermark, limit - chunkBytes))
          // If compaction fails, preserve the already-durable capped file rather
          // than appending past the contract. A later flush can retry.
          if (!(await compact(existingBudget))) return
        }
        if (!chunk) return
        await fs.appendFile(file, chunk)
        bytes += chunkBytes
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
      if (bytes > limit) return compact(limit)
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
    async snapshot(max = limit) {
      await flush()
      await queue
      const cap = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : limit
      if (cap <= 0) return ""
      try {
        const content = await fs.readFile(file, "utf8")
        return safeTrimStartUtf8(content, cap)
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
    clear() {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      staged = ""
      // Install removal into the same queue synchronously. An append issued
      // immediately after clear() therefore chains its flush after the remove,
      // instead of being deleted by a fire-and-forget clear racing behind it.
      queue = queue
        .then(() => fs.rm(file, { force: true }))
        .then(() => {
          bytes = 0
        })
        .catch(() => {})
      return queue
    },
  }
}
