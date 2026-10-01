import { expect } from "vitest"
import { Hono } from "hono"
import { PublicDocumentRoutes } from "@claxedo/server-core/documents/routes/public"
import { DocumentsRoutes } from "@claxedo/server-core/documents/routes/index"
import type { DocumentsBackend } from "@claxedo/server-core/documents/backend"
import type { DocumentAccess, DocumentShare, DocumentSharing } from "@claxedo/server-core/documents/access"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"

export function privatePagesFixture(env?: NodeJS.ProcessEnv) {
  const entries = new Map<string, any>()
  const shares: DocumentShare[] = []
  const members = new Set(["creator", "member", "org-admin", "project-admin", "teammate"])
  const teams = new Map([["team", new Set(["teammate"])]])
  const sharing: DocumentSharing = {
    list: async (id) => shares.filter((share) => share.document_id === id),
    create: async (share) => {
      shares.push(share)
      return share
    },
    revoke: async (id, shareId) => {
      const index = shares.findIndex((share) => share.document_id === id && share.id === shareId)
      if (index >= 0) shares[index] = { ...shares[index]!, revoked_at: Date.now() }
    },
    findLink: async (hash) =>
      shares.find((share) => share.target === "link" && share.target_id === hash && share.revoked_at === null),
    granted: async (userId, orgId) =>
      shares.filter(
        (share) =>
          share.org_id === orgId &&
          share.revoked_at === null &&
          ((share.target === "person" && share.target_id === userId) ||
            (share.target === "team" && !!teams.get(share.target_id)?.has(userId))),
      ),
    isTeamInOrg: async (teamId, orgId) => orgId === "org" && teams.has(teamId),
  }
  const access: { -readonly [K in keyof DocumentAccess]: DocumentAccess[K] } = {
    principal: async (auth: SignedControlPlaneAuth, orgId?: string) => ({
      userId: auth.user.subject,
      ...(orgId ? { orgId } : {}),
      access,
    }),
    findDocument: async (orgId: string, id: string) => {
      const row = entries.get(id)
      return row?.org_id === orgId ? row : undefined
    },
    locateDocument: async (_userId: string, id: string) => entries.get(id),
    isOrgMember: async (userId: string, orgId: string) => orgId === "org" && members.has(userId),
    hasProjectAccess: async (userId: string, orgId: string, projectId: string) =>
      orgId === "org" && projectId === "project" && members.has(userId),
    sharing,
  }
  const backend = {
    access,
    index: {
      create: async (entry: any) => {
        entries.set(entry.id, entry)
        return entry
      },
      find: access.findDocument,
      list: async () => [...entries.values()],
      update: async (_scope: any, id: string, patch: any) => {
        const row = { ...entries.get(id), ...patch }
        entries.set(id, row)
        return row
      },
      archive: async (_scope: any, id: string) => {
        const row = { ...entries.get(id), archived_at: new Date().toISOString() }
        entries.set(id, row)
        return row
      },
      listStatuses: async () => [],
    },
    workspace: {
      create: async () => ({ version: "v1" }),
      resolve: async () => ({}),
      read: async () => ({ markdown: "private", version: "v1", modifiedAt: 1 }),
      write: async () => ({ version: "v2" }),
      listSnapshots: async () => [],
    },
    managedRelativePath: () => "page.md",
    placement: "hosted",
    placementId: "r2",
    agentOpen: async () => ({ path: "/session/page.md" }),
  } as unknown as DocumentsBackend
  const authority = {
    usersMe: async (auth: any) => ({ user_id: auth.user.subject }),
    resolveOrgId: async () => "org",
    authorizeProject: async () => ({ ok: true, role: "owner", orgId: "org" }),
  } as unknown as WorkspaceAuthority
  const routes = DocumentsRoutes({
    backend,
    authority,
    ...(env ? { env } : {}),
    authConfig: { enabled: true, issuer: "https://issuer.test", jwksUrl: "https://issuer.test/jwks" },
    verifier: async (token) => ({
      mode: "signed",
      user: { subject: token, tokenIdentifier: `issuer|${token}`, issuer: "https://issuer.test" },
    }),
  })
  const app = new Hono()
    .route("/documents", routes)
    .route("/p", PublicDocumentRoutes({ backend, rateLimit: async () => true }))
  const request = (user: string, path: string, method = "GET", body?: unknown) =>
    app.request(`http://control.test${path}`, {
      method,
      headers: { authorization: `Bearer ${user}`, "content-type": "application/json", "if-match": "v1" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  const create = async () => {
    const response = await request("creator", "/documents", "POST", { project_id: "project", display_name: "Private" })
    expect(response.status).toBe(201)
    return (await response.json()) as any
  }
  const share = (id: string, target: DocumentShare["target"], targetId: string, level: DocumentShare["level"]) =>
    shares.push({
      id: crypto.randomUUID(),
      document_id: id,
      org_id: "org",
      target,
      target_id: targetId,
      level,
      created_by: "creator",
      revoked_at: null,
    })
  return { authority, app, request, create, share, shares, teams, entries, access, backend, members }
}
