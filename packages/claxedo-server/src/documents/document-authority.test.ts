import { expect, test, vi } from "vitest"
import type { D1AccessContext } from "../authority/adapters/d1/access-context"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import type { DocumentsBackend } from "@claxedo/server-core/documents/backend"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { d1DocumentAccess } from "../authority/adapters/d1/document-authority"

function fixture() {
  const context = {
    database: {
      prepare: () => ({
        bind: () => ({ all: async () => ({ results: [{ org_id: "elsewhere" }, { org_id: "deployment" }] }) }),
      }),
    },
    now: Date.now,
    principal: async () => ({ userId: "creator", actorId: "creator" }),
    assertOrganizationAllowed(orgId: string) {
      if (orgId !== "deployment")
        throw new ClaxedoError({ code: "organization_policy_denied", message: "Organization denied", status: 403 })
    },
  } as unknown as D1AccessContext
  const entry = { id: "page", org_id: "deployment", project_id: "project", creator_id: "creator", archived_at: null }
  const find = vi.fn(async (orgId: string) => (orgId === "deployment" ? entry : undefined))
  const access = d1DocumentAccess(context, { find } as unknown as DocumentsBackend["index"])
  return { access, entry, find }
}

test("document lookup skips organizations outside a user-deployed product's scope", async () => {
  const f = fixture()
  expect(await f.access.locateDocument("creator", "page")).toEqual(f.entry)
  expect(f.find.mock.calls).toEqual([["deployment", "page"]])
})

test("an explicit organization policy denial does not reveal document existence", async () => {
  const f = fixture()
  await expect(f.access.principal({} as SignedControlPlaneAuth, "elsewhere")).rejects.toMatchObject({
    code: "document_not_found",
    status: 404,
  })
})
