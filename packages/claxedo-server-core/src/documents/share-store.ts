import { z } from "zod"
import type { DocumentShareStore } from "@claxedo/account-contract/document-access"

const Share = z.object({
  id: z.string().min(1), document_id: z.string().min(1), org_id: z.string().min(1),
  target: z.enum(["person", "team", "link"]), target_id: z.string().min(1),
  level: z.enum(["view", "edit"]), created_by: z.string().min(1), revoked_at: z.number().nullable(),
})

export type DocumentShareSql = {
  all(sql: string, values: readonly unknown[]): Promise<unknown[]>
  run(sql: string, values: readonly unknown[]): Promise<void>
}

export function createDocumentShareStore(database: DocumentShareSql, now: () => number = Date.now): DocumentShareStore {
  return {
    async list(documentId) {
      return (await database.all("select * from document_shares where document_id = ?", [documentId])).map((row) => Share.parse(row))
    },
    async create(share) {
      const row = Share.parse(share)
      await database.run(`insert into document_shares
        (id, document_id, org_id, target, target_id, level, created_by, revoked_at)
        values (?, ?, ?, ?, ?, ?, ?, null)`,
        [row.id, row.document_id, row.org_id, row.target, row.target_id, row.level, row.created_by])
      return row
    },
    async revoke(documentId, shareId) {
      await database.run("update document_shares set revoked_at = ? where document_id = ? and id = ? and revoked_at is null", [now(), documentId, shareId])
    },
    async findLink(hash) {
      const [row] = await database.all("select * from document_shares where target = 'link' and target_id = ? and revoked_at is null", [hash])
      return row ? Share.parse(row) : undefined
    },
  }
}
