import type { D1Database } from "@cloudflare/workers-types"
import type { SandboxKeyRemoval } from "@claxedo/server-core/credentials/routes/sandbox-driver-keys"
import { may, mayGuard, maySql } from "../../authority/adapters/d1/authorization"
import { SANDBOX_KEY_LABEL, SANDBOX_ORG_LABEL } from "../org-sandbox-manager"

/**
 * The organization's sandbox provider keys on D1, changed only by an owner or admin: the chosen driver on its `orgs`
 * row, and removing a key no workspace's lease still names.
 */
export function d1OrgSandboxDriver(database: D1Database, now: () => number = Date.now) {
  return {
    chosen: async (orgId: string) =>
      (await database
        .prepare("select sandbox_driver from orgs where org_id = ? and deleted_at is null")
        .bind(orgId)
        .first<{ sandbox_driver: string | null }>())?.sandbox_driver ?? undefined,
    administers: (userId: string, orgId: string) => may(database, { userId }, "administer", { kind: "org", orgId }),
    choose: async (userId: string, orgId: string, driver: string | undefined) => {
      const administers = maySql({ userId }, "administer", { kind: "org", orgId: "org.org_id" })
      const result = await database
        .prepare(`update orgs as org set sandbox_driver = ?, updated_at = ?
          where org.org_id = ? and org.deleted_at is null and ${administers.sql}`)
        .bind(driver ?? null, now(), orgId, ...administers.bind)
        .run()
      return (result.meta.changes ?? 0) > 0
    },
    // A lease names its key from the moment it is taken; the count and the delete run in one batch, so a workspace
    // taking the key either is counted here or finds the key gone before its machine is made.
    remove: async (userId: string, orgId: string, keyId: string): Promise<SandboxKeyRemoval> => {
      const leases = `from sandbox_leases where status <> 'destroyed'
        and json_extract(labels_json, '$.${SANDBOX_KEY_LABEL}') = ? and json_extract(labels_json, '$.${SANDBOX_ORG_LABEL}') = ?`
      const administers = mayGuard({ userId }, "administer", { kind: "org", orgId })
      const [using, removed] = await database.batch([
        database.prepare(`select count(*) as workspaces ${leases}`).bind(keyId, orgId),
        database
          .prepare(`delete from hosted_provider_credentials
            where org_id = ? and id = ? and owner is null and kind = 'sandbox_driver'
              and ${administers.sql} and not exists (select 1 ${leases})`)
          .bind(orgId, keyId, ...administers.bind, keyId, orgId),
      ])
      const workspaces = (using?.results[0] as { workspaces: number } | undefined)?.workspaces ?? 0
      return workspaces > 0 ? { workspaces } : { deleted: (removed?.meta.changes ?? 0) > 0 }
    },
  }
}
