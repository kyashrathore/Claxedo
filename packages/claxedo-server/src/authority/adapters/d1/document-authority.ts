import { z } from "zod"
import type { D1PreparedStatement } from "@cloudflare/workers-types"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import { ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"
import {
  DocumentAccessError,
  type DocumentAccess,
  type DocumentPrincipal,
  type DocumentSharing,
  type NewDocumentShare,
} from "@claxedo/server-core/documents/access"
import type { DocumentsBackend } from "@claxedo/server-core/documents/backend"
import type { DocumentIndexEntry } from "@claxedo/server-core/documents/index-contract"
import type { D1AccessContext } from "./access-context"
import { batchUnder, may, mayGuard, maySql, type BoundSql } from "./authorization"

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
    async create(principal, page, share) {
      const manages = manageGuard(principal, page)
      const target = targetGuard(page.org_id, share)
      const row = DocumentShareRow.parse({
        ...share,
        document_id: page.id,
        org_id: page.org_id,
        created_by: principal.userId,
        revoked_at: null,
      })
      await writeUnder(manages, target, [
        database
          .prepare(
            `insert into document_shares
            (id, document_id, org_id, target, target_id, level, created_by, revoked_at)
            values (?, ?, ?, ?, ?, ?, ?, null)`,
          )
          .bind(row.id, row.document_id, row.org_id, row.target, row.target_id, row.level, row.created_by),
      ])
      return row
    },
    async revoke(principal, page, shareId) {
      await writeUnder(manageGuard(principal, page), undefined, [
        database
          .prepare("update document_shares set revoked_at = ? where document_id = ? and id = ? and revoked_at is null")
          .bind(context.now(), page.id, shareId),
      ])
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
  }

  /**
   * Runs a share write under the managing principal's standing and the
   * target's, both asked again inside its batch. A refusal is told apart
   * afterwards only to choose its answer: a principal who still manages the
   * page lost the target.
   */
  async function writeUnder(manages: BoundSql, target: BoundSql | undefined, statements: D1PreparedStatement[]) {
    const guard = target ? { sql: `(${manages.sql} and ${target.sql})`, bind: [...manages.bind, ...target.bind] } : manages
    try {
      await batchUnder(database, guard, statements)
    } catch (error) {
      if (!(error instanceof ControlPlaneAuthError) || error.code !== "workspace_authorization_denied") throw error
      const stillManages = await database.prepare(`select ${manages.sql} as holds`).bind(...manages.bind).first<{ holds: number }>()
      if (target && stillManages?.holds === 1) {
        throw new DocumentAccessError("document_share_target_outside_organization", 400)
      }
      throw new DocumentAccessError()
    }
  }
  const access: DocumentAccess = {
    async principal(auth, orgId) {
      if (orgId && !organizationAllowed(orgId)) throw new DocumentAccessError()
      const { userId, actorId } = await context.principal(auth)
      return { userId, actorId, ...(orgId ? { orgId } : {}), access }
    },
    findDocument: async (orgId, documentId) => await index.find(orgId, documentId),
    async locateDocument(userId, documentId) {
      const member = maySql({ userId }, "member", { kind: "org", orgId: "org.org_id" })
      const organizations = await database
        .prepare(`select org.org_id from orgs org where ${member.sql}`)
        .bind(...member.bind)
        .all<{ org_id: string }>()
      for (const { org_id: orgId } of organizations.results) {
        if (!organizationAllowed(orgId)) continue
        const entry = await index.find(orgId, documentId)
        if (entry) return entry
      }
      return undefined
    },
    isOrgMember: (userId, orgId) => may(database, { userId }, "member", { kind: "org", orgId }),
    hasProjectAccess: (userId, orgId, projectId) => may(database, { userId }, "read", { kind: "project", projectId, orgId }),
    sharing,
  }
  return access
}

/**
 * Who manages a page: its creator, while that person and their acting actor
 * are active and they may still read the page's project. The creator is fixed
 * for the page's life, so only the project rule is left for the write to ask.
 */
function manageGuard(principal: DocumentPrincipal, page: DocumentIndexEntry): BoundSql {
  if (!principal.actorId || !page.creator_id || page.creator_id !== principal.userId) throw new DocumentAccessError()
  return mayGuard({ userId: principal.userId, actorId: principal.actorId }, "read", {
    kind: "project",
    projectId: page.project_id,
    orgId: page.org_id,
  })
}

/** A person target is an active member of the page's organization; a team target is a live team of it. */
function targetGuard(orgId: string, share: NewDocumentShare): BoundSql | undefined {
  if (share.target === "person") return mayGuard({ userId: share.target_id }, "member", { kind: "org", orgId })
  if (share.target === "team") {
    return {
      sql: "exists (select 1 from teams where team_id = ? and org_id = ? and deleted_at is null)",
      bind: [share.target_id, orgId],
    }
  }
  return undefined
}
