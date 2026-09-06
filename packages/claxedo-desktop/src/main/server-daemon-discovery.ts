import fs from "node:fs"
import path from "node:path"

import { asRecord, isNonEmptyString, readUnknown } from "../shared/json-read"
import { nodeErrorCode } from "../shared/node-error"

export const CLAXEDO_DAEMON_PROTOCOL = 1
export const CLAXEDO_DAEMON_SERVICE = "claxedo-local-daemon" as const

export type ClaxedoDaemonDiscovery = Readonly<{
  service: typeof CLAXEDO_DAEMON_SERVICE
  protocol: typeof CLAXEDO_DAEMON_PROTOCOL
  generation: string
  token: string
  pid: number
  port: number
  startedAt: string
}>

export function claxedoDaemonDiscoveryPath(dataRoot: string) {
  return path.join(dataRoot, "local-daemon.json")
}

export function readClaxedoDaemonDiscovery(file: string): ClaxedoDaemonDiscovery | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT" || error instanceof SyntaxError) return undefined
    throw error
  }
  return isClaxedoDaemonDiscovery(parsed) ? parsed : undefined
}

export function writeClaxedoDaemonDiscovery(file: string, record: ClaxedoDaemonDiscovery) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 })
    fs.renameSync(temporary, file)
    fs.chmodSync(file, 0o600)
  } finally {
    // Best effort, and deliberately silent: a throw here would replace the
    // write's own failure with a cleanup failure, and the caller would be told
    // the wrong thing about why the discovery file is not there.
    try {
      fs.unlinkSync(temporary)
    } catch {
      // The temp file is either already gone or not ours to remove.
    }
  }
}

export function clearClaxedoDaemonDiscovery(file: string, owner: ClaxedoDaemonDiscovery) {
  const current = readClaxedoDaemonDiscovery(file)
  if (!current || current.pid !== owner.pid || current.generation !== owner.generation || current.token !== owner.token) {
    return
  }
  try {
    fs.unlinkSync(file)
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw error
  }
}

export async function verifyClaxedoDaemonDiscovery(
  record: ClaxedoDaemonDiscovery,
  request: typeof fetch = fetch,
): Promise<string | undefined> {
  const url = `http://127.0.0.1:${String(record.port)}`
  try {
    const response = await request(`${url}/api/claxedo/daemon`, {
      headers: { authorization: `Bearer ${record.token}` },
      signal: AbortSignal.timeout(1_500),
    })
    if (!response.ok) return undefined
    const identity: unknown = await response.json()
    if (
      readUnknown(identity, "service") !== record.service ||
      readUnknown(identity, "protocol") !== record.protocol ||
      readUnknown(identity, "generation") !== record.generation ||
      readUnknown(identity, "pid") !== record.pid
    ) return undefined
    return url
  } catch {
    return undefined
  }
}

/**
 * A type predicate rather than a parse-and-cast: the checks below are exactly
 * the fields `ClaxedoDaemonDiscovery` declares, so stating them as the proof
 * removes the assertion the old `return record as …` needed.
 */
function isClaxedoDaemonDiscovery(value: unknown): value is ClaxedoDaemonDiscovery {
  const record = asRecord(value)
  return (
    !!record &&
    record.service === CLAXEDO_DAEMON_SERVICE &&
    record.protocol === CLAXEDO_DAEMON_PROTOCOL &&
    isNonEmptyString(record.generation) &&
    isNonEmptyString(record.token) &&
    typeof record.pid === "number" && Number.isSafeInteger(record.pid) && record.pid > 0 &&
    typeof record.port === "number" && Number.isSafeInteger(record.port) &&
    record.port > 0 && record.port <= 65535 &&
    isNonEmptyString(record.startedAt)
  )
}

