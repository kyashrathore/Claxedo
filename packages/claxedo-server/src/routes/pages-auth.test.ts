import { afterAll, describe, expect, test, vi } from "vitest"
import { mkdirSync, realpathSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Hono } from "hono"
import { localOnlyAuthAdapter, type ClerkVerifier, type ControlPlaneAuthConfig } from "../control-plane/auth"
import type { WorkspaceAuthority, ProjectAction } from "../control-plane/authority"

const root = path.join(realpathSync(os.tmpdir()), `page-auth-routes-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { ClaxedoDB } = await import("../storage/db")
ClaxedoDB.Drizzle()
const { PagesRoutes } = await import("./pages")
const { PageArenaRoutes } = await import("./pages-arena")
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
    authorizeProject: vi.fn(async (auth, args: { action: ProjectAction }) => auth.user.subject === "tenant_a"
      ? { ok: true as const, role: args.action === "admin" ? "admin" as const : "editor" as const, orgId: "org_tenant_a" as never }
      : { ok: false as const }),
  } as unknown as WorkspaceAuthority
}

function app(input: { authority?: WorkspaceAuthority } = {}) {
  return new Hono().route("/pages", PagesRoutes({
    authConfig,
    verifier,
    services: {
      auth: { config: authConfig, verifier },
      authority: input.authority ?? authority(),
    } as never,
  }))
}

async function createSignedPage(input: { projectId: string; title?: string; content?: string }) {
  const res = await app().request(`http://app.example/pages?project_id=${input.projectId}`, {
    method: "POST",
    headers: {
      authorization: "Bearer tenant_a",
      "content-type": "application/json",
    },
    body: JSON.stringify({ title: input.title ?? "Signed", content: input.content ?? "Hello", project_id: input.projectId }),
  })
  expect(res.status).toBe(201)
  return await res.json() as {
    id: string
    version: number
    document_id: string
    document_revision_id: string
  }
}

