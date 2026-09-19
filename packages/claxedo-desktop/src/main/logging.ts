import log from "electron-log/main.js"
import { openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs"
import { dirname, join } from "node:path"

const MAX_LOG_AGE_DAYS = 7
const TAIL_LINES = 1000
const SERVER_LOG_MAX_BYTES = 5 * 1024 * 1024
export const SERVER_LOG_NAME = "server.log"

export function initLogging() {
  log.transports.file.maxSize = 5 * 1024 * 1024
  cleanup()
  return log
}

/**
 * Opens the file the embedded server's stdout and stderr are appended to, in
 * the directory `main.log` lives in. One generation is kept: a file past
 * 5 MB is rolled to `server.old.log` before the new server starts writing.
 * The caller owns the descriptor and closes it once the child holds its copy.
 */
export function openServerLogFile(dir = dirname(log.transports.file.getFile().path)): { path: string; fd: number } {
  const path = join(dir, SERVER_LOG_NAME)
  try {
    if (statSync(path).size > SERVER_LOG_MAX_BYTES) renameSync(path, join(dir, "server.old.log"))
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined
    if (code !== "ENOENT") log.warn("server.log was not rolled; the new server appends to it", { error: String(error) })
  }
  return { path, fd: openSync(path, "a") }
}

export function tail(): string {
  try {
    const path = log.transports.file.getFile().path
    const contents = readFileSync(path, "utf8")
    const lines = contents.split("\n")
    return lines.slice(Math.max(0, lines.length - TAIL_LINES)).join("\n")
  } catch {
    return ""
  }
}

function cleanup() {
  const path = log.transports.file.getFile().path
  const dir = dirname(path)
  const cutoff = Date.now() - MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000

  for (const entry of readdirSync(dir)) {
    const file = join(dir, entry)
    try {
      const info = statSync(file)
      if (!info.isFile()) continue
      if (info.mtimeMs < cutoff) unlinkSync(file)
    } catch {
      continue
    }
  }
}
