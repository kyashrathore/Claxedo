import { z } from "zod"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import { DocumentAccessError, type DocumentAccess, type DocumentSharing } from "@claxedo/server-core/documents/access"
import type { DocumentsBackend } from "@claxedo/server-core/documents/backend"
import { isActiveOrgMember, type D1AccessContext } from "./access-context"
import { activeOrgMemberSql, projectRoleRankSql } from "./project-role"

const DocumentShareRow = z.object({
  id: z.string().min(1),
  document_id: z.string().min(1),
  org_id: z.string().min(1),
  target: z.enum(["person", "team", "link"]),
  target_id: z.string().min(1),
  level: z.enum(["view", "edit"]),
  created_by: z.string().min(1),
  revoked_at: z.number().nullable(),
})

export function d1DocumentAccess(context: D1AccessContext, index: DocumentsBackend["index"]): DocumentAccess {
  const { database } = context
  const organizationAllowed = (orgId: string) => {
    try {
      context.assertOrganizationAllowed(orgId)
      return true
    } catch (error) {
      if (error instanceof ClaxedoError && error.code === "organization_policy_denied") return false
      throw error
    }
  }
  const sharing: DocumentSharing = {
    async list(documentId) {
      const rows = await database.prepare("select * from document_shares where document_id = ?").bind(documentId).all()
      return rows.results.map((row) => DocumentShareRow.parse(row))
    },
    async create(share) {
      const row = DocumentShareRow.parse(share)
      await database
        .prepare(
          `insert into document_shares
          (id, document_id, org_id, target, target_id, level, created_by, revoked_at)
          values (?, ?, ?, ?, ?, ?, ?, null)`,
        )
        .bind(row.id, row.document_id, row.org_id, row.target, row.target_id, row.level, row.created_by)
        .run()
      return row
    },
    async revoke(documentId, shareId) {
      await database
        .prepare("update document_shares set revoked_at = ? where document_id = ? and id = ? and revoked_at is null")
        .bind(context.now(), documentId, shareId)
        .run()
    },
    async findLink(hash) {
      const row = await database
        .prepare("select * from document_shares where target = 'link' and target_id = ? and revoked_at is null")
        .bind(hash)
        .first()
      return row ? DocumentShareRow.parse(row) : undefined
    },
    async granted(userId, orgId) {
      const rows = await database
        .prepare(
          `select share.* from document_shares share
          where share.org_id = ? and share.revoked_at is null and (
            (share.target = 'person' and share.target_id = ?)
            or (share.target = 'team' and exists (
              select 1 from team_memberships member
              join teams team on team.team_id = member.team_id and team.org_id = share.org_id and team.deleted_at is null
              where member.team_id = share.target_id and member.user_id = ? and member.revoked_at is null
            ))
          )`,
        )
        .bind(orgId, userId, userId)
        .all()
      return rows.results.map((row) => DocumentShareRow.parse(row))
    },
    async isTeamInOrg(teamId, orgId) {
      return !!(await database
        .prepare("select team_id from teams where team_id = ? and org_id = ? and deleted_at is null")
        .bind(teamId, orgId)
        .first())
    },
  }
  const access: DocumentAccess = {
    async principal(auth, orgId) {
      if (orgId && !organizationAllowed(orgId)) throw new DocumentAccessError()
      const { userId } = await context.principal(auth)
      return { userId, ...(orgId ? { orgId } : {}), access }
    },
    findDocument: async (orgId, documentId) => await index.find(orgId, documentId),
    async locateDocument(userId, documentId) {
      const organizations = await database
        .prepare(`select org.org_id from orgs org where ${activeOrgMemberSql("org.org_id", "?")}`)
        .bind(userId, userId)
        .all<{ org_id: string }>()
      for (const { org_id: orgId } of organizations.results) {
        if (!organizationAllowed(orgId)) continue
        const entry = await index.find(orgId, documentId)
        if (entry) return entry
      }
      return undefined
    },
    async isOrgMember(userId, orgId) {
      return (
        !!(await database
          .prepare("select user_id from users where user_id = ? and state = 'active'")
          .bind(userId)
          .first()) && (await isActiveOrgMember(database, userId, orgId))
      )
    },
    async hasProjectAccess(userId, orgId, projectId) {
      const rank = projectRoleRankSql({
        user: "who.user_id",
        projectId: "project.project_id",
        orgId: "project.org_id",
        ownerUserId: "project.owner_user_id",
      })
      return !!(await database
        .prepare(
          `with who as (select ? as user_id)
          select project.project_id from projects project, who
          where project.org_id = ? and project.project_id = ? and project.deleted_at is null and ${rank} > 0`,
        )
        .bind(userId, orgId, projectId)
        .first())
    },
    sharing,
  }
  return access
}
