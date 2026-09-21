import fs from "node:fs/promises"
import path from "node:path"
import { verifyCreationIdentity, type CreationIdentity } from "@claxedo/agent-sdk-runtime/launch"
import { asRecordOrEmpty, isNonNegativeSafeInteger, nonEmptyString } from "@claxedo/helpers/guards"

/**
 * Whether the Claxedo desktop app's local daemon is running on this machine.
 *
 * The daemon publishes `local-daemon.json` in its data dir
 * (`claxedo-desktop/src/main/server-daemon-discovery.ts` writes it and owns
 * the shape) and answers `GET /api/claxedo/daemon` with the identity that
 * file names when shown the file's token. Only that answer counts as live: a
 * pid check would keep the guard up for as long as some other process holds
 * a crashed daemon's recycled pid, and under `RestartPreventExitStatus=78`
 * that is for ever. The desktop keeps one data dir per release channel
 * (`~/.claxedo`, `~/.claxedo-dev`, `~/.claxedo-beta`, or `CLAXEDO_DATA_DIR`
 * for any of them), so every one is probed.
 */

export type DesktopDaemonDiscovery = {
  pid: number
  port: number
  token: string
  generation: string
  protocol: number
  /** What the daemon recorded about its own process; absent when it read none. */
  identity?: CreationIdentity
}

/**
 * What a discovery file turned out to be.
 *
 * `absent` is the only one that means nothing owns this machine. The other
 * three each name a live owner this process must not compete with, and they are
 * kept apart because the operator action differs: an unresponsive daemon needs
 * recovery, an incompatible one needs both halves updated, and a live one is
 * simply already doing the job.
 */
export type DesktopDaemonState =
  | { state: "absent" }
  | { state: "live"; pid: number; port: number; file: string }
  | { state: "unresponsive"; pid: number; port: number; file: string }
  | { state: "incompatible"; pid: number; port: number; file: string; protocol: number }

/** The management protocol this build speaks; the desktop's own literal is its other half. */
export const CLAXEDO_DAEMON_PROTOCOL = 2
export const DAEMON_PROTOCOL_HEADER = "x-claxedo-daemon-protocol"

const DAEMON_SERVICE = "claxedo-local-daemon"
const DESKTOP_CHANNEL_DIRS = [".claxedo", ".claxedo-dev", ".claxedo-beta"]
const VERIFY_TIMEOUT_MS = 1_500

export function desktopDaemonDiscoveryFiles(env: NodeJS.ProcessEnv, homedir: string) {
  const configured = env.CLAXEDO_DATA_DIR?.trim()
  const dirs = [...(configured ? [configured] : []), ...DESKTOP_CHANNEL_DIRS.map((dir) => path.join(homedir, dir))]
  return [...new Set(dirs)].map((dir) => path.join(dir, "local-daemon.json"))
}

function integerBetween(value: unknown, min: number, max: number) {
  return isNonNegativeSafeInteger(value) && value >= min && value <= max ? value : undefined
}

export function parseDesktopDaemonDiscovery(text: string): DesktopDaemonDiscovery | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const record = asRecordOrEmpty(parsed)
  const pid = integerBetween(record.pid, 1, Number.MAX_SAFE_INTEGER)
  const port = integerBetween(record.port, 1, 65_535)
  const token = nonEmptyString(record.token)
  const generation = nonEmptyString(record.generation)
  const protocol = integerBetween(record.protocol, 1, Number.MAX_SAFE_INTEGER)
  if (record.service !== DAEMON_SERVICE || !pid || !port || !token || !generation || !protocol) return undefined
  const identity = creationIdentity(record.identity)
  return { pid, port, token, generation, protocol, ...(identity ? { identity } : {}) }
}

function creationIdentity(value: unknown): CreationIdentity | undefined {
  const row = asRecordOrEmpty(value)
  const pid = integerBetween(row.pid, 1, Number.MAX_SAFE_INTEGER)
  const processGroupId = integerBetween(row.processGroupId, 0, Number.MAX_SAFE_INTEGER)
  const parentPid = integerBetween(row.parentPid, 0, Number.MAX_SAFE_INTEGER)
  const startedAtMs = row.startedAtMs
  const startSecond = nonEmptyString(row.startSecond)
  const bootTime = nonEmptyString(row.bootTime)
  const source = nonEmptyString(row.source)
  if (pid === undefined || processGroupId === undefined || parentPid === undefined) return undefined
  if (typeof startedAtMs !== "number" || !Number.isFinite(startedAtMs)) return undefined
  if (!startSecond || !bootTime || !source) return undefined
  if (source !== "darwin-ps" && source !== "linux-procfs" && source !== "win32-cim") return undefined
  return { pid, processGroupId, parentPid, startSecond, startedAtMs, bootTime, source }
}

