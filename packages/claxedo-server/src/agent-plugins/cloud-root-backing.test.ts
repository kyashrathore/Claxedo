import { afterEach, describe, expect, test } from "vitest"
import type { D1Database } from "@cloudflare/workers-types"
import { controlPlaneMigrations, miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../test-support/control-plane-migrations"
import { cloudRootBacking, HostedRuntimeNotReadyError, isCloudRoot } from "./cloud-root-backing"

const active: ControlPlaneDatabase[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function database(rows: Array<{ id: string; backing: "cloud-vm" | "local-worktree"; deletedAt?: number }>): Promise<D1Database> {
  const instance = await miniflareControlPlaneDatabase(controlPlaneMigrations())
  active.push(instance)
  const db = instance.database
  await db.batch([
    db.prepare("insert into users values ('owner', 'active', 1, 1, null, null)"),
    db.prepare("insert into orgs values ('org', 'Org', 'deployment', 'owner', 'deployment-1', 1, 1, null)"),
    db.prepare("insert into projects values ('project', 'org', 'repo:one', 'owner', 1, 1, null)"),
    ...rows.map((row) => db.prepare(`insert into workspaces
      (workspace_id, org_id, project_id, owner_user_id, backing, display_name, created_at, updated_at, deleted_at)
      values (?, 'org', 'project', 'owner', ?, ?, 1, 1, ?)`)
      .bind(row.id, row.backing, row.id, row.deletedAt ?? null)),
  ])
  return instance.database
}

describe("a cloud root's recorded backing", () => {
  test("a root with no live workspace row, missing or deleted, is refused rather than prepared as a non-cloud root", async () => {
    const db = await database([{ id: "ws_deleted", backing: "cloud-vm", deletedAt: 5 }])
    for (const workspaceId of ["ws_missing", "ws_deleted"]) {
      await expect(cloudRootBacking(db, workspaceId)).rejects.toBeInstanceOf(HostedRuntimeNotReadyError)
      await expect(cloudRootBacking(db, workspaceId)).rejects.toMatchObject({ code: "workspace_runtime_not_ready" })
    }
    expect(await isCloudRoot(db, "ws_deleted")).toBe(false)
  })

  test("a cloud-vm row prepares as a cloud root, and a local worktree does not", async () => {
    const db = await database([{ id: "ws_cloud", backing: "cloud-vm" }, { id: "ws_local", backing: "local-worktree" }])
    expect(await cloudRootBacking(db, "ws_cloud")).toBe("cloud")
    expect(await isCloudRoot(db, "ws_cloud")).toBe(true)
    expect(await cloudRootBacking(db, "ws_local")).toBe("elsewhere")
    expect(await isCloudRoot(db, "ws_local")).toBe(false)
  })
})
