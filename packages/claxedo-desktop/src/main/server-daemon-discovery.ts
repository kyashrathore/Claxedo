import fs from "node:fs"
import path from "node:path"

import { isCreationIdentity, sameCreationIdentity, type CreationIdentity } from "@claxedo/process-ownership/launch"

import { CLAXEDO_DAEMON_DISCOVERY_FILE, CLAXEDO_DAEMON_PROTOCOL, CLAXEDO_DAEMON_SERVICE, DAEMON_PROTOCOL_HEADER } from "@claxedo/helpers/claxedo-daemon"
import { isMissingFile, writeFileAtomicSync } from "@claxedo/helpers/fs"
import { asRecord, isNonEmptyString } from "@claxedo/helpers/guards"
import { readField } from "@claxedo/helpers/readers"
import { createDaemonFetch } from "./daemon-request"

export type ClaxedoDaemonDiscovery = Readonly<{
  service: typeof CLAXEDO_DAEMON_SERVICE
  protocol: typeof CLAXEDO_DAEMON_PROTOCOL
  generation: string
  token: string
  pid: number
  port: number
  startedAt: string
  /** The desktop version that started this daemon, which keeps serving that version's code until it exits. */
  build: string
  /**
   * What the daemon read about its own process. Absent when it could not read
   * one, which leaves a launcher with nothing to verify and therefore nothing
   * it may signal.
   */
  identity?: CreationIdentity
}>

export function claxedoDaemonDiscoveryPath(dataRoot: string) {
  return path.join(dataRoot, CLAXEDO_DAEMON_DISCOVERY_FILE)
}

/**
 * `unreadable`: a record is there that this build cannot read. Its daemon may
 * still be serving this data directory, so it is never taken as "no daemon".
 */
export function readClaxedoDaemonDiscovery(file: string): ClaxedoDaemonDiscovery | "unreadable" | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    if (isMissingFile(error)) return undefined
    if (error instanceof SyntaxError) return "unreadable"
    throw error
  }
  return isClaxedoDaemonDiscovery(parsed) ? parsed : "unreadable"
}

export function writeClaxedoDaemonDiscovery(file: string, record: ClaxedoDaemonDiscovery) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeFileAtomicSync(file, `${JSON.stringify(record)}\n`)
}

export function clearClaxedoDaemonDiscovery(file: string, owner: ClaxedoDaemonDiscovery) {
  const current = readClaxedoDaemonDiscovery(file)
  if (typeof current !== "object" || current.pid !== owner.pid || current.generation !== owner.generation || current.token !== owner.token) {
    return
  }
  try {
    fs.unlinkSync(file)
  } catch (error) {
    if (!isMissingFile(error)) throw error
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
      readField(identity, "service") !== record.service ||
      readField(identity, "protocol") !== record.protocol ||
      readField(identity, "generation") !== record.generation ||
      readField(identity, "pid") !== record.pid
    ) return undefined
    // The record's identity is what a later signal would be checked against, so
    // a listener that disagrees about its own process is not the daemon that
    // wrote the file, however well its token and generation match.
    if (record.identity && !reportsRecordedIdentity(record.identity, readField(identity, "identity"))) return undefined
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
    isNonEmptyString(record.build) &&
    (record.identity === undefined || isCreationIdentity(record.identity))
  )
}
