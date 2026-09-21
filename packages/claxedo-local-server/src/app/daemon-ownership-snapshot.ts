/**
 * A redacted view of what this daemon owns, published beside its discovery
 * record.
 *
 * It exists for the one reader that cannot ask: a launcher whose daemon stopped
 * answering HTTP. That reader must not open the daemon's live SQLite, so the
 * inventory is republished as a small file instead. It carries ids, states,
 * generations and timestamps — never a command line, an argument or a token —
 * because a diagnostics view is not a place to widen what a file on disk
 * exposes.
 *
 * It is informational. It is not authorization, and it is not evidence that
 * anything exited: a snapshot is only ever as true as its `writtenAt`.
 */

import fs from "node:fs"
import path from "node:path"
import {
  DAEMON_OWNERSHIP_SNAPSHOT_FILE,
  DAEMON_OWNERSHIP_SNAPSHOT_STALE_MS,
} from "@claxedo/agent-runtime-contract"
import type { LocalDaemonOwner, MachineRecoveryGate, MachineRecoveryInspection } from "./local-daemon-lifecycle"

export { DAEMON_OWNERSHIP_SNAPSHOT_STALE_MS }
const PUBLISH_INTERVAL_MS = 5_000

export type DaemonOwnershipSnapshot = {
  machineId: string
  generation: string
  pid: number
  revision: string
  writtenAt: number
  residencyPins: number
  owners: LocalDaemonOwner[]
  gate?: MachineRecoveryGate
}

export function claxedoDaemonOwnershipPath(dataRoot: string) {
  return path.join(dataRoot, DAEMON_OWNERSHIP_SNAPSHOT_FILE)
}

export function daemonOwnershipSnapshot(
  inspection: MachineRecoveryInspection,
  pid: number,
  writtenAt: number,
): DaemonOwnershipSnapshot {
  return {
    machineId: inspection.machineId,
    generation: inspection.generation,
    pid,
    revision: inspection.scopeRevision,
    writtenAt,
    residencyPins: inspection.residencyPins,
    owners: inspection.owners.map((owner) => ({
      id: owner.id,
      kind: owner.kind,
      generation: owner.generation,
      state: owner.state,
      pins: owner.pins,
      ...(owner.detail ? { detail: owner.detail } : {}),
    })),
    ...(inspection.gate ? { gate: inspection.gate } : {}),
  }
}

export function writeDaemonOwnershipSnapshot(file: string, snapshot: DaemonOwnershipSnapshot) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 })
    fs.renameSync(temporary, file)
    fs.chmodSync(file, 0o600)
  } finally {
    try {
      fs.unlinkSync(temporary)
    } catch {
      // Either the rename already moved it or it is not ours to remove; the
      // write's own failure is what the caller needs to hear about.
    }
  }
}

export function clearDaemonOwnershipSnapshot(file: string, owner: { pid: number; generation: string }) {
  const current = readDaemonOwnershipSnapshot(file)
  if (!current || current.pid !== owner.pid || current.generation !== owner.generation) return
  try {
    fs.unlinkSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

export function readDaemonOwnershipSnapshot(file: string): DaemonOwnershipSnapshot | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined
    throw error
  }
  return isDaemonOwnershipSnapshot(parsed) ? parsed : undefined
}

export function daemonOwnershipSnapshotIsStale(snapshot: DaemonOwnershipSnapshot, at: number) {
  return at - snapshot.writtenAt > DAEMON_OWNERSHIP_SNAPSHOT_STALE_MS
}

/**
 * Republishes on every owner or scope transition, and no more than once every
 * five seconds while work is active. The revision is the transition test, so a
 * daemon whose inventory is unchanged writes nothing at all.
 */
export function createDaemonOwnershipPublisher(options: {
  file: string
  pid: number
  inspect: () => MachineRecoveryInspection
  now?: () => number
  onError?: (error: unknown) => void
}) {
  const now = options.now ?? Date.now
  let lastRevision: string | undefined
  let lastWriteAt = 0
  let timer: ReturnType<typeof setInterval> | undefined

  function publish(force = false) {
    const at = now()
    const inspection = options.inspect()
    const revision = `${inspection.scopeRevision}:${inspection.gate?.operationId ?? ""}`
    const transition = revision !== lastRevision
    if (!force && !transition && at - lastWriteAt < PUBLISH_INTERVAL_MS) return
    if (!transition && inspection.residencyPins === 0 && !force) return
    try {
      writeDaemonOwnershipSnapshot(options.file, daemonOwnershipSnapshot(inspection, options.pid, at))
      lastRevision = revision
      lastWriteAt = at
    } catch (error) {
      options.onError?.(error)
    }
  }

  return {
    publish,
    start() {
      timer ??= setInterval(() => publish(), PUBLISH_INTERVAL_MS)
      timer.unref?.()
      publish(true)
    },
    stop() {
      if (!timer) return
      clearInterval(timer)
      timer = undefined
    },
  }
}

function isDaemonOwnershipSnapshot(value: unknown): value is DaemonOwnershipSnapshot {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.machineId === "string" && record.machineId.length > 0
    && typeof record.generation === "string" && record.generation.length > 0
    && typeof record.pid === "number" && Number.isSafeInteger(record.pid) && record.pid > 0
    && typeof record.revision === "string" && record.revision.length > 0
    && typeof record.writtenAt === "number" && Number.isFinite(record.writtenAt)
    && typeof record.residencyPins === "number" && Number.isFinite(record.residencyPins)
    && Array.isArray(record.owners)
    && record.owners.every((owner) => {
      if (typeof owner !== "object" || owner === null) return false
      const row = owner as Record<string, unknown>
      return typeof row.id === "string" && typeof row.kind === "string"
        && typeof row.generation === "string" && typeof row.state === "string"
        && typeof row.pins === "boolean"
    })
  )
}
