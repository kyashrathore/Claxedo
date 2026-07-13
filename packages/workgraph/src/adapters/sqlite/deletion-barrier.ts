import { createHash } from "node:crypto"
import type { OwnerUserID } from "../../contracts"
import type { RawDatabase } from "../../sqlite"

export class SqliteWorkGraphOwnerDeletionInProgressError extends Error {
  constructor() {
    super("WorkGraph owner deletion is in progress")
    this.name = "SqliteWorkGraphOwnerDeletionInProgressError"
  }
}

export function assertNoSqliteWorkGraphOwnerDeletion(
  database: RawDatabase,
  ownerUserId: OwnerUserID,
) {
  const receipt = database.prepare(`
    SELECT 1 AS present FROM wg_owner_deletion_receipts
    WHERE owner_subject_hash = ? AND state = 'cleaning' LIMIT 1
  `).get(createHash("sha256").update(ownerUserId).digest("hex"))
  if (receipt) throw new SqliteWorkGraphOwnerDeletionInProgressError()
}
