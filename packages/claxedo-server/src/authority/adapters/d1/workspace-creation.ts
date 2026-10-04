import type { D1Database } from "@cloudflare/workers-types"
import type { BoundSql } from "./authorization"

export type WorkspaceCreationRow = {
  /** Repeated inside every insert, so a batch that runs after the admission changed lands nothing. */
  administers: BoundSql
  assertionId: string
  now: number
  ownerUserId: string
  workspaceId: string
  orgId: string
  projectId: string
  /** The project the caller named; null lets the repository's existing project, or the new one, take the workspace. */
  requestedProjectId: string | undefined
  repoKey: string
  displayName: string
  homeRegion: string | undefined
  remoteDirectory: string | null
  backing: "local-worktree" | "cloud-vm"
  repoUrl: string | undefined
  repoName: string | undefined
  gitBranch: string | undefined
  /** The code-host connection whose token clones this private repository; absent for a repository anyone can clone. */
  repoConnectionId: string | undefined
}

/**
 * The statements that create a workspace, and its project when the repository
 * has none, for a caller that composes them into its own batch. The batch
 * assertion proves the row landed as described.
 */
export function workspaceCreationStatements(database: D1Database, row: WorkspaceCreationRow) {
  const described = [
    row.backing,
    row.displayName,
    row.homeRegion ?? null,
    row.repoUrl ?? null,
    row.repoName ?? null,
    row.gitBranch ?? null,
    row.remoteDirectory,
    row.repoConnectionId ?? null,
  ]
  return [
    database
      .prepare(
        `
        insert into projects (project_id, org_id, repo_key, owner_user_id, created_at, updated_at, deleted_at)
        select ?, ?, ?, ?, ?, ?, null where ${row.administers.sql}
        on conflict do nothing
      `,
      )
      .bind(row.projectId, row.orgId, row.repoKey, row.ownerUserId, row.now, row.now, ...row.administers.bind),
    database
      .prepare(
        `
        insert into project_memberships (project_id, user_id, role, created_at, updated_at, revoked_at)
        select p.project_id, p.owner_user_id, 'owner', ?, ?, null from projects p
        where p.org_id = ? and p.repo_key = ? and p.owner_user_id = ? and p.deleted_at is null
        on conflict (project_id, user_id) do nothing
      `,
      )
      .bind(row.now, row.now, row.orgId, row.repoKey, row.ownerUserId),
    database
      .prepare(
        `
        insert into workspaces (
          workspace_id, org_id, project_id, owner_user_id, backing, display_name,
          home_region, repo_url, repo_name, git_branch, remote_directory, repo_connection_id,
          created_at, updated_at, deleted_at
        )
        select ?, ?, p.project_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null
        from projects p
        where p.org_id = ? and p.repo_key = ? and p.deleted_at is null
          and (? is null or p.project_id = ?)
          and ${row.administers.sql}
        on conflict (workspace_id) do nothing
      `,
      )
      .bind(
        row.workspaceId,
        row.orgId,
        row.ownerUserId,
        ...described,
        row.now,
        row.now,
        row.orgId,
        row.repoKey,
        row.requestedProjectId ?? null,
        row.requestedProjectId ?? null,
        ...row.administers.bind,
      ),
    database
      .prepare(
        `
        insert into authority_batch_assertions (assertion_id, passed)
        values (?, case when exists (
          select 1 from workspaces w join projects p on p.project_id = w.project_id and p.org_id = w.org_id
          where w.workspace_id = ? and w.org_id = ? and w.owner_user_id = ?
            and w.backing = ? and w.display_name = ?
            and w.home_region is ? and w.repo_url is ? and w.repo_name is ?
            and w.git_branch is ? and w.remote_directory is ? and w.repo_connection_id is ?
            and w.deleted_at is null
            and p.repo_key = ? and (? is null or p.project_id = ?)
        ) then 1 else 0 end)
      `,
      )
      .bind(
        row.assertionId,
        row.workspaceId,
        row.orgId,
        row.ownerUserId,
        ...described,
        row.repoKey,
        row.requestedProjectId ?? null,
        row.requestedProjectId ?? null,
      ),
    database.prepare(`delete from authority_batch_assertions where assertion_id = ?`).bind(row.assertionId),
  ]
}
