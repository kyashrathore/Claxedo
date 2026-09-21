import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import { promisify } from "node:util"
import { isRecord } from "@claxedo/helpers/guards"

const execFileAsync = promisify(execFile)

/**
 * `ps`, `sysctl` and PowerShell are all reachable from a wedged machine, and a
 * probe that never returns makes every signal wait on it. A timed-out probe is
 * an unknown identity, which refuses to signal — never an assumed exit.
 */
const PROBE_TIMEOUT_MS = 2_000

export type CreationIdentitySource = "darwin-ps" | "linux-procfs" | "win32-cim"

/**
 * What makes a pid answerable for a specific launch. `startSecond` has
 * one-second resolution on every platform reachable without a native addon, so
 * `bootTime` carries the rest: pids restart low after a reboot and the wrap
 * argument that makes a same-second collision impossible within one boot says
 * nothing across two.
 */
export type CreationIdentity = {
  pid: number
  processGroupId: number
  startSecond: string
  bootTime: string
  /**
   * Who the process answered to when it was read. Never compared during
   * verification: an orphan is reparented to init, and a PTY child's parent is
   * the library's own spawn helper rather than the runtime.
   */
  parentPid: number
  /**
   * `startSecond` as epoch milliseconds, floored to the second. It is how a
   * launcher rejects a pid that already existed before it called spawn; the
   * string remains the verification key, because it is what the platform
   * actually reports.
   */
  startedAtMs: number
  source: CreationIdentitySource
}

export type IdentityVerdict =
  | { state: "live"; identity: CreationIdentity }
  | { state: "exited" }
  | { state: "identity_mismatch"; observed: CreationIdentity }
  | { state: "unknown"; reason: string }

let bootTime: Promise<string> | undefined

export function readBootTime(): Promise<string> {
  bootTime ??= probeBootTime()
  return bootTime
}

async function probeBootTime(): Promise<string> {
  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync("sysctl", ["-n", "kern.boottime"], { timeout: PROBE_TIMEOUT_MS })
    const seconds = /sec\s*=\s*(\d+)/.exec(stdout)
    if (!seconds) throw new Error(`kern.boottime is not in the expected form: ${stdout.trim()}`)
    return seconds[1]!
  }
  if (process.platform === "linux") {
    const stat = await fs.readFile("/proc/stat", "utf8")
    const btime = /^btime\s+(\d+)$/m.exec(stat)
    if (!btime) throw new Error("/proc/stat carries no btime line")
    return btime[1]!
  }
  // Unverified: no Windows machine was available to this change. The CIM
  // datetime is local-time with an offset suffix, which is stable within one
  // boot and is compared only against itself.
  const { stdout } = await execFileAsync("powershell", [
    "-NoProfile", "-NonInteractive", "-Command",
    "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToString('o')",
  ], { timeout: PROBE_TIMEOUT_MS })
  const value = stdout.trim()
  if (!value) throw new Error("Win32_OperatingSystem reported no LastBootUpTime")
  return value
}

export async function readCreationIdentity(pid: number): Promise<CreationIdentity | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`readCreationIdentity needs a positive integer pid, got ${String(pid)}`)
  const boot = await readBootTime()
  if (process.platform === "linux") return readLinuxCreationIdentity(pid, boot)
  if (process.platform === "win32") return readWindowsCreationIdentity(pid, boot)
  return readDarwinCreationIdentity(pid, boot)
}

async function readDarwinCreationIdentity(pid: number, boot: string): Promise<CreationIdentity | undefined> {
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync("ps", ["-o", "pgid=,ppid=,lstart=", "-p", String(pid)], { timeout: PROBE_TIMEOUT_MS }))
  } catch (error) {
    // `ps` exits 1 for "no such process"; a probe this owner killed on its
    // timeout carries a signal instead, and that is not evidence of an exit.
    if (isRecord(error) && error.code === 1 && !error.killed) return undefined
    throw new Error(`Could not read creation identity for pid ${pid}: ${launchErrorText(error)}`, { cause: error })
  }
  const row = /^\s*(\d+)\s+(\d+)\s+(\S.*)$/.exec(stdout.trim())
  if (!row) return undefined
  const startSecond = row[3]!.trim()
  return {
    pid,
    processGroupId: Number(row[1]),
    parentPid: Number(row[2]),
    startSecond,
    startedAtMs: Date.parse(startSecond),
    bootTime: boot,
    source: "darwin-ps",
  }
}

