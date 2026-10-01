import { DocumentAccessError } from "@claxedo/server-core/documents/access"
import { describe, expect, test } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { mintDocumentRelayJobToken } from "@claxedo/server-core/platform/auth/runtime-access-token"
import { privatePagesFixture } from "./private-pages-fixture"

describe("private page HTTP entrypoints", () => {
  test("records the creator and lets them read", async () => {
    const f = privatePagesFixture()
    const page = await f.create()
    expect(page.creator_id).toBe("creator")
    expect((await f.request("creator", `/documents/${page.id}/content`)).status).toBe(200)
  })
  test.each(["member", "org-admin", "project-admin"])(
    "%s has no access without a share, including metadata, content, agent-open and lists",
    async (user) => {
      const f = privatePagesFixture()
      const page = await f.create()
      for (const suffix of ["", "/content"])
        expect((await f.request(user, `/documents/${page.id}${suffix}`)).status).toBe(404)
      expect(
        (await f.request(user, `/documents/${page.id}/agent-open`, "POST", { session_id: "session" })).status,
      ).toBe(404)
      expect(await (await f.request(user, "/documents?project_id=project")).json()).toEqual([])
    },
  )
  test("a view share reads but cannot edit or hydrate", async () => {
    const f = privatePagesFixture()
    const page = await f.create()
    f.share(page.id, "person", "member", "view")
    expect((await f.request("member", `/documents/${page.id}/content`)).status).toBe(200)
    expect((await f.request("member", `/documents/${page.id}/content`, "PUT", { markdown: "changed" })).status).toBe(
      404,
    )
    expect(
      (await f.request("member", `/documents/${page.id}/agent-open`, "POST", { session_id: "session" })).status,
    ).toBe(404)
  })
  test("an edit share edits, but cannot manage shares", async () => {
    const f = privatePagesFixture()
    const page = await f.create()
    f.share(page.id, "person", "member", "edit")
    expect((await f.request("member", `/documents/${page.id}/content`, "PUT", { markdown: "changed" })).status).toBe(
      200,
    )
    expect((await f.request("member", `/documents/${page.id}/shares`)).status).toBe(404)
  })
  test("a team share admits a member and refuses a non-member", async () => {
    const f = privatePagesFixture()
    const page = await f.create()
    f.share(page.id, "team", "team", "view")
    expect((await f.request("teammate", `/documents/${page.id}`)).status).toBe(200)
    expect((await f.request("member", `/documents/${page.id}`)).status).toBe(404)
    f.teams.get("team")!.delete("teammate")
    expect((await f.request("teammate", `/documents/${page.id}`)).status).toBe(404)
  })
  test("refuses a person outside the org and manages an internal share", async () => {
    const f = privatePagesFixture()
    const page = await f.create()
    expect(
      (
        await f.request("creator", `/documents/${page.id}/shares`, "POST", {
          target: "person",
          target_id: "outsider",
          level: "view",
        })
      ).status,
    ).toBe(400)
    const response = await f.request("creator", `/documents/${page.id}/shares`, "POST", {
      target: "person",
      target_id: "member",
      level: "edit",
    })
    expect(response.status).toBe(201)
    const share = (await response.json()) as any
    expect(await (await f.request("creator", `/documents/${page.id}/shares`)).json()).toEqual([share])
    expect((await f.request("creator", `/documents/${page.id}/shares`, "DELETE", { share_id: share.id })).status).toBe(
      204,
    )
    expect((await f.request("member", `/documents/${page.id}`)).status).toBe(404)
  })
  test("link tokens read view-only, are stored hashed and stop working on revoke", async () => {
    const f = privatePagesFixture()
    const page = await f.create()
    const response = await f.request("creator", `/documents/${page.id}/shares`, "POST", {
      target: "link",
      level: "view",
    })
    expect(response.status).toBe(201)
    const share = (await response.json()) as any
    expect(share.token).toHaveLength(64)
    expect(f.shares[0].target_id).not.toBe(share.token)
    expect((await f.request("", `/p/${share.token}`)).status).toBe(200)
    expect((await f.request("", `/p/${share.token}`, "PUT", { markdown: "changed" })).status).toBe(404)
    await f.request("creator", `/documents/${page.id}/shares`, "DELETE", { share_id: share.id })
    expect((await f.request("", `/p/${share.token}`)).status).toBe(404)
  })
  test("old rows with no creator remain unreadable", async () => {
    const f = privatePagesFixture()
    const page = await f.create()
    delete f.entries.get(page.id).creator_id
    expect((await f.request("creator", `/documents/${page.id}`)).status).toBe(404)
  })
})

describe("private page authorization boundary", () => {
  test("a project denial does not disclose the document", async () => {
    const f = privatePagesFixture()
    const page = await f.create()
    f.access.hasProjectAccess = async () => false
    expect((await f.request("creator", `/documents/${page.id}`)).status).toBe(404)
  })
  test("public reads reject edit links", async () => {
    const f = privatePagesFixture()
    const page = await f.create()
    expect(
      (await f.request("creator", `/documents/${page.id}/shares`, "POST", { target: "link", level: "edit" })).status,
    ).toBe(400)
  })
})

