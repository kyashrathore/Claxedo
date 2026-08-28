import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { convexTest } from "convex-test"
import { api } from "./_generated/api"
import schema from "./schema"

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>
  }
}

const modules = import.meta.glob("./**/*.ts")

/**
 * workGraphProject project reuse: a second workspace for the SAME repository
 * must join the existing project no matter how the repo URL is spelled —
 * connected repos persist GitHub's `.git`-suffixed clone_url while the
 * paste-a-URL path stores what was typed, and exact-string matching used to
 * mint a duplicate project per spelling.
 */
const prevServiceToken = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN

beforeEach(() => {
  process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "svc_secret"
})

afterEach(() => {
  if (prevServiceToken === undefined) {
    delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
    return
  }
  process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = prevServiceToken
})

const SVC = { service_token: "svc_secret" }

async function seedOwner(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      token_identifier: "issuer|clerk-solo",
      clerk_subject: "clerk-solo",
      created_at: 1,
      updated_at: 1,
    })
    const orgId = await ctx.db.insert("orgs", {
      name: "Personal",
      kind: "personal",
      owner_user_id: userId,
      created_at: 1,
      updated_at: 1,
    })
    await ctx.db.insert("org_memberships", {
      org_id: orgId,
      user_id: userId,
      role: "owner",
      created_at: 1,
      updated_at: 1,
    })
    return { userId, orgId }
  })
}

describe("ensureWorkGraph repo-key project reuse", () => {
  test("same repo, different URL spellings, one project", async () => {
    const t = convexTest(schema, modules)
    const { userId, orgId } = await seedOwner(t)

    const first = await t.mutation(api.workspaces.ensureWorkGraph, {
      ...SVC,
      organization_id: orgId,
      owner_user_id: userId,
      workspace_id: "ws_https",
      repo_url: "https://github.com/octocat/repo",
    })
    const variants = [
      "https://github.com/octocat/repo.git",
      "https://github.com/octocat/repo/",
      "git@github.com:octocat/repo.git",
      "ssh://git@github.com/octocat/repo.git",
    ]
    for (const [index, repoUrl] of variants.entries()) {
      const next = await t.mutation(api.workspaces.ensureWorkGraph, {
        ...SVC,
        organization_id: orgId,
        owner_user_id: userId,
        workspace_id: `ws_variant_${index}`,
        repo_url: repoUrl,
      })
      expect(next.project_id).toBe(first.project_id)
    }
    expect(first.project_id).toMatch(/^prj_/)
  })

  test("different repos get different projects", async () => {
    const t = convexTest(schema, modules)
    const { userId, orgId } = await seedOwner(t)

    const first = await t.mutation(api.workspaces.ensureWorkGraph, {
      ...SVC,
      organization_id: orgId,
      owner_user_id: userId,
      workspace_id: "ws_one",
      repo_url: "https://github.com/octocat/repo-one",
    })
    const second = await t.mutation(api.workspaces.ensureWorkGraph, {
      ...SVC,
      organization_id: orgId,
      owner_user_id: userId,
      workspace_id: "ws_two",
      repo_url: "https://github.com/octocat/repo-two",
    })
    expect(second.project_id).not.toBe(first.project_id)
  })
})

describe("CLI service workspace authority", () => {
  const serviceUser = {
    token_identifier: "issuer|clerk-solo",
    subject: "clerk-solo",
    issuer: "issuer",
  }

  test("registers and lists through the canonical service entrypoints with tenant metadata", async () => {
    const t = convexTest(schema, modules)
    const { orgId } = await seedOwner(t)

    await t.mutation(api.workspaces.registerLocalForSharingForService, {
      ...SVC,
      user: serviceUser,
      workspace_id: "ws_cli",
      org_id: orgId,
      project_id: "prj_cli",
      display_name: "CLI workspace",
      repo_url: "https://github.com/acme/cli.git",
    })

    await expect(t.query(api.workspaces.listForService, {
      ...SVC,
      user: serviceUser,
    })).resolves.toEqual([
      expect.objectContaining({
        workspace_id: "ws_cli",
        org_id: orgId,
        project_id: "prj_cli",
        role: "owner",
        backing: "local-worktree",
        access: "user-hosted",
      }),
    ])
  })

  test("does not let a service-projected CLI user re-register another user's workspace", async () => {
    const t = convexTest(schema, modules)
    await seedOwner(t)
    await t.run(async (ctx) => {
      const other = await ctx.db.insert("users", {
        token_identifier: "issuer|other",
        created_at: 1,
        updated_at: 1,
      })
      const otherOrg = await ctx.db.insert("orgs", {
        name: "Other org",
        kind: "personal",
        owner_user_id: other,
        created_at: 1,
        updated_at: 1,
      })
      await ctx.db.insert("workspaces", {
        workspace_id: "ws_other",
        org_id: otherOrg,
        owner_user_id: other,
        backing: "local-worktree",
        access: "user-hosted",
        display_name: "Other",
        created_at: 1,
        updated_at: 1,
      })
    })

    await expect(t.mutation(api.workspaces.registerLocalForSharingForService, {
      ...SVC,
      user: serviceUser,
      workspace_id: "ws_other",
      display_name: "Hijacked",
    })).rejects.toThrow("Workspace not found")
  })
})
