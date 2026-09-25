import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const SESSIONS_FILE = "sessions"
const FORGET_ON_RESTART_FAULT = "forget-sessions-on-restart"

/** Per process on purpose: under the forget fault these are the only sessions a restarted agent can load, as an agent that keeps sessions in memory. */
const startedHere = new Set<string>()

export function forgetSessionsOnRestart(dir: string) {
  writeFileSync(path.join(dir, FORGET_ON_RESTART_FAULT), "forget")
}

export function rememberSession(dir: string, sessionId: string) {
  startedHere.add(sessionId)
  appendFileSync(path.join(dir, SESSIONS_FILE), `${sessionId}\n`)
}

export function knowsSession(dir: string, sessionId: string) {
  if (startedHere.has(sessionId)) return true
  if (existsSync(path.join(dir, FORGET_ON_RESTART_FAULT))) return false
  const file = path.join(dir, SESSIONS_FILE)
  return existsSync(file) && readFileSync(file, "utf8").split("\n").includes(sessionId)
}