describe("PagesRoutes signed auth", () => {
  afterAll(async () => {
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
    if (prev === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = prev
  })

  test("rejects non-loopback requests without a bearer", async () => {
    const res = await app().request("http://app.example/pages?project_id=project_auth")
    expect(res.status).toBe(401)
  })

  test("rejects non-loopback arena event streams without a bearer", async () => {
    const res = await app().request("http://app.example/pages/page_missing/arena/events?project_id=project_auth")
    expect(res.status).toBe(401)
  })

  test("standalone arena routes reject signed requests without page authorization", async () => {
    const res = await new Hono()
      .route("/pages/:id/arena", PageArenaRoutes({ authConfig, verifier }))
      .request("http://app.example/pages/page_missing/arena/start", {
        method: "POST",
        headers: {
          authorization: "Bearer tenant_a",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      })
    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "page_arena_authorizer_required" },
    })
  })

  test("keeps loopback unsigned pages working", async () => {
    const res = await new Hono().route("/pages", PagesRoutes({
      services: { auth: localOnlyAuthAdapter() } as never,
    })).request("http://localhost/pages?scope=global", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Local" }),
    })
    expect(res.status).toBe(201)
  })

  test("hides cross-tenant page access as not found", async () => {
    const projectId = `project_${randomUUID()}`
    const page = await createSignedPage({ projectId })
    const res = await app().request(`http://app.example/pages/${page.id}?project_id=${projectId}`, {
      headers: { authorization: "Bearer tenant_b" },
    })
    expect(res.status).toBe(404)
  })

  test("attributes immutable Page revisions to the authenticated user", async () => {
    const projectId = `project_${randomUUID()}`
    const page = await createSignedPage({ projectId, title: "Authored plan", content: "Exact signed body" })
    const revision = sqliteDocumentStore.getRevision(
      { orgId: "org_tenant_a", projectId },
      page.document_id,
      page.document_revision_id,
    )

    expect(revision).toMatchObject({
      documentId: page.document_id,
      revisionId: page.document_revision_id,
      documentTitle: "Authored plan",
      markdown: "Exact signed body",
      authoredBy: { type: "user", id: "tenant_a" },
    })
  })

  test("does not let workspace-share-only principals read project pages", async () => {
    const projectId = `project_${randomUUID()}`
    const page = await createSignedPage({ projectId })
    const res = await app().request(`http://app.example/pages/${page.id}?project_id=${projectId}`, {
      headers: { authorization: "Bearer shared_workspace_user" },
    })
    expect(res.status).toBe(404)
  })

  test.each([
    ["page list", "/pages?scope=all"],
    ["page events", "/pages/events?scope=all"],
    ["status list", "/pages/statuses?scope=all"],
  ])("rejects signed all-scope %s without a project", async (_name, route) => {
    const res = await app().request(`http://app.example${route}`, {
      headers: { authorization: "Bearer tenant_a" },
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "page_project_required" },
    })
  })

  test.each([
    ["PATCH", async (page: { id: string }, projectId: string) => app().request(`http://app.example/pages/${page.id}?project_id=${projectId}`, {
      method: "PATCH",
      headers: {
        authorization: "Bearer tenant_b",
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "Nope" }),
    })],
    ["DELETE", async (page: { id: string }, projectId: string) => app().request(`http://app.example/pages/${page.id}?project_id=${projectId}`, {
      method: "DELETE",
      headers: { authorization: "Bearer tenant_b" },
    })],
    ["PATCH session", async (page: { id: string }, projectId: string) => app().request(`http://app.example/pages/${page.id}/session?project_id=${projectId}`, {
      method: "PATCH",
      headers: {
        authorization: "Bearer tenant_b",
        "content-type": "application/json",
      },
      body: JSON.stringify({ session_id: "session_x" }),
    })],
    ["POST status", async (page: { id: string }, projectId: string) => app().request(`http://app.example/pages/${page.id}/status?project_id=${projectId}`, {
      method: "POST",
      headers: {
        authorization: "Bearer tenant_b",
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "in_progress" }),
    })],
  ])("hides cross-tenant %s access as not found", async (_name, requestPage) => {
    const projectId = `project_${randomUUID()}`
    const page = await createSignedPage({ projectId })
    const res = await requestPage(page, projectId)
    expect(res.status).toBe(404)
  })

  test("authorizes direct ids against the stored page project when no project_id query is present", async () => {
    const projectId = `project_${randomUUID()}`
    const page = await createSignedPage({ projectId })
    const projectCalls: string[] = []
    const ambientAuthority = {
      usersMe: vi.fn(async () => ({})),
      resolveOrgId: vi.fn(async () => "org_tenant_a" as never),
      authorizeProject: vi.fn(async (_auth, args: { projectId: string }) => {
        projectCalls.push(args.projectId)
        return args.projectId === "__pages_global__"
          ? { ok: true as const, role: "editor" as const, orgId: "org_tenant_a" as never }
          : { ok: false as const }
      }),
    } as unknown as WorkspaceAuthority
    const res = await app({ authority: ambientAuthority }).request(`http://app.example/pages/${page.id}`, {
      headers: { authorization: "Bearer tenant_a" },
    })
    expect(res.status).toBe(404)
    expect(projectCalls).toEqual([projectId])
  })

  test("returns markdown export for readable pages", async () => {
    const projectId = `project_${randomUUID()}`
    const page = await createSignedPage({ projectId, content: "# Hello" })
    const res = await app().request(`http://app.example/pages/${page.id}/export?project_id=${projectId}`, {
      headers: { authorization: "Bearer tenant_a" },
    })
    expect(res.status).toBe(200)
    await expect(res.text()).resolves.toBe("# Hello")
  })

  test("returns a typed conflict on stale If-Match writes", async () => {
    const projectId = `project_${randomUUID()}`
    const page = await createSignedPage({ projectId })
    const updated = await app().request(`http://app.example/pages/${page.id}?project_id=${projectId}`, {
      method: "PATCH",
      headers: {
        authorization: "Bearer tenant_a",
        "content-type": "application/json",
        "if-match": "0",
      },
      body: JSON.stringify({ title: "First" }),
    })
    expect(updated.status).toBe(200)

    const stale = await app().request(`http://app.example/pages/${page.id}?project_id=${projectId}`, {
      method: "PATCH",
      headers: {
        authorization: "Bearer tenant_a",
        "content-type": "application/json",
        "if-match": "0",
      },
      body: JSON.stringify({ title: "Stale" }),
    })
    expect(stale.status).toBe(409)
    await expect(stale.json()).resolves.toMatchObject({ currentVersion: 1 })
  })

  test("requires If-Match for content and title writes", async () => {
    const projectId = `project_${randomUUID()}`
    const page = await createSignedPage({ projectId })
    const res = await app().request(`http://app.example/pages/${page.id}?project_id=${projectId}`, {
      method: "PATCH",
      headers: {
        authorization: "Bearer tenant_a",
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "No precondition" }),
    })

    expect(res.status).toBe(428)
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "page_version_required" },
    })
  })
})
