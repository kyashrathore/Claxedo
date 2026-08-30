import { describe, expect, test, vi } from "vitest"
import { migrateSessionTenantIdentity, verifySessionTenantIdentity } from "./migrations"

function context(projectId = "prj_other") {
  const patch = vi.fn()
  const workspace = { _id: "workspace_doc", org_id: "org_1", project_id: "prj_workspace", owner_user_id: "user_1" }
  const project = { _id: "project_doc", org_id: "org_1", project_id: projectId }
  return {
    patch,
    ctx: {
      db: {
        get: vi.fn(async (id: string) => id === "workspace_doc" ? workspace : undefined),
        patch,
        normalizeId: vi.fn(() => null),
        query: vi.fn(() => ({
          withIndex: vi.fn((_name, select) => {
            select({ eq: vi.fn(() => ({ eq: vi.fn() })) })
            return { unique: vi.fn(async () => project) }
          }),
        })),
      },
    },
  }
}

describe("session tenant migration", () => {
  test("stops on a same-organization project that differs from the workspace", async () => {
    const { ctx, patch } = context()
    await expect(migrateSessionTenantIdentity(ctx, {
      _id: "session_doc",
      workspace_id: "workspace_doc",
      project_id: "prj_other",
    })).rejects.toThrow("session_workspace_project_conflict:session_doc:workspace_doc:project_doc")
    expect(patch).not.toHaveBeenCalled()
  })

  test("verification rejects a session whose project differs from its workspace", async () => {
    const { ctx } = context("prj_workspace")
    await expect(verifySessionTenantIdentity(ctx, {
      _id: "session_doc",
      workspace_id: "workspace_doc",
      org_id: "org_1",
      project_id: "prj_other",
      created_by_user_id: "user_1",
    })).rejects.toThrow("session_workspace_identity_mismatch")
  })
})