/** Linux `starttime` is in USER_HZ, which is 100 on every architecture Node builds for. */
const LINUX_CLOCK_TICKS = 100

async function readLinuxCreationIdentity(pid: number, boot: string): Promise<CreationIdentity | undefined> {
  let stat: string
  try {
    stat = await fs.readFile(`/proc/${pid}/stat`, "utf8")
  } catch (error) {
    if (isRecord(error) && (error.code === "ENOENT" || error.code === "ESRCH")) return undefined
    throw new Error(`Could not read /proc/${pid}/stat: ${launchErrorText(error)}`, { cause: error })
  }
  // The comm field is parenthesised and may itself contain spaces and ')'.
  const tail = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)
  const parentPid = Number(tail[1])
  const processGroupId = Number(tail[2])
  const startTicks = Number(tail[19])
  if (!Number.isFinite(processGroupId) || !Number.isFinite(startTicks)) return undefined
  const secondsSinceBoot = Math.floor(startTicks / LINUX_CLOCK_TICKS)
  return {
    pid,
    processGroupId,
    parentPid,
    startSecond: String(secondsSinceBoot),
    startedAtMs: (Number(boot) + secondsSinceBoot) * 1000,
    bootTime: boot,
    source: "linux-procfs",
  }
}

/**
 * Unverified: no Windows machine was available to this change. Windows has no
 * process groups, so `processGroupId` repeats the pid and the group-leader
 * check in `retirement.ts` is satisfied vacuously; containment there is the
 * `taskkill /T` tree, not a group signal.
 */
async function readWindowsCreationIdentity(pid: number, boot: string): Promise<CreationIdentity | undefined> {
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync("powershell", [
      "-NoProfile", "-NonInteractive", "-Command",
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CreationDate.ToString('o') + ' ' + $p.ParentProcessId }`,
    ], { timeout: PROBE_TIMEOUT_MS }))
  } catch (error) {
    throw new Error(`Could not read creation identity for pid ${pid}: ${launchErrorText(error)}`, { cause: error })
  }
  const value = stdout.trim()
  if (!value) return undefined
  const split = value.lastIndexOf(" ")
  const startSecond = value.slice(0, split)
  return {
    pid,
    processGroupId: pid,
    parentPid: Number(value.slice(split + 1)),
    startSecond,
    startedAtMs: Date.parse(startSecond),
    bootTime: boot,
    source: "win32-cim",
  }
}

/**
 * Whether a recorded identity and one REPORTED by something else describe the
 * same launch — a daemon answering about itself over HTTP, a child over IPC.
 *
 * `parentPid` is excluded deliberately: an orphan is reparented to init, so
 * comparing it would call a live process a stranger. `startedAtMs` is included
 * because a reported identity is a value someone else computed, and a field a
 * record requires but never checks is a weaker guarantee than it advertises.
 * `verifyCreationIdentity` re-reads the process itself and derives that field
 * from `startSecond`, so it compares the four it actually observes.
 */
export function sameCreationIdentity(recorded: CreationIdentity, observed: CreationIdentity): boolean {
  return observed.pid === recorded.pid
    && observed.processGroupId === recorded.processGroupId
    && observed.startSecond === recorded.startSecond
    && observed.startedAtMs === recorded.startedAtMs
    && observed.bootTime === recorded.bootTime
}

export async function verifyCreationIdentity(recorded: CreationIdentity): Promise<IdentityVerdict> {
  let observed: CreationIdentity | undefined
  try {
    observed = await readCreationIdentity(recorded.pid)
  } catch (error) {
    return { state: "unknown", reason: launchErrorText(error) }
  }
  if (!observed) return { state: "exited" }
  if (
    observed.startSecond !== recorded.startSecond ||
    observed.processGroupId !== recorded.processGroupId ||
    observed.bootTime !== recorded.bootTime
  ) return { state: "identity_mismatch", observed }
  return { state: "live", identity: observed }
}

export function launchErrorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
