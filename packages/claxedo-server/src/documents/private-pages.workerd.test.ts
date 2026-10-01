import { afterEach, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import { Hono } from "hono"
import type { D1Database } from "@cloudflare/workers-types"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { DocumentsRoutes } from "@claxedo/server-core/documents/routes/index"
import { PublicDocumentRoutes } from "@claxedo/server-core/documents/routes/public"
import { createD1CoreAuthority } from "../authority/adapters/d1/core-authority"
import { D1WorkspaceAuthority } from "../authority/adapters/d1/workspace-authority"
import { d1DocumentAccess } from "../authority/adapters/d1/document-authority"
import { applyControlPlaneMigration, controlPlaneMigrations } from "../test-support/control-plane-migrations"
import { createHostedDocumentsBackend } from "./backends/hosted/backend"
import type { R2BucketBinding } from "./backends/hosted/managed"

const instances: Miniflare[] = []
afterEach(async () => { for (const instance of instances.splice(0)) await instance.dispose() })

async function fixture() {
  const instance = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", compatibilityDate: "2026-07-18", d1Databases: ["CONTROL_PLANE_DB"], r2Buckets: ["CLAXEDO_DOCUMENTS"] })
  instances.push(instance)
  const database = await instance.getD1Database("CONTROL_PLANE_DB")
  for (const migration of controlPlaneMigrations()) await applyControlPlaneMigration(database as D1Database, migration)
  const product = { kind: "claxedo-hosted" as const }
  const authority = createD1CoreAuthority(database as D1Database, { deploymentId: "documents-test", product })
  const people = new Map<string, SignedControlPlaneAuth>()
  for (const subject of ["creator", "member", "teammate", "org-admin", "project-admin", "outsider"]) {
    const identity = { adapter: "better-auth" as const, issuer: "https://identity.test", subject }
    const mapped = await authority.ensureApplicationIdentity(identity)
    if (mapped.state !== "active") throw new Error("Identity is not active")
    people.set(subject, { mode: "signed", user: { subject: mapped.userId, issuer: identity.issuer, tokenIdentifier: `${identity.issuer}|${subject}` }, principal: {
      userId: mapped.userId, actorId: mapped.actorId, actorKind: "human", deploymentId: "documents-test", sessionId: `session:${subject}`, authenticatedAt: Date.now(), methods: ["oauth:github"], assurance: "single-factor",
      client: { kind: "browser", tokenKind: "browser-session", id: "browser", resource: "https://api.test", scopes: ["openid"], origin: "https://app.test" }, identity,
    } })
  }
  const creator = people.get("creator")!
  await authority.createHostedOrganization(creator, { orgId: "org_pages", name: "Pages" })
  const project = await authority.createWorkspace(creator, { workspaceId: "workspace_pages", orgId: "org_pages", displayName: "Pages", backing: "local-worktree", repoUrl: "https://github.com/test/pages" })
  for (const name of ["member", "teammate", "org-admin", "project-admin"]) await authority.addOrgMember!(creator, { orgId: "org_pages", userPublicId: people.get(name)!.user.subject, role: name === "org-admin" ? "admin" : "member" })
  await database.prepare("insert into project_memberships (project_id, user_id, role, created_at, updated_at, revoked_at) values (?, ?, 'admin', 1, 1, null)").bind(project.project_id, people.get("project-admin")!.user.subject).run()
  const team = await authority.createTeamInOrg!(creator, { orgId: "org_pages", name: "Readers" }) as { team_id: string }
  await authority.addTeamMember!(creator, { teamId: team.team_id, userPublicId: people.get("teammate")!.user.subject })
  const context = new D1WorkspaceAuthority(database as D1Database, { deploymentId: "documents-test", product }).accessContext()
  const backend = createHostedDocumentsBackend(await instance.getR2Bucket("CLAXEDO_DOCUMENTS") as unknown as R2BucketBinding, { access: (index) => d1DocumentAccess(context, index) })
  const app = new Hono().route("/documents", DocumentsRoutes({ backend, authority, authConfig: { enabled: true, issuer: "https://identity.test", jwksUrl: "https://identity.test/jwks" }, verifier: async (token) => people.get(token)! })).route("/p", PublicDocumentRoutes({ backend, rateLimit: async () => true }))
  const request = (user: string, path: string, method = "GET", body?: unknown, headers?: Record<string, string>) => app.request(`https://api.test${path}`, { method, headers: { authorization: `Bearer ${user}`, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const created = await request("creator", "/documents", "POST", { project_id: project.project_id, display_name: "Private", markdown: "private" })
  expect(created.status).toBe(201)
  const page = await created.json() as { id: string }
  return { database, people, backend, request, page, team }
}

test("real D1 membership and R2 content enforce creator, person and team shares without admin overrides", async () => {
  const f = await fixture(); const path = `/documents/${f.page.id}`
  expect((await f.request("creator", `${path}/content`)).status).toBe(200)
  for (const user of ["member", "org-admin", "project-admin"]) expect((await f.request(user, path)).status).toBe(404)
  expect((await f.request("creator", `${path}/shares`, "POST", { target: "person", target_id: f.people.get("outsider")!.user.subject, level: "view" })).status).toBe(400)
  expect((await f.request("creator", `${path}/shares`, "POST", { target: "person", target_id: f.people.get("member")!.user.subject, level: "view" })).status).toBe(201)
  expect((await f.request("member", `${path}/content`)).status).toBe(200)
  expect((await f.request("member", `${path}/authorization?action=edit`)).status).toBe(404)
  expect((await f.request("member", `${path}/content`, "PUT", { markdown: "denied" }, { "if-match": "unknown-version" })).status).toBe(404)
  expect((await f.request("creator", `${path}/shares`, "POST", { target: "team", target_id: f.team.team_id, level: "edit" })).status).toBe(201)
  expect((await f.request("teammate", `${path}/authorization?action=edit`)).status).toBe(204)
  const content = await (await f.request("teammate", `${path}/content`)).json() as { version: string }
  expect((await f.request("teammate", `${path}/content`, "PUT", { markdown: "edited" }, { "if-match": content.version })).status).toBe(200)
  expect(await (await f.request("creator", `${path}/content`)).json()).toMatchObject({ markdown: "edited" })
  await f.database.prepare("update team_memberships set revoked_at = 1 where team_id = ?").bind(f.team.team_id).run()
  expect((await f.request("teammate", path)).status).toBe(404)
})

test("real D1 stores only the link hash and a revoked link cannot read R2", async () => {
  const f = await fixture(); const path = `/documents/${f.page.id}`
  const response = await f.request("creator", `${path}/shares`, "POST", { target: "link", level: "view" })
  expect(response.status).toBe(201)
  const share = await response.json() as { id: string; token: string }
  const stored = await f.database.prepare("select target_id, level from document_shares where id = ?").bind(share.id).first<{ target_id: string; level: string }>()
  expect(stored?.target_id).toHaveLength(64)
  expect(stored?.target_id).not.toBe(share.token)
  expect(stored?.level).toBe("view")
  expect((await f.request("", `/p/${share.token}`)).status).toBe(200)
  expect((await f.request("", `/p/${share.token}`, "PUT", { markdown: "changed" })).status).toBe(404)
  expect((await f.request("creator", `${path}/shares`, "DELETE", { share_id: share.id })).status).toBe(204)
  expect((await f.request("", `/p/${share.token}`)).status).toBe(404)
})
