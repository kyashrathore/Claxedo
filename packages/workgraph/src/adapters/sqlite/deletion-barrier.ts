import { createHash } from "node:crypto"
import type { OrganizationID, OwnerUserID } from "../../contracts"
import type { RawDatabase } from "../../sqlite"

export class SqliteWorkGraphOwnerDeletionInProgressError extends Error {
  constructor() {
    super("WorkGraph owner deletion is in progress")
    this.name = "SqliteWorkGraphOwnerDeletionInProgressError"
  }
}

export function assertNoSqliteWorkGraphOwnerDeletion(
  database: RawDatabase,
  organizationId: OrganizationID,
  ownerUserId: OwnerUserID,
) {
  const receipt = database.prepare(`
    SELECT 1 AS present FROM wg_owner_deletion_receipts
    WHERE owner_subject_hash = ? AND state = 'cleaning' LIMIT 1
  `).get(createHash("sha256").update(`${organizationId}\u0000${ownerUserId}`).digest("hex"))
  if (receipt) throw new SqliteWorkGraphOwnerDeletionInProgressError()
}
