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
 * anything exited: it is current only while the process that wrote it is.
 */

import fs from "node:fs"
import path from "node:path"
import { isMissingFile, writeFileAtomicSync } from "@claxedo/helpers/fs"
import {
  daemonOwnershipSnapshotPath,
  isDaemonOwnershipSnapshot,
} from "@claxedo/agent-runtime-contract"
import type { LocalDaemonOwner, MachineRecoveryGate, MachineRecoveryInspection } from "./local-daemon-lifecycle"

export type DaemonOwnershipSnapshot = {
  machineId: string
  generation: string
  pid: number
  revision: string
  changedAt: number
  residencyPins: number
  owners: LocalDaemonOwner[]
  gate?: MachineRecoveryGate
}

export const claxedoDaemonOwnershipPath = daemonOwnershipSnapshotPath

export function daemonOwnershipSnapshot(
  inspection: MachineRecoveryInspection,
  pid: number,
  changedAt: number,
): DaemonOwnershipSnapshot {
  return {
    machineId: inspection.machineId,
    generation: inspection.generation,
    pid,
    revision: inspection.scopeRevision,
    changedAt,
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
  writeFileAtomicSync(file, `${JSON.stringify(snapshot)}\n`)
}

export function clearDaemonOwnershipSnapshot(file: string, owner: { pid: number; generation: string }) {
  const current = readDaemonOwnershipSnapshot(file)
  if (!current || current.pid !== owner.pid || current.generation !== owner.generation) return
  try {
    fs.unlinkSync(file)
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
}

export function readDaemonOwnershipSnapshot(file: string): DaemonOwnershipSnapshot | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    if (isMissingFile(error) || error instanceof SyntaxError) return undefined
    throw error
  }
  return isLocalDaemonOwnershipSnapshot(parsed) ? parsed : undefined
}

const DAEMON_OWNER_KINDS: readonly LocalDaemonOwner["kind"][] = [
  "terminal", "turn", "workspace_runtime",
]

/**
 * The contract guard accepts any non-empty owner `kind`. This reader hands the
 * rows to code that decides per kind, so a snapshot naming one it has never
 * heard of is a snapshot this process cannot describe and is dropped whole
 * rather than typed into one of the four. `gate` stays unchecked: it is
 * optional, and a reader that finds nothing in it is already correct.
 */
function isLocalDaemonOwnershipSnapshot(value: unknown): value is DaemonOwnershipSnapshot {
  return isDaemonOwnershipSnapshot(value)
    && value.owners.every((owner) => DAEMON_OWNER_KINDS.some((kind) => kind === owner.kind))
}

/**
 * Writes the snapshot when publishing starts and on each `publish()`, which the
 * lifecycle's `onScopeChanged` calls. Nothing here runs on a timer, so an idle
 * daemon leaves the file untouched.
 */
export function createDaemonOwnershipPublisher(options: {
  file: string
  pid: number
  inspect: () => MachineRecoveryInspection
  now?: () => number
  onError?: (error: unknown) => void
}) {
  const now = options.now ?? Date.now
  let publishing = false

  function publish() {
    if (!publishing) return
    try {
      writeDaemonOwnershipSnapshot(options.file, daemonOwnershipSnapshot(options.inspect(), options.pid, now()))
    } catch (error) {
      options.onError?.(error)
    }
  }

  return {
    publish,
    start() {
      publishing = true
      publish()
    },
    stop() {
      publishing = false
    },
  }
}
