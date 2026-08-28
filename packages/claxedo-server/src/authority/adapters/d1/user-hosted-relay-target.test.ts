import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"

import { createD1UserHostedTargetResolver } from "./user-hosted-relay-target"

const MIGRATIONS = [
  "0002_workspace_authority.sql",
  "0003_private_sessions.sql",
  "0004_host_access_and_sharing.sql",
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
    database
      .prepare(`insert into local_host_links values (?, ?, ?, ?, ?, ?, ?, null, ?, ?, null, null, null, null, ?, ?)`)
      .bind("workspace-1", "org-1", "project-1", "host-1", "user-1", "actor-1", "{}", 90, 200, 1, 1),
  ])
  return database
}

describe("D1 user-hosted relay target", () => {
  test("returns only a current, unpaused, unrevoked link for an authoritative user-hosted workspace", async () => {
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

    await db.prepare("update local_host_links set paused_at = 100 where workspace_id = ?").bind("workspace-1").run()
    await expect(resolve("workspace-1")).resolves.toEqual({ active: false })
    await expect(resolve("missing")).resolves.toEqual({ active: false })

    await db.prepare("update local_host_links set paused_at = null where workspace_id = ?").bind("workspace-1").run()
    await db.prepare("update orgs set deployment_id = 'another-deployment' where org_id = 'org-1'").run()
    await expect(resolve("workspace-1")).resolves.toEqual({ active: false })
  })
})
