import type { D1Database } from "@cloudflare/workers-types"
import { may, maySql } from "../../authority/adapters/d1/authorization"

/** The organization's chosen sandbox driver, kept on its `orgs` row and changed only by an owner or admin. */
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
  }
}
