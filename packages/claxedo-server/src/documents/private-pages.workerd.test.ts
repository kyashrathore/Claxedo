import { afterEach, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import { Hono } from "hono"
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { DocumentsRoutes } from "@claxedo/server-core/documents/routes/index"
import { PublicDocumentRoutes } from "@claxedo/server-core/documents/routes/public"
import { createD1CoreAuthority } from "../authority/adapters/d1/core-authority"
import { D1WorkspaceAuthority } from "../authority/adapters/d1/workspace-authority"
import { d1DocumentAccess } from "../authority/adapters/d1/document-authority"
import { applyControlPlaneBaseline } from "../test-support/control-plane-migrations"
import { createHostedDocumentsBackend } from "./backends/hosted/backend"
import type { R2BucketBinding } from "./backends/hosted/managed"
import { inviteOrgMember } from "../test-support/invite-org-member"

const instances: Miniflare[] = []
afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.dispose()
})

async function fixture() {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2026-07-18",
    d1Databases: ["CONTROL_PLANE_DB"],
    r2Buckets: ["CLAXEDO_DOCUMENTS"],
  })
  instances.push(instance)
  const database = await instance.getD1Database("CONTROL_PLANE_DB")
  await applyControlPlaneBaseline(database as D1Database)
  const product = { kind: "claxedo-hosted" as const }
  const authority = createD1CoreAuthority(database as D1Database, { deploymentId: "documents-test", product })
  const people = new Map<string, SignedControlPlaneAuth>()
  for (const subject of ["creator", "member", "teammate", "org-admin", "project-admin", "outsider"]) {
    const identity = { adapter: "better-auth" as const, issuer: "https://identity.test", subject }
    const mapped = await authority.ensureApplicationIdentity(identity)
    if (mapped.state !== "active") throw new Error("Identity is not active")
    people.set(subject, {
      mode: "signed",
      user: { subject: mapped.userId, issuer: identity.issuer, tokenIdentifier: `${identity.issuer}|${subject}` },
      principal: {
        userId: mapped.userId,
        actorId: mapped.actorId,
        actorKind: "human",
        deploymentId: "documents-test",
        sessionId: `session:${subject}`,
        authenticatedAt: Date.now(),
        methods: ["oauth:github"],
        assurance: "single-factor",
        client: {
          kind: "browser",
          tokenKind: "browser-session",
          id: "browser",
          resource: "https://api.test",
          scopes: ["openid"],
          origin: "https://app.test",
        },
        identity,
      },
    })
  }
  const creator = people.get("creator")!
  await authority.createHostedOrganization(creator, { orgId: "org_pages", name: "Pages" })
  const project = await authority.createWorkspace(creator, {
    workspaceId: "workspace_pages",
    orgId: "org_pages",
    displayName: "Pages",
    backing: "local-worktree",
    repoUrl: "https://github.com/test/pages",
  })
  for (const name of ["member", "teammate", "org-admin", "project-admin"])
    await inviteOrgMember(database, creator, {
      orgId: "org_pages",
      userPublicId: people.get(name)!.user.subject,
      role: name === "org-admin" ? "admin" : "member",
    })
  await database
    .prepare(
      "insert into project_memberships (project_id, user_id, role, created_at, updated_at, revoked_at) values (?, ?, 'admin', 1, 1, null)",
    )
    .bind(project.project_id, people.get("project-admin")!.user.subject)
    .run()
  const team = (await authority.createTeamInOrg!(creator, { orgId: "org_pages", name: "Readers" })) as {
    team_id: string
  }
  await authority.addTeamMember!(creator, { teamId: team.team_id, userPublicId: people.get("teammate")!.user.subject })
  const queries = { count: 0 }
  // A step run just before the next batch, the share write, reaches D1, where
  // a concurrent writer lands in production.
  let beforeShareWrite: (() => Promise<unknown>) | undefined
  const counted = new Proxy(database as D1Database, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => (queries.count++, target.prepare(sql))
      if (property === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const step = beforeShareWrite
          beforeShareWrite = undefined
          if (step) await step()
          return await target.batch(statements)
        }
      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  const context = new D1WorkspaceAuthority(counted, { deploymentId: "documents-test", product }).accessContext()
  const backend = createHostedDocumentsBackend(
    (await instance.getR2Bucket("CLAXEDO_DOCUMENTS")) as unknown as R2BucketBinding,
    { access: (index) => d1DocumentAccess(context, index) },
  )
  const app = new Hono()
    .route(
      "/documents",
      DocumentsRoutes({
        backend,
        authority,
        authConfig: { enabled: true, issuer: "https://identity.test", jwksUrl: "https://identity.test/jwks" },
        verifier: async (token) => people.get(token)!,
      }),
    )
    .route("/p", PublicDocumentRoutes({ backend, rateLimit: async () => true }))
  const request = (user: string, path: string, method = "GET", body?: unknown, headers?: Record<string, string>) =>
    app.request(`https://api.test${path}`, {
      method,
      headers: { authorization: `Bearer ${user}`, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const created = await request("creator", "/documents", "POST", {
    project_id: project.project_id,
    display_name: "Private",
    markdown: "private",
  })
  expect(created.status).toBe(201)
  const page = (await created.json()) as { id: string }
  const shareRows = async (documentId = page.id) =>
    (
      await database
        .prepare("select target, target_id, revoked_at from document_shares where document_id = ? order by id")
        .bind(documentId)
        .all()
    ).results
  return {
    database,
    people,
    backend,
    request,
    page,
    team,
    project,
    queries,
    shareRows,
    beforeShareWrite: (step: () => Promise<unknown>) => {
      beforeShareWrite = step
    },
  }
}

test("real D1 membership and R2 content enforce creator, person and team shares without admin overrides", async () => {
  const f = await fixture()
  const path = `/documents/${f.page.id}`
  expect((await f.request("creator", `${path}/content`)).status).toBe(200)
  for (const user of ["member", "org-admin", "project-admin"]) expect((await f.request(user, path)).status).toBe(404)
  expect(
    (
      await f.request("creator", `${path}/shares`, "POST", {
        target: "person",
        target_id: f.people.get("outsider")!.user.subject,
        level: "view",
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await f.request("creator", `${path}/shares`, "POST", {
        target: "person",
        target_id: f.people.get("member")!.user.subject,
        level: "view",
      })
    ).status,
  ).toBe(201)
  expect((await f.request("member", `${path}/content`)).status).toBe(200)
  expect(
    (await f.request("member", `${path}/content`, "PUT", { markdown: "denied" }, { "if-match": "unknown-version" }))
      .status,
  ).toBe(404)
  expect(
    (await f.request("creator", `${path}/shares`, "POST", { target: "team", target_id: f.team.team_id, level: "edit" }))
      .status,
  ).toBe(201)
  const content = (await (await f.request("teammate", `${path}/content`)).json()) as { version: string }
  expect(
    (await f.request("teammate", `${path}/content`, "PUT", { markdown: "edited" }, { "if-match": content.version }))
      .status,
  ).toBe(200)
  expect(await (await f.request("creator", `${path}/content`)).json()).toMatchObject({ markdown: "edited" })
  const listed = async (user: string) =>
    ((await (await f.request(user, `/documents?project_id=${f.project.project_id}`)).json()) as { id: string }[]).map(
      (row) => row.id,
    )
  expect(await listed("teammate")).toEqual([f.page.id])
  expect(await listed("org-admin")).toEqual([])
  await f.database.prepare("update team_memberships set revoked_at = 1 where team_id = ?").bind(f.team.team_id).run()
  expect((await f.request("teammate", path)).status).toBe(404)
  expect(await listed("teammate")).toEqual([])
})

test("a shared listing costs the same D1 queries for one page as for many", async () => {
  const f = await fixture()
  const member = f.people.get("member")!.user.subject
  const share = async (id: string) =>
    expect(
      (
        await f.request("creator", `/documents/${id}/shares`, "POST", {
          target: "person",
          target_id: member,
          level: "view",
        })
      ).status,
    ).toBe(201)
  const list = async () => {
    const before = f.queries.count
    const response = await f.request("member", `/documents?project_id=${f.project.project_id}`)
    expect(response.status).toBe(200)
    return {
      ids: ((await response.json()) as { id: string }[]).map((row) => row.id),
      queries: f.queries.count - before,
    }
  }
  await share(f.page.id)
  const one = await list()
  expect(one.ids).toEqual([f.page.id])
  const more: string[] = []
  for (let index = 0; index < 12; index++) {
    const created = await f.request("creator", "/documents", "POST", {
      project_id: f.project.project_id,
      display_name: `Page ${index}`,
      markdown: "shared",
    })
    const id = ((await created.json()) as { id: string }).id
    more.push(id)
    await share(id)
  }
  const many = await list()
  expect(many.ids.sort()).toEqual([f.page.id, ...more].sort())
  expect(many.queries).toBe(one.queries)
})

test("real D1 stores only the link hash and a revoked link cannot read R2", async () => {
  const f = await fixture()
  const path = `/documents/${f.page.id}`
  const response = await f.request("creator", `${path}/shares`, "POST", { target: "link", level: "view" })
  expect(response.status).toBe(201)
  const share = (await response.json()) as { id: string; token: string }
  const stored = await f.database
    .prepare("select target_id, level from document_shares where id = ?")
    .bind(share.id)
    .first<{ target_id: string; level: string }>()
  expect(stored?.target_id).toHaveLength(64)
  expect(stored?.target_id).not.toBe(share.token)
  expect(stored?.level).toBe("view")
  expect((await f.request("", `/p/${share.token}`)).status).toBe(200)
  expect((await f.request("", `/p/${share.token}`, "PUT", { markdown: "changed" })).status).toBe(404)
  expect((await f.request("creator", `${path}/shares`, "DELETE", { share_id: share.id })).status).toBe(204)
  expect((await f.request("", `/p/${share.token}`)).status).toBe(404)
})

describe("a share write re-asks every standing it was admitted under", () => {
  const sharePage = (f: Awaited<ReturnType<typeof fixture>>, body: unknown, user = "creator", page = f.page.id) =>
    f.request(user, `/documents/${page}/shares`, "POST", body)

  test.each([
    ["person", "update users set state = 'suspended', suspended_at = 1 where user_id = ?", "subject"],
    ["actor", "update actors set state = 'suspended' where actor_id = ?", "actor"],
  ] as const)("a creator whose %s is suspended before the insert shares nothing", async (_, suspend, id) => {
    const f = await fixture()
    const creator = f.people.get("creator")!
    f.beforeShareWrite(() =>
      f.database.prepare(suspend).bind(id === "actor" ? creator.principal!.actorId : creator.user.subject).run(),
    )
    const response = await sharePage(f, { target: "person", target_id: f.people.get("member")!.user.subject, level: "view" })
    expect(response.status).toBe(404)
    expect(await f.shareRows()).toEqual([])
  })

  test.each([
    ["a person who leaves the organization", "person", "update org_memberships set revoked_at = 1 where org_id = 'org_pages' and user_id = ?"],
    ["a team deleted", "team", "update teams set deleted_at = 1 where team_id = ?"],
  ] as const)("%s before the insert is granted nothing", async (_, target, removal) => {
    const f = await fixture()
    const targetId = target === "team" ? f.team.team_id : f.people.get("member")!.user.subject
    f.beforeShareWrite(() => f.database.prepare(removal).bind(targetId).run())
    const response = await sharePage(f, { target, target_id: targetId, level: "view" })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "document_share_target_outside_organization" } })
    expect(await f.shareRows()).toEqual([])
  })

  test("a creator who leaves the organization before the revoke leaves the share in place", async () => {
    const f = await fixture()
    const creator = f.people.get("project-admin")!.user.subject
    const created = await f.request("project-admin", "/documents", "POST", {
      project_id: f.project.project_id,
      display_name: "Theirs",
      markdown: "theirs",
    })
    expect(created.status).toBe(201)
    const page = ((await created.json()) as { id: string }).id
    const shared = await sharePage(f, { target: "person", target_id: f.people.get("member")!.user.subject, level: "view" }, "project-admin", page)
    expect(shared.status).toBe(201)
    const share = (await shared.json()) as { id: string }
    f.beforeShareWrite(() =>
      f.database
        .prepare("update org_memberships set revoked_at = 1 where org_id = 'org_pages' and user_id = ?")
        .bind(creator)
        .run(),
    )
    const revoked = await f.request("project-admin", `/documents/${page}/shares`, "DELETE", { share_id: share.id })
    expect(revoked.status).toBe(404)
    expect(await f.shareRows(page)).toEqual([expect.objectContaining({ revoked_at: null })])
  })
})
