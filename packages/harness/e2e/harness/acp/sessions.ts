import { appendFileSync, existsSync, readFileSync } from "node:fs"
import path from "node:path"

const SESSIONS_FILE = "sessions"

export function rememberSession(dir: string, sessionId: string) {
  appendFileSync(path.join(dir, SESSIONS_FILE), `${sessionId}\n`)
}

export function knowsSession(dir: string, sessionId: string) {
  const file = path.join(dir, SESSIONS_FILE)
  return existsSync(file) && readFileSync(file, "utf8").split("\n").includes(sessionId)
}