test("view shares can export content and read snapshot history", async () => {
  const f = privatePagesFixture()
  const page = await f.create()
  f.share(page.id, "person", "member", "view")
  expect((await f.request("member", `/documents/${page.id}/export`)).status).toBe(200)
  expect((await f.request("member", `/documents/${page.id}/snapshots`)).status).toBe(200)
})

test.each(["runtime-writeback", "runtime-capability/renew"])("%s keeps document denials at 404", async (path) => {
  const f = privatePagesFixture()
  const page = await f.create()
  const deny = async () => {
    throw new DocumentAccessError()
  }
  Object.assign(f.backend, { runtimeWriteback: deny, runtimeRenew: deny, runtimeDispose: deny })
  const query = "?org_id=org&project_id=project&workspace_id=workspace&session_id=session"
  const method = path === "runtime-writeback" ? "PUT" : "POST"
  expect(
    (
      await f.request(
        "member",
        `/documents/${page.id}/${path}${query}`,
        method,
        path === "runtime-writeback" ? { markdown: "private" } : {},
      )
    ).status,
  ).toBe(404)
})

test("document lookup and project listing do not require a single organization membership", async () => {
  const f = privatePagesFixture()
  const page = await f.create()
  f.authority.resolveOrgId = async () => {
    throw new Error("An explicit application organization selection is required")
  }
  expect((await f.request("creator", `/documents/${page.id}`)).status).toBe(200)
  expect((await f.request("org-admin", `/documents/${page.id}`)).status).toBe(404)
  expect((await f.request("creator", "/documents?project_id=project")).status).toBe(200)
})

test("a signed loopback request keeps its authenticated document principal", async () => {
  const f = privatePagesFixture()
  const page = await f.create()
  expect(
    (await f.app.request(`http://localhost/documents/${page.id}`, { headers: { authorization: "Bearer creator" } }))
      .status,
  ).toBe(200)
})

test("a link stops granting access when its creator loses the project gate", async () => {
  const f = privatePagesFixture()
  const page = await f.create()
  const response = await f.request("creator", `/documents/${page.id}/shares`, "POST", { target: "link", level: "view" })
  const share = (await response.json()) as { token: string }
  f.access.hasProjectAccess = async () => false
  expect((await f.request("", `/p/${share.token}`)).status).toBe(404)
})

test("only the creator archives a page; an edit share does not reach it", async () => {
  const f = privatePagesFixture()
  const page = await f.create()
  f.share(page.id, "person", "member", "edit")
  expect((await f.request("member", `/documents/${page.id}/archive`, "POST")).status).toBe(404)
  expect((await f.request("creator", `/documents/${page.id}/archive`, "POST")).status).toBe(200)
})

test("a listing reads membership, project access and shares once, however many pages it holds", async () => {
  const f = privatePagesFixture()
  const pages = await Promise.all(Array.from({ length: 25 }, () => f.create()))
  for (const page of pages.slice(0, 10)) f.share(page.id, "person", "member", "view")
  const calls = { member: 0, project: 0, granted: 0 }
  const { isOrgMember, hasProjectAccess } = f.access
  const granted = f.access.sharing!.granted
  f.access.isOrgMember = async (...args) => (calls.member++, await isOrgMember(...args))
  f.access.hasProjectAccess = async (...args) => (calls.project++, await hasProjectAccess(...args))
  f.access.sharing = { ...f.access.sharing!, granted: async (...args) => (calls.granted++, await granted(...args)) }
  const listed = (await (await f.request("member", "/documents?project_id=project")).json()) as { id: string }[]
  expect(listed.map((row) => row.id).sort()).toEqual(
    pages
      .slice(0, 10)
      .map((page) => page.id)
      .sort(),
  )
  expect(calls).toEqual({ member: 1, project: 1, granted: 1 })
})

test("a runtime may write a hydrated page only while the job's person can still edit it", async () => {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  const env = {
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
  }
  const f = privatePagesFixture(env)
  const page = await f.create()
  const scope = {
    userId: "member",
    orgId: "org",
    projectId: "project",
    localWorkspaceId: "workspace",
    cloudWorkspaceId: "workspace",
    sessionId: "session",
  }
  const job = await mintDocumentRelayJobToken(
    { ...scope, documentId: page.id, operations: ["write"], jobExpiresAt: Math.floor(Date.now() / 1000) + 60 },
    env,
  )
  const ask = async (token: string) =>
    (
      await f.app.request(`http://control.test/documents/${page.id}/runtime-authorization`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ ...scope, operation: "write" }),
      })
    ).status
  f.share(page.id, "person", "member", "view")
  expect(await ask(job.token)).toBe(404)
  f.share(page.id, "person", "member", "edit")
  expect(await ask(job.token)).toBe(204)
  expect(await ask(`${job.token}x`)).toBe(404)
  f.members.delete("member")
  expect(await ask(job.token)).toBe(404)
})
