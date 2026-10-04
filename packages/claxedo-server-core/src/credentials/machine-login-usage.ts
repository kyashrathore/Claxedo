/**
 * Stored quota windows for the logins the harnesses on this machine hold.
 *
 * A harness reports its plan's windows only on the reads where it happens to
 * have them — Codex carries them on an app-server answer and not otherwise —
 * so a surface that showed usage once lost it on the next read. This table is
 * what it is served from in between.
 *
 * Nothing here spawns a harness or reads a secret: `machine-login.ts` runs the
 * CLIs and must stay free of the database, so the two meet at the caller.
 */

import { ClaxedoDB } from "../platform/db"
import { ClaxedoMachineLoginUsageTable } from "./machine-login-usage.sql"
import { parseUsageWindows, serializeUsageWindows } from "./usage-windows"
import type { CredentialUsageWindow } from "./types"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"

const log = Log.create({ service: "credentials-machine-login-usage" })

export type MachineLoginUsage = {
  harness: string
  /** The address the harness named, or `""` where it names none. */
  account: string
  windows: CredentialUsageWindow[]
  at: number
}

/** Every stored row. A harness holds one per address, so the table is tiny. */
export function readMachineLoginUsage(): MachineLoginUsage[] {
  try {
    return ClaxedoDB.use((db) =>
      db
        .select()
        .from(ClaxedoMachineLoginUsageTable)
        .all()
        .flatMap((row): MachineLoginUsage[] => {
          const windows = parseUsageWindows(row.usage_windows)
          if (!windows) return []
          return [{ harness: row.harness, account: row.account, windows, at: row.usage_at }]
        }),
    )
  } catch (error) {
    log.warn("machine login usage unavailable", { error: String(error) })
    return []
  }
}

export function recordMachineLoginUsage(
  harness: string,
  account: string,
  windows: readonly CredentialUsageWindow[],
  at: number,
): void {
  ClaxedoDB.use((db) => {
    const row = {
      harness,
      account,
      usage_windows: serializeUsageWindows(windows),
      usage_at: at,
    }
    db.insert(ClaxedoMachineLoginUsageTable)
      .values(row)
      .onConflictDoUpdate({
        target: [ClaxedoMachineLoginUsageTable.harness, ClaxedoMachineLoginUsageTable.account],
        set: { usage_windows: row.usage_windows, usage_at: row.usage_at },
      })
      .run()
  })
}