export type DesktopDaemonVerdict = "live" | "unresponsive"

/**
 * Whether the daemon the record names answers on its port as itself.
 *
 * A failed probe is `unresponsive`, never absence: the process may be wedged,
 * busy or mid-restart, and treating any of those as "nothing is there" is what
 * would let a second owner start over the same data directory.
 */
export async function verifyDesktopDaemon(
  record: DesktopDaemonDiscovery,
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopDaemonVerdict> {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${record.port}/api/claxedo/daemon`, {
      headers: {
        authorization: `Bearer ${record.token}`,
        [DAEMON_PROTOCOL_HEADER]: String(CLAXEDO_DAEMON_PROTOCOL),
      },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    })
    if (!response.ok) return "unresponsive"
    const identity = asRecordOrEmpty(await response.json())
    const answered = (
      identity.service === DAEMON_SERVICE &&
      identity.protocol === record.protocol &&
      identity.generation === record.generation &&
      identity.pid === record.pid &&
      // The listener must agree about its own process, not just its token and
      // generation: the identity it reports is what a later signal would be
      // checked against, and one that disagrees is not the daemon that wrote
      // the file this CLI is reading.
      sameReportedIdentity(record.identity, identity.identity)
    )
    return answered ? "live" : "unresponsive"
  } catch {
    return "unresponsive"
  }
}

/** The first discovery file that names an owner, and what that owner turned out to be. */
export async function desktopDaemonState(input: {
  files: readonly string[]
  readFile?: (file: string) => Promise<string | undefined>
  verify?: (record: DesktopDaemonDiscovery) => Promise<DesktopDaemonVerdict>
  /** Whether the process the record names is provably not the one that wrote it. */
  owner?: (record: DesktopDaemonDiscovery) => Promise<boolean>
}): Promise<DesktopDaemonState> {
  const read = input.readFile ?? ((file) => fs.readFile(file, "utf8").catch(() => undefined))
  const verify = input.verify ?? verifyDesktopDaemon
  for (const file of input.files) {
    const text = await read(file)
    if (text === undefined) continue
    const daemon = parseDesktopDaemonDiscovery(text)
    if (!daemon) continue
    // The version check comes first: an incompatible daemon cannot be asked
    // anything meaningful, and probing it would only produce an unresponsive
    // verdict that hides why.
    if (daemon.protocol !== CLAXEDO_DAEMON_PROTOCOL) {
      return { state: "incompatible", pid: daemon.pid, port: daemon.port, file, protocol: daemon.protocol }
    }
    const verdict = await verify(daemon)
    if (verdict === "live") return { state: "live", pid: daemon.pid, port: daemon.port, file }
    // A failed probe alone cannot tell a wedged daemon from a file its writer
    // never got to remove. The recorded creation identity can: a pid that has
    // exited, or that now answers for a different process, is a stale file and
    // nothing owns this machine. Without an identity to check, the file stands.
    if (await (input.owner ?? recordedOwnerIsGone)(daemon)) return { state: "absent" }
    return { state: "unresponsive", pid: daemon.pid, port: daemon.port, file }
  }
  return { state: "absent" }
}

async function recordedOwnerIsGone(record: DesktopDaemonDiscovery): Promise<boolean> {
  if (!record.identity) return false
  const verdict = await verifyCreationIdentity(record.identity)
  return verdict.state === "exited" || verdict.state === "identity_mismatch"
}

/**
 * A record with no identity has nothing to compare, which is not a mismatch:
 * the daemon could not read its own, and that is already what makes it
 * unrecoverable rather than what makes it unhealthy.
 */
function sameReportedIdentity(recorded: CreationIdentity | undefined, reported: unknown): boolean {
  if (!recorded) return true
  const observed = creationIdentity(reported)
  if (!observed) return false
  return observed.pid === recorded.pid
    && observed.processGroupId === recorded.processGroupId
    && observed.startSecond === recorded.startSecond
    && observed.startedAtMs === recorded.startedAtMs
    && observed.bootTime === recorded.bootTime
}
