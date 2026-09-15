import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"

import { createD1UserHostedTargetResolver } from "./user-hosted-relay-target"

const MIGRATIONS = [
  "0002_workspace_authority.sql",
  "0003_private_sessions.sql",
  "0004_host_access_and_sharing.sql",
  "0014_host_workspace_assignments.sql",
  "0015_drop_local_host_links.sql",
  "0016_host_session_authority.sql",
  "0028_workspace_org_member_visible.sql",
  "0029_host_connect.sql",
  "0030_workspace_host_assignment_revision.sql",
].map((name) => fileURLToPath(new URL(`../../../../migrations/control-plane/${name}`, import.meta.url)))
const active: Miniflare[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function database() {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["CONTROL_PLANE_DB"],
  })
  active.push(instance)
  const database = await instance.getD1Database("CONTROL_PLANE_DB")
  for (const migrationPath of MIGRATIONS) {
    const migration = (await readFile(migrationPath, "utf8")).replace(/^\s*--.*$/gm, "")
    for (const statement of migration
      .split(/;\s*\n\s*\n/)
      .map((part) => part.trim())
      .filter(Boolean)) {
      await database.prepare(statement).run()
    }
  }
  await database.batch([
    database.prepare("insert into users values (?, 'active', ?, ?, null, null)").bind("user-1", 1, 1),
    database.prepare("insert into actors values (?, ?, 'human', 'active', ?, ?, null)").bind("actor-1", "user-1", 1, 1),
    database
      .prepare("insert into orgs values (?, ?, 'deployment', ?, ?, ?, ?, null)")
      .bind("org-1", "Deployment", "user-1", "deployment-1", 1, 1),
    database
      .prepare("insert into projects values (?, ?, ?, ?, ?, ?, null)")
      .bind("project-1", "org-1", "repo:one", "user-1", 1, 1),
    database
      .prepare(
        `insert into workspaces (workspace_id, org_id, project_id, owner_user_id, backing, access, display_name, created_at, updated_at)
         values (?, ?, ?, ?, 'local-worktree', 'user-hosted', ?, ?, ?)`,
      )
      .bind("workspace-1", "org-1", "project-1", "user-1", "Workspace", 1, 1),
    // Enrollment (live lease) + owner assignment + the readiness row the
    // heartbeat wrote for the assignment's current revision at the
    // enrollment's current generation: the three facts routing requires.
    database
      .prepare(`insert into host_enrollments (
        enrollment_id, owner_user_id, owner_actor_id, host_id, public_key_json,
        display_name, last_seen_at, expires_at, paused_at, revoked_at,
        last_signature_hash, created_at, updated_at, acked_workspace_ids, acked_at, serving_generation
      ) values (?, ?, ?, ?, ?, ?, ?, ?, null, null, null, ?, ?, ?, ?, 2)`)
      .bind("enr-1", "user-1", "actor-1", "host-1", "{}", "Laptop", 90, 200, 1, 1, '["workspace-1"]', 90),
    database
      .prepare(`insert into host_workspace_assignments (
        workspace_id, host_id, org_id, owner_user_id, owner_actor_id,
        second_device_open_at, assigned_at, updated_at, revision
      ) values (?, ?, ?, ?, ?, null, ?, ?, 3)`)
      .bind("workspace-1", "host-1", "org-1", "user-1", "actor-1", 1, 1),
    database
      .prepare(`insert into host_assignment_readiness (workspace_id, enrollment_id, generation, revision, ready_at)
        values (?, ?, 2, 3, 90)`)
      .bind("workspace-1", "enr-1"),
  ])
  return database
}

describe("D1 user-hosted relay target", () => {
  test("routes only an assigned workspace that is ready at the current revision and generation on a live lease", async () => {
    const db = await database()
    const resolve = createD1UserHostedTargetResolver(db, {
      now: () => 100,
      deploymentId: "deployment-1",
    })
    await expect(resolve("workspace-1")).resolves.toEqual({
      active: true,
      hostId: "host-1",
      backing: "local-worktree",
    })

    await db.prepare("update host_enrollments set paused_at = 100 where host_id = 'host-1'").run()
    await expect(resolve("workspace-1")).resolves.toEqual({ active: false })
    await expect(resolve("missing")).resolves.toEqual({ active: false })
    await db.prepare("update host_enrollments set paused_at = null where host_id = 'host-1'").run()

    // Machine consent is the readiness row, and it must name the CURRENT
    // revision and generation: a re-pointed assignment and a superseded
    // instance both stop routing on the next read. The raw acked set the
    // desktop surface displays is not consulted.
    await db.prepare("update host_workspace_assignments set revision = 4 where workspace_id = 'workspace-1'").run()
    await expect(resolve("workspace-1")).resolves.toEqual({ active: false })
    await db.prepare("update host_workspace_assignments set revision = 3 where workspace_id = 'workspace-1'").run()
    await db.prepare("update host_enrollments set serving_generation = 3 where host_id = 'host-1'").run()
    await expect(resolve("workspace-1")).resolves.toEqual({ active: false })
    await db.prepare("update host_enrollments set serving_generation = 2 where host_id = 'host-1'").run()
    await db.prepare("delete from host_assignment_readiness where workspace_id = 'workspace-1'").run()
    await expect(resolve("workspace-1")).resolves.toEqual({ active: false })
    await db.prepare(`insert into host_assignment_readiness values ('workspace-1', 'enr-1', 2, 3, 90)`).run()
    await expect(resolve("workspace-1")).resolves.toMatchObject({ active: true })

    // An expired lease makes the assignment inert.
    await db.prepare("update host_enrollments set expires_at = 99 where host_id = 'host-1'").run()
    await expect(resolve("workspace-1")).resolves.toEqual({ active: false })
    await db.prepare("update host_enrollments set expires_at = 200 where host_id = 'host-1'").run()

    await db.prepare("update orgs set deployment_id = 'another-deployment' where org_id = 'org-1'").run()
    await expect(resolve("workspace-1")).resolves.toEqual({ active: false })
  })
})
