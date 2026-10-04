import { afterEach, describe, expect, test } from "vitest"
import type { D1Database } from "@cloudflare/workers-types"
import type { ControlPlaneDatabase } from "../test-support/control-plane-migrations"
import { workspaceBackingDatabase, type WorkspaceBackingRow } from "../test-support/workspace-backing-database"
import { cloudRootBacking, HostedRuntimeNotReadyError, isCloudRoot } from "./cloud-root-backing"

const active: ControlPlaneDatabase[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function database(rows: WorkspaceBackingRow[]): Promise<D1Database> {
  const instance = await workspaceBackingDatabase(rows)
  active.push(instance)
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
