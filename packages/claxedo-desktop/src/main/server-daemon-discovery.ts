import fs from "node:fs"
import path from "node:path"

import { isCreationIdentity, sameCreationIdentity, type CreationIdentity } from "@claxedo/agent-sdk-runtime/launch"

import { asRecord, isNonEmptyString, readUnknown } from "../shared/json-read"
import { createDaemonFetch } from "./daemon-request"
import { nodeErrorCode } from "../shared/node-error"

/**
 * The management protocol both halves must agree on. It is 2 because a daemon
 * now publishes its OS creation identity and answers recovery operations: a
 * launcher built against 1 would read neither, and would fall back to killing a
 * pid it never identified.
 */
export const CLAXEDO_DAEMON_PROTOCOL = 2
export const DAEMON_PROTOCOL_HEADER = "x-claxedo-daemon-protocol"
export const CLAXEDO_DAEMON_SERVICE = "claxedo-local-daemon" as const

export type ClaxedoDaemonDiscovery = Readonly<{
  service: typeof CLAXEDO_DAEMON_SERVICE
  protocol: typeof CLAXEDO_DAEMON_PROTOCOL
  generation: string
  token: string
  pid: number
  port: number
  startedAt: string
  /**
   * What the daemon read about its own process. Absent when it could not read
   * one, which leaves a launcher with nothing to verify and therefore nothing
   * it may signal.
   */
  identity?: CreationIdentity
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

/**
 * The published token is both presentations at once: the capability the daemon
 * admits the application by, and the bearer its identity route authenticates.
 * They are separate headers so neither consumes the other, and this is the
 * first call that has to satisfy both.
 */
export async function verifyClaxedoDaemonDiscovery(
  record: ClaxedoDaemonDiscovery,
  request: typeof fetch = fetch,
): Promise<string | undefined> {
  const url = `http://127.0.0.1:${String(record.port)}`
  const daemon = createDaemonFetch({
    endpoint: () => ({ origin: url, capability: record.token }),
    fetch: request,
  })
  try {
    const response = await daemon("/api/claxedo/daemon", {
      headers: { authorization: `Bearer ${record.token}`, [DAEMON_PROTOCOL_HEADER]: String(CLAXEDO_DAEMON_PROTOCOL) },
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
    // The record's identity is what a later signal would be checked against, so
    // a listener that disagrees about its own process is not the daemon that
    // wrote the file, however well its token and generation match.
    if (record.identity && !reportsRecordedIdentity(record.identity, readUnknown(identity, "identity"))) return undefined
    return url
  } catch {
    return undefined
  }
}

/** Whether a listener's reported identity is the one the discovery file recorded. */
export function reportsRecordedIdentity(recorded: CreationIdentity, reported: unknown): boolean {
  return isCreationIdentity(reported) && sameCreationIdentity(recorded, reported)
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
    isNonEmptyString(record.startedAt) &&
    (record.identity === undefined || isCreationIdentity(record.identity))
  )
}
