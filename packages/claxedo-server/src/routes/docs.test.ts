import { afterAll, describe, expect, test, vi } from "vitest"
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, realpathSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import type { ClerkVerifier, ControlPlaneAuthConfig } from "../control-plane/auth"
import type { ProjectAction, WorkspaceAuthority } from "../control-plane/authority"

const root = path.join(realpathSync(os.tmpdir()), `docs-v2-routes-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const previousDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { ClaxedoDB } = await import("../storage/db")
ClaxedoDB.Drizzle()
const { DocsRoutes } = await import("./docs")
const { sqliteDocumentStore } = await import("../doc-store")

const authConfig: ControlPlaneAuthConfig = {
  enabled: true,
  issuer: "https://clerk.example.test",
  jwksUrl: "https://clerk.example.test/.well-known/jwks.json",
}
const verifier: ClerkVerifier = async (token, config) => ({
  mode: "signed",
  user: {
    subject: token,
    tokenIdentifier: `${config.issuer}|${token}`,
    issuer: config.issuer,
  },
})

function authority() {
  return {
    usersMe: vi.fn(async () => ({})),
    resolveOrgId: vi.fn(async (auth) => `org_${auth.user.subject}` as never),
    authorizeProject: vi.fn(async (auth, args: { action: ProjectAction }) =>
      auth.user.subject === "tenant_a"
        ? {
            ok: true as const,
            role: args.action === "read" ? ("viewer" as const) : ("editor" as const),
            orgId: "org_tenant_a" as never,
          }
        : { ok: false as const },
    ),
  } as unknown as WorkspaceAuthority
}

function app(input: { authority?: WorkspaceAuthority } = {}) {
  return new Hono().route(
    "/api/claxedo/docs",
    DocsRoutes({
      store: () => sqliteDocumentStore,
      authConfig,
      verifier,
      authority: input.authority ?? authority(),
    }),
  )
}

function digest(markdown: string) {
  return createHash("sha256").update(markdown).digest("hex")
}

async function createDocument(
  input: {
    origin?: string
    token?: string
    projectId?: string
    title?: string
    markdown?: string
    authoredBy?: { type: "user" | "agent" | "system"; id: string }
  } = {},
) {
  const markdown = input.markdown ?? "# Launch"
  const token = input.token
  const response = await app().request(
    `${input.origin ?? "http://localhost"}/api/claxedo/docs?project_id=${input.projectId ?? "project_1"}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        title: input.title ?? "Launch Claxedo",
        markdown,
        contentHash: digest(markdown),
        authoredBy: input.authoredBy ?? { type: "user", id: token ?? "local_user" },
      }),
    },
  )
  expect(response.status).toBe(201)
  return (await response.json()) as {
    projectId: string
    documentId: string
    revisionId: string
    revisionNumber: number
    contentHash: string
  }
}

