import { asRecord } from "./values"
import { isNonEmptyString } from "@claxedo/helpers/guards"

/**
 * The redacted ownership view a machine owner republishes beside its discovery
 * record, and the age past which a reader must treat it as stale.
 *
 * Both halves live here because the writer and the reader are in different
 * products with a boundary between them: the launcher that reads this file
 * cannot import the daemon that writes it, and a filename agreed twice is a
 * filename that drifts once.
 */
export const DAEMON_OWNERSHIP_SNAPSHOT_FILE = "local-daemon-ownership.json"

export const DAEMON_OWNERSHIP_SNAPSHOT_STALE_MS = 10_000

/** Readers and writers must resolve the same file even when their data roots have trailing separators. */
export function daemonOwnershipSnapshotPath(dataRoot: string): string {
  return `${dataRoot.replace(/[/\\]+$/, "")}/${DAEMON_OWNERSHIP_SNAPSHOT_FILE}`
}

/** One owner row as the snapshot carries it: ids, states and generations, never a command. */
export type DaemonOwnershipRow = {
  id: string
  kind: string
  generation: string
  state: string
  pins: boolean
  detail?: string
}

/**
 * What a launcher may rely on in a snapshot it did not write.
 *
 * Both sides validate through this rather than each declaring the shape: the
 * writer is a daemon and the reader is the launcher that cannot import it, so
 * two declarations would be two chances to drift.
 */
export function isDaemonOwnershipSnapshot(value: unknown): value is {
  machineId: string
  generation: string
  pid: number
  revision: string
  writtenAt: number
  residencyPins: number
  owners: DaemonOwnershipRow[]
} {
  const row = asRecord(value)
  return (
    !!row
    && isNonEmptyString(row.machineId) && isNonEmptyString(row.generation) && isNonEmptyString(row.revision)
    && typeof row.pid === "number" && Number.isSafeInteger(row.pid) && row.pid > 0
    && typeof row.writtenAt === "number" && Number.isFinite(row.writtenAt)
    && typeof row.residencyPins === "number" && Number.isFinite(row.residencyPins)
    && Array.isArray(row.owners)
    && row.owners.every((owner) => {
      const entry = asRecord(owner)
      return !!entry && isNonEmptyString(entry.id) && isNonEmptyString(entry.kind) && isNonEmptyString(entry.generation)
        && isNonEmptyString(entry.state) && typeof entry.pins === "boolean"
    })
  )
}
