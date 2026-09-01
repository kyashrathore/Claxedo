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
        `insert into workspaces values (?, ?, ?, ?, 'local-worktree', 'user-hosted', ?, null, null, null, null, null, ?, ?, null)`,
      )
      .bind("workspace-1", "org-1", "project-1", "user-1", "Workspace", 1, 1),
    // Enrollment (live lease, acked set) + owner assignment: the two facts
    // routing now requires, replacing the per-workspace link row.
    database
      .prepare(`insert into host_enrollments (
        enrollment_id, owner_user_id, owner_actor_id, host_id, public_key_json,
        display_name, last_seen_at, expires_at, paused_at, revoked_at,
        last_signature_hash, created_at, updated_at, acked_workspace_ids, acked_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, null, null, null, ?, ?, ?, ?)`)
      .bind("enr-1", "user-1", "actor-1", "host-1", "{}", "Laptop", 90, 200, 1, 1, '["workspace-1"]', 90),
    database
      .prepare(`insert into host_workspace_assignments (
        workspace_id, host_id, org_id, owner_user_id, owner_actor_id,
        second_device_open_at, assigned_at, updated_at
      ) values (?, ?, ?, ?, ?, null, ?, ?)`)
      .bind("workspace-1", "host-1", "org-1", "user-1", "actor-1", 1, 1),
  ])
  return database
}

describe("D1 user-hosted relay target", () => {
  test("routes only an assigned, machine-acked workspace on a live enrollment lease", async () => {
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

    // Machine consent is required: an assignment whose workspace the machine
    // has not acked in its served set is not routable.
    await db.prepare("update host_enrollments set acked_workspace_ids = '[]' where host_id = 'host-1'").run()
    await expect(resolve("workspace-1")).resolves.toEqual({ active: false })
    await db.prepare(`update host_enrollments set acked_workspace_ids = '["workspace-1"]' where host_id = 'host-1'`).run()

    // An expired lease makes the assignment inert.
    await db.prepare("update host_enrollments set expires_at = 99 where host_id = 'host-1'").run()
    await expect(resolve("workspace-1")).resolves.toEqual({ active: false })
    await db.prepare("update host_enrollments set expires_at = 200 where host_id = 'host-1'").run()

    await db.prepare("update orgs set deployment_id = 'another-deployment' where org_id = 'org-1'").run()
    await expect(resolve("workspace-1")).resolves.toEqual({ active: false })
  })
})
