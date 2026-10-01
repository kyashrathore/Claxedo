import { DocumentAccessError } from "@claxedo/account-contract/document-access"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import type { DocumentAccess } from "@claxedo/server-core/documents/access"
import type { DocumentsBackend } from "@claxedo/server-core/documents/backend"
import { createDocumentShareStore } from "@claxedo/server-core/documents/share-store"
import { isActiveOrgMember, type D1AccessContext } from "./access-context"
import { activeOrgMemberSql, projectRoleRankSql } from "./project-role"

export function d1DocumentAccess(context: D1AccessContext, index: DocumentsBackend["index"]): DocumentAccess {
  const database = context.database
  const organizationAllowed = (orgId: string) => {
    try {
      context.assertOrganizationAllowed(orgId)
      return true
    } catch (error) {
      if (error instanceof ClaxedoError && error.code === "organization_policy_denied") return false
      throw error
    }
  }
  const shares = createDocumentShareStore({
    all: async (sql, values) => (await database.prepare(sql).bind(...values).all()).results,
    run: async (sql, values) => { await database.prepare(sql).bind(...values).run() },
  }, context.now)
  const access: DocumentAccess = {
    async principal(auth, orgId) {
      if (orgId && !organizationAllowed(orgId)) throw new DocumentAccessError()
      const who = await context.principal(auth)
      return { userId: who.userId, orgId, access }
    },
    findDocument: async (orgId, documentId) => await index.find(orgId, documentId),
    async locateDocument(userId, documentId) {
      const organizations = await database.prepare(`select org.org_id from orgs org
        where ${activeOrgMemberSql("org.org_id", "?")}`).bind(userId, userId).all<{ org_id: string }>()
      for (const org of organizations.results) {
        if (!organizationAllowed(org.org_id)) continue
        const entry = await index.find(org.org_id, documentId)
        if (entry) return entry
      }
      return undefined
    },
    shares,
    async isOrgMember(userId, orgId) {
      return !!await database.prepare("select user_id from users where user_id = ? and state = 'active'").bind(userId).first()
        && await isActiveOrgMember(database, userId, orgId)
    },
    async isTeamInOrg(teamId, orgId) {
      return !!await database.prepare("select team_id from teams where team_id = ? and org_id = ? and deleted_at is null").bind(teamId, orgId).first()
    },
    async isTeamMember(userId, teamId, orgId) {
      return !!await database.prepare(`select member.user_id from team_memberships member
        join teams team on team.team_id = member.team_id and team.org_id = ? and team.deleted_at is null
        where member.user_id = ? and member.team_id = ? and member.revoked_at is null`).bind(orgId, userId, teamId).first()
    },
    async hasProjectAccess(userId, orgId, projectId) {
      const rank = projectRoleRankSql({ user: "who.user_id", projectId: "project.project_id", orgId: "project.org_id", ownerUserId: "project.owner_user_id" })
      return !!await database.prepare(`with who as (select ? as user_id)
        select project.project_id from projects project, who
        where project.org_id = ? and project.project_id = ? and project.deleted_at is null and ${rank} > 0`)
        .bind(userId, orgId, projectId).first()
    },
  }
  return access
}
