import { expect } from "vitest"
import { Hono } from "hono"
import { PublicDocumentRoutes } from "@claxedo/server-core/documents/routes/public"
import { DocumentsRoutes } from "@claxedo/server-core/documents/routes/index"
import type { DocumentsBackend } from "@claxedo/server-core/documents/backend"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"

export function privatePagesFixture() {
  const entries = new Map<string, any>()
  const shares: any[] = []
  const members = new Set(["creator", "member", "org-admin", "project-admin", "teammate"])
  const access = {
    principal: async (auth: any, orgId: string): Promise<any> => ({ userId: auth.user.subject, orgId, access }),
    findDocument: async (orgId: string, id: string) => { const row = entries.get(id); return row?.org_id === orgId ? row : undefined },
    locateDocument: async (_userId: string, id: string) => entries.get(id),
    shares: {
      list: async (id: string) => shares.filter((s) => s.document_id === id),
      create: async (share: any) => { shares.push(share); return share },
      revoke: async (id: string, shareId: string) => { const row = shares.find((s) => s.document_id === id && s.id === shareId); if (row) row.revoked_at = Date.now() },
      findLink: async (hash: string) => shares.find((s) => s.target === "link" && s.target_id === hash && s.revoked_at === null),
    },
    isOrgMember: async (userId: string, orgId: string) => orgId === "org" && members.has(userId),
    isTeamMember: async (userId: string, teamId: string, orgId: string) => orgId === "org" && teamId === "team" && userId === "teammate",
    isTeamInOrg: async (teamId: string, orgId: string) => orgId === "org" && teamId === "team",
    hasProjectAccess: async (userId: string, orgId: string, projectId: string) => orgId === "org" && projectId === "project" && members.has(userId),
  }
  const backend = {
    access,
    index: {
      create: async (entry: any) => { entries.set(entry.id, entry); return entry },
      find: access.findDocument,
      list: async () => [...entries.values()],
      update: async (_scope: any, id: string, patch: any) => { const row = { ...entries.get(id), ...patch }; entries.set(id, row); return row },
      listStatuses: async () => [],
    },
    workspace: {
      create: async () => ({ version: "v1" }), resolve: async () => ({}),
      read: async () => ({ markdown: "private", version: "v1", modifiedAt: 1 }),
      write: async () => ({ version: "v2" }), listSnapshots: async () => [],
    },
    managedRelativePath: () => "page.md", placement: "hosted", placementId: "r2",
    agentOpen: async () => ({ path: "/session/page.md" }),
  } as unknown as DocumentsBackend
  const authority = {
    usersMe: async (auth: any) => ({ user_id: auth.user.subject }), resolveOrgId: async () => "org",
    authorizeProject: async () => ({ ok: true, role: "owner", orgId: "org" }),
  } as unknown as WorkspaceAuthority
  const routes = DocumentsRoutes({ backend, authority,
    authConfig: { enabled: true, issuer: "https://issuer.test", jwksUrl: "https://issuer.test/jwks" },
    verifier: async (token) => ({ mode: "signed", user: { subject: token, tokenIdentifier: `issuer|${token}`, issuer: "https://issuer.test" } }),
  })
  const app = new Hono().route("/documents", routes).route("/p", PublicDocumentRoutes({ backend, rateLimit: async () => true }))
  const request = (user: string, path: string, method = "GET", body?: unknown) => app.request(`http://control.test${path}`, {
    method, headers: { authorization: `Bearer ${user}`, "content-type": "application/json", "if-match": "v1" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const create = async () => { const response = await request("creator", "/documents", "POST", { project_id: "project", display_name: "Private" }); expect(response.status).toBe(201); return await response.json() as any }
  const share = (id: string, target: string, targetId: string, level: string) => shares.push({ id: crypto.randomUUID(), document_id: id, org_id: "org", target, target_id: targetId, level, created_by: "creator", revoked_at: null })
  return { authority, app, request, create, share, shares, entries, access, backend, members }
}
