import { execFile, spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { sleep } from "@claxedo/helpers"
import { isRecord } from "@claxedo/helpers/guards"

const execFileAsync = promisify(execFile)

export type LaunchRole = "turn" | "harness" | "managed-process"

/**
 * `ps -o lstart=` is the only creation timestamp reachable without a native
 * addon on macOS: `sysctl kern.proc.pid.<pid>` is not exposed to the sysctl
 * CLI, and node has no binding for `proc_pidinfo`. Its resolution is one
 * second, so two processes created inside the same wall-clock second carry
 * identical `startedAt` strings.
 */
export type CreationIdentity = {
  pid: number
  processGroupId: number
  startedAt: string
  startedAtSource: "ps-lstart"
}

export type PreparedLaunch = {
  launchId: string
  role: LaunchRole
  preparedAt: string
}

export type LaunchRecord = PreparedLaunch & {
  identity?: CreationIdentity
  gateNonce?: string
  identityReceivedAt?: string
  activationAuthorizedAt?: string
  activationAcknowledgedAt?: string
}

export type IdentityVerdict =
  | { state: "live"; identity: CreationIdentity }
  | { state: "exited" }
  | { state: "identity-mismatch"; observed: CreationIdentity }

export type SignalOutcome =
  | { signalled: true; processGroupId: number }
  | { signalled: false; reason: "exited" | "identity-mismatch" | "not-group-leader" }

export type ExecutionReconciliation = {
  execution: "none" | "unknown" | "started"
  because: string
}

export type CleanupOutcome = {
  group: "exited" | "timeout" | "not-signalled"
  cleanup: "verified" | "unknown"
  reason: string
}

export const GATE_EXIT = {
  channelLostBeforeActivation: 20,
  activationDeadline: 21,
  nonceMismatch: 22,
  noParentChannel: 23,
  identityUnavailable: 24,
} as const

export async function readCreationIdentity(pid: number): Promise<CreationIdentity | null> {
  let stdout: string
  try {
    ({ stdout } = await execFileAsync("ps", ["-o", "pgid=,lstart=", "-p", String(pid)]))
  } catch (error) {
    if (isRecord(error) && error.code === 1) return null
    throw new Error(`Could not read creation identity for pid ${pid}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  const match = /^\s*(\d+)\s+(\S.*)$/.exec(stdout.trim())
  if (!match) return null
  return { pid, processGroupId: Number(match[1]), startedAt: match[2].trim(), startedAtSource: "ps-lstart" }
}

export async function verifyCreationIdentity(recorded: CreationIdentity): Promise<IdentityVerdict> {
  const observed = await readCreationIdentity(recorded.pid)
  if (!observed) return { state: "exited" }
  if (observed.startedAt !== recorded.startedAt || observed.processGroupId !== recorded.processGroupId) return { state: "identity-mismatch", observed }
  return { state: "live", identity: observed }
}

/**
 * Signalling is refused unless the recorded process is still the leader of the
 * group it was recorded with: `kill(-pgid)` reaches whoever holds that group
 * id now, so a group id alone is no safer than a bare pid.
 */
export async function signalOwnedGroup(recorded: CreationIdentity, signal: NodeJS.Signals): Promise<SignalOutcome> {
  if (recorded.processGroupId !== recorded.pid) return { signalled: false, reason: "not-group-leader" }
  const verdict = await verifyCreationIdentity(recorded)
  if (verdict.state === "exited") return { signalled: false, reason: "exited" }
  if (verdict.state === "identity-mismatch") return { signalled: false, reason: "identity-mismatch" }
  process.kill(-recorded.processGroupId, signal)
  return { signalled: true, processGroupId: recorded.processGroupId }
}

/**
 * A process group answers for the processes still inside it. A descendant that
 * called `setsid` has left, and macOS offers no enumeration that would find it,
 * so an empty group never proves the launch's whole tree is gone.
 */
export async function drainOwnedGroup(recorded: CreationIdentity, timeoutMs: number): Promise<CleanupOutcome> {
  const outcome = await signalOwnedGroup(recorded, "SIGTERM")
  if (!outcome.signalled) return { group: "not-signalled", cleanup: "unknown", reason: `group not signalled: ${outcome.reason}` }
  const started = Date.now()
  for (;;) {
    if (!(await groupHasMembers(recorded.processGroupId))) {
      return { group: "exited", cleanup: "unknown", reason: "descendant containment unavailable on this platform: a descendant that called setsid is outside the owned group and cannot be enumerated" }
    }
    if (Date.now() - started >= timeoutMs) {
      process.kill(-recorded.processGroupId, "SIGKILL")
      return { group: "timeout", cleanup: "unknown", reason: `owned group ${recorded.processGroupId} still had members after ${timeoutMs}ms` }
    }
    await sleep(10)
  }
}

async function groupHasMembers(processGroupId: number) {
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    if (isRecord(error) && error.code === "ESRCH") return false
    // Darwin's killpg counts permitted recipients after excluding zombies, so
    // an exiting group answers EPERM. That is not exit evidence.
    if (isRecord(error) && error.code === "EPERM") return true
    throw new Error(`Could not inspect owned group ${processGroupId}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

/**
 * The gate mints its own nonce and delivers it only over the private parent
 * channel, so activation requires having received that message. The payload
 * therefore cannot run before the parent held a recoverable identity, and an
 * environment or argv token never authorizes it.
 */
export function reconcileLaunch(record: LaunchRecord): ExecutionReconciliation {
  if (record.activationAcknowledgedAt) return { execution: "started", because: "gate acknowledged activation" }
  if (record.activationAuthorizedAt) return { execution: "unknown", because: "activation was authorized and its delivery is unwitnessed" }
  if (record.identityReceivedAt) return { execution: "none", because: "identity was received and activation was never authorized" }
  return { execution: "none", because: "no creation identity was ever received over the gate channel" }
}

export class LaunchOwnershipStore {
  constructor(private readonly file: string) {}

  async prepare(role: LaunchRole): Promise<PreparedLaunch> {
    const prepared: PreparedLaunch = { launchId: randomUUID(), role, preparedAt: new Date().toISOString() }
    await this.mutate((records) => { records[prepared.launchId] = prepared })
    return prepared
  }

  async recordIdentity(launchId: string, identity: CreationIdentity, gateNonce: string) {
    await this.mutate((records) => {
      const record = requirePreparedLaunch(records, launchId)
      record.identity = identity
      record.gateNonce = gateNonce
      record.identityReceivedAt = new Date().toISOString()
    })
  }

  async recordActivationAuthorized(launchId: string) {
    await this.mutate((records) => { requirePreparedLaunch(records, launchId).activationAuthorizedAt = new Date().toISOString() })
  }

  async recordActivationAcknowledged(launchId: string) {
    await this.mutate((records) => { requirePreparedLaunch(records, launchId).activationAcknowledgedAt = new Date().toISOString() })
  }

  async read(launchId: string): Promise<LaunchRecord> {
    return requirePreparedLaunch(await this.readAll(), launchId)
  }

  async readAll(): Promise<Record<string, LaunchRecord>> {
    let raw: string
    try {
      raw = await fs.readFile(this.file, "utf8")
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return {}
      throw error
    }
    return JSON.parse(raw) as Record<string, LaunchRecord>
  }

  private async mutate(change: (records: Record<string, LaunchRecord>) => void) {
    const records = await this.readAll()
    change(records)
    const staging = `${this.file}.${randomUUID()}`
    await fs.writeFile(staging, JSON.stringify(records), "utf8")
    await fs.rename(staging, this.file)
  }
}

function requirePreparedLaunch(records: Record<string, LaunchRecord>, launchId: string) {
  const record = records[launchId]
  if (!record) throw new Error(`No prepared launch ${launchId}`)
  return record
}

export type GatePayload = { command: string; args: string[] }

export type LaunchGateHandle = {
  child: ChildProcess
  /** Resolves when the gate reports its own creation identity, or rejects when the gate exits first. */
  reported: Promise<{ identity: CreationIdentity; gateNonce: string }>
  activate(gateNonce: string): void
  acknowledged: Promise<string>
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

export function spawnLaunchGate(request: { payload: GatePayload; activationDeadlineMs: number }): LaunchGateHandle {
  const gate = fileURLToPath(new URL("./launch-gate-child.ts", import.meta.url))
  const runner = process.versions.bun ? [gate] : ["--import", "tsx", gate]
  const child = spawn(process.execPath, [
    ...runner,
    "--activation-deadline-ms", String(request.activationDeadlineMs),
    "--payload", JSON.stringify(request.payload),
  ], {
    detached: true,
    // The gate outlives its parent by design; an inherited pipe would make the
    // first write after the parent's exit an unhandled EPIPE.
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    cwd: path.dirname(gate),
  })

  let onReported = (_: { identity: CreationIdentity; gateNonce: string }) => {}
  let failReported = (_: unknown) => {}
  const reported = new Promise<{ identity: CreationIdentity; gateNonce: string }>((resolve, reject) => { onReported = resolve; failReported = reject })
  let onAcknowledged = (_: string) => {}
  const acknowledged = new Promise<string>((resolve) => { onAcknowledged = resolve })

  child.on("message", (message) => {
    if (!isRecord(message)) return
    if (message.type === "identity") onReported({ identity: message.identity as CreationIdentity, gateNonce: String(message.gateNonce) })
    if (message.type === "activated") onAcknowledged(String(message.gateNonce))
  })

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => {
      failReported(new Error(`Launch gate exited with code ${code} signal ${signal} before reporting identity`))
      resolve({ code, signal })
    })
  })

  return {
    child,
    reported,
    acknowledged,
    exit,
    activate: (gateNonce: string) => { child.send({ type: "activate", gateNonce }) },
  }
}
