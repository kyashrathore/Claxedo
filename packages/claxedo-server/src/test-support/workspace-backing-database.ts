import { controlPlaneMigrations, miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "./control-plane-migrations"

export type WorkspaceBackingRow = { id: string; backing: "cloud-vm" | "local-worktree"; deletedAt?: number }

/** A control-plane database whose org `org` holds one workspace row per entry, each owned by `owner`. */
export async function workspaceBackingDatabase(rows: readonly WorkspaceBackingRow[]): Promise<ControlPlaneDatabase> {
  const instance = await miniflareControlPlaneDatabase(controlPlaneMigrations())
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
  return instance
}
