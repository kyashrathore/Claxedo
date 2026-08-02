import crypto from "crypto"
import fs from "fs/promises"
import path from "path"

// State and target-config files are read back on every lifecycle command and
// treated as the source of truth for what may be deleted, so a torn write must
// never be observable: write to a sibling temp file and rename into place.
export async function writeFileAtomic(file: string, data: string, mode = 0o644) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(6).toString("hex")}.tmp`)
  await fs.writeFile(tmp, data, { mode })
  try {
    await fs.rename(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
}

// Missing files are a normal empty state; anything else (EACCES, EIO, parse
// failures upstream) must surface instead of being read as "empty", because
// an "empty" read cascades into removing every other install's artifacts.
export async function readFileIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8")
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return undefined
    throw err
  }
}

// A crashed holder leaves the lock directory behind; treat locks older than
// this as stale and take them over instead of spinning forever.
const STATE_LOCK_STALE_MS = 10 * 60 * 1000

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

// Cross-process mutex over an .agent-extensions state root. Both runtime
// replay and the lifecycle commands (install/enable/disable/uninstall) do
// read-modify-write over installed.json/lock.json/materialized.json, so they
// must serialize against each other or interleaved runs lose updates.
// The dir name predates lifecycle locking and is kept for compatibility with
// concurrently running older processes.
export async function withAgentExtensionStateLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const lock = path.join(root, ".replay-lock")
  await fs.mkdir(root, { recursive: true, mode: 0o755 })
  while (true) {
    try {
      await fs.mkdir(lock, { mode: 0o755 })
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      const stat = await fs.stat(lock).catch(() => undefined)
      if (stat && Date.now() - stat.mtimeMs > STATE_LOCK_STALE_MS) {
        await fs.rm(lock, { recursive: true, force: true })
        continue
      }
      await wait(100)
    }
  }
  try {
    return await fn()
  } finally {
    await fs.rm(lock, { recursive: true, force: true })
  }
}