describe("Docs v2 revision routes", () => {
  afterAll(async () => {
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
    if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = previousDataDir
  })

  test("creates and reads one exact immutable revision on unsigned loopback", async () => {
    const created = await createDocument()
    const response = await app().request(
      `http://localhost/api/claxedo/docs/${created.documentId}/revisions/${created.revisionId}?project_id=project_1`,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      projectId: "project_1",
      documentId: created.documentId,
      documentTitle: "Launch Claxedo",
      revisionId: created.revisionId,
      revisionNumber: 1,
      markdown: "# Launch",
      contentHash: digest("# Launch"),
      authoredAt: expect.any(Number),
      authoredBy: { type: "user", id: "local_user" },
    })
  })

  test("lists only one project's durable documents and reads the current immutable head", async () => {
    const first = await createDocument({ projectId: "project_inventory", title: "First" })
    const second = await createDocument({ projectId: "project_inventory", title: "Second" })
    await createDocument({ projectId: "project_elsewhere", title: "Outside" })

    const listing = await app().request("http://localhost/api/claxedo/docs?project_id=project_inventory")
    expect(listing.status).toBe(200)
    const inventory = (await listing.json()) as { documents: unknown[] }
    expect(inventory).toEqual({
      documents: expect.arrayContaining([
        {
          documentId: first.documentId,
          projectId: "project_inventory",
          title: "First",
          headRevisionId: first.revisionId,
          createdAt: expect.any(Number),
          updatedAt: expect.any(Number),
        },
        {
          documentId: second.documentId,
          projectId: "project_inventory",
          title: "Second",
          headRevisionId: second.revisionId,
          createdAt: expect.any(Number),
          updatedAt: expect.any(Number),
        },
      ]),
    })
    expect(inventory.documents).toHaveLength(2)

    const head = await app().request(
      `http://localhost/api/claxedo/docs/${first.documentId}?project_id=project_inventory`,
    )
    expect(head.status).toBe(200)
    await expect(head.json()).resolves.toMatchObject({
      documentId: first.documentId,
      revisionId: first.revisionId,
      revisionNumber: 1,
      documentTitle: "First",
    })
  })

  test("appends only a direct child and keeps the previous revision readable", async () => {
    const created = await createDocument()
    const markdown = "# Launch\n\nAdd rollout checks."
    const revised = await app().request(
      `http://localhost/api/claxedo/docs/${created.documentId}/revisions?project_id=project_1`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedParentRevisionId: created.revisionId,
          title: "Launch Claxedo",
          markdown,
          contentHash: digest(markdown),
          authoredBy: { type: "agent", id: "agent_1" },
        }),
      },
    )

    expect(revised.status).toBe(201)
    const revision = (await revised.json()) as { revisionId: string }
    const exact = await app().request(
      `http://localhost/api/claxedo/docs/${created.documentId}/revisions/${revision.revisionId}?project_id=project_1`,
    )
    await expect(exact.json()).resolves.toMatchObject({
      revisionNumber: 2,
      parentRevisionId: created.revisionId,
      markdown,
      authoredBy: { type: "agent", id: "agent_1" },
    })
    const previous = await app().request(
      `http://localhost/api/claxedo/docs/${created.documentId}/revisions/${created.revisionId}?project_id=project_1`,
    )
    await expect(previous.json()).resolves.toMatchObject({ revisionNumber: 1, markdown: "# Launch" })
    const head = await app().request(`http://localhost/api/claxedo/docs/${created.documentId}?project_id=project_1`)
    await expect(head.json()).resolves.toMatchObject({
      revisionId: revision.revisionId,
      revisionNumber: 2,
      parentRevisionId: created.revisionId,
      markdown,
    })
  })

  test("returns a typed conflict for a stale parent without creating an orphan revision", async () => {
    const created = await createDocument()
    const revise = (expectedParentRevisionId: string, markdown: string) =>
      app().request(`http://localhost/api/claxedo/docs/${created.documentId}/revisions?project_id=project_1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedParentRevisionId,
          title: "Launch Claxedo",
          markdown,
          contentHash: digest(markdown),
          authoredBy: { type: "user", id: "local_user" },
        }),
      })
    const first = await revise(created.revisionId, "# Revision 2")
    const head = (await first.json()) as { revisionId: string }
    const stale = await revise(created.revisionId, "# Stale child")

    expect(stale.status).toBe(409)
    await expect(stale.json()).resolves.toEqual({
      error: {
        code: "document_revision_conflict",
        message: "Document head changed",
        currentRevisionId: head.revisionId,
      },
    })
    const missing = await app().request(
      `http://localhost/api/claxedo/docs/${created.documentId}/revisions/revision_missing?project_id=project_1`,
    )
    expect(missing.status).toBe(404)
  })

  test("does not resolve a revision through a different document identity", async () => {
    const first = await createDocument({ title: "First" })
    const second = await createDocument({ title: "Second" })
    const response = await app().request(
      `http://localhost/api/claxedo/docs/${first.documentId}/revisions/${second.revisionId}?project_id=project_1`,
    )

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "document_not_found" } })
  })

  test("rejects content whose declared hash does not match before persistence", async () => {
    const response = await app().request("http://localhost/api/claxedo/docs?project_id=project_hash", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Hash mismatch",
        markdown: "# Exact",
        contentHash: "0".repeat(64),
        authoredBy: { type: "user", id: "local_user" },
      }),
    })
    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "document_content_hash_mismatch" } })
  })

  test("authorizes stored project scope and hides cross-tenant or mismatched project reads", async () => {
    const created = await createDocument({
      origin: "http://app.example",
      token: "tenant_a",
      projectId: "project_auth",
    })
    const crossTenant = await app().request(
      `http://app.example/api/claxedo/docs/${created.documentId}/revisions/${created.revisionId}?project_id=project_auth`,
      { headers: { authorization: "Bearer tenant_b" } },
    )
    expect(crossTenant.status).toBe(404)

    const crossTenantHead = await app().request(
      `http://app.example/api/claxedo/docs/${created.documentId}?project_id=project_auth`,
      { headers: { authorization: "Bearer tenant_b" } },
    )
    expect(crossTenantHead.status).toBe(404)

    const crossTenantList = await app().request("http://app.example/api/claxedo/docs?project_id=project_auth", {
      headers: { authorization: "Bearer tenant_b" },
    })
    expect(crossTenantList.status).toBe(404)

    const wrongProject = await app().request(
      `http://app.example/api/claxedo/docs/${created.documentId}/revisions/${created.revisionId}?project_id=project_other`,
      { headers: { authorization: "Bearer tenant_a" } },
    )
    expect(wrongProject.status).toBe(404)

    const wrongProjectHead = await app().request(
      `http://app.example/api/claxedo/docs/${created.documentId}?project_id=project_other`,
      { headers: { authorization: "Bearer tenant_a" } },
    )
    expect(wrongProjectHead.status).toBe(404)

    const unauthenticated = await app().request(
      `http://app.example/api/claxedo/docs/${created.documentId}/revisions/${created.revisionId}?project_id=project_auth`,
    )
    expect(unauthenticated.status).toBe(401)
  })

  test("rejects a signed caller that claims another user as author", async () => {
    const markdown = "# Forged"
    const response = await app().request("http://app.example/api/claxedo/docs?project_id=project_auth", {
      method: "POST",
      headers: { authorization: "Bearer tenant_a", "content-type": "application/json" },
      body: JSON.stringify({
        title: "Forged",
        markdown,
        contentHash: digest(markdown),
        authoredBy: { type: "user", id: "another_user" },
      }),
    })
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "document_author_forbidden" } })
  })
})
