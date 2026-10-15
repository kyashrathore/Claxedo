import type { D1Database } from "@cloudflare/workers-types"
import { WORKSPACE_DIR } from "@claxedo/sandbox-manager/defaults"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import type { OriginCloudSource } from "../workspace/origin-cloud-workspace"

/**
 * What the hosted Tasks bridge reads about workspaces and sessions, from the
 * D1 rows the workspace and session authorities write. Only cloud workspaces
 * are answered: a machine's workspace is served through its host tunnel,
 * which this bridge does not dispatch to.
 */
export type TasksHostReads = {
  workspace(workspaceId: string): Promise<Workspace | undefined>
  /**
   * The cloud workspaces `ownerUserId` holds in a project, without the roots
   * cloud-placement Starts allocated there: those carry the project's id in
   * D1, and counting them would make a project with one workspace look like
   * it has several.
   */
  projectWorkspaces(projectId: string, ownerUserId: string): Promise<Workspace[]>
  /** The repository and ref a project's cloud roots clone, from the oldest of its workspaces that names one. */
  projectSource(projectId: string): Promise<OriginCloudSource | undefined>
  sessionMetas(sessionIds: readonly string[]): Promise<ReadonlyMap<string, { workspaceID: string; archived?: number }>>
}

type WorkspaceRow = {
  workspace_id: string
  org_id: string
  project_id: string
  display_name: string
  repo_url: string | null
  repo_name: string | null
  git_branch: string | null
  remote_directory: string | null
  created_at: number
  updated_at: number
}

/** D1 refuses a statement with more than 100 bound parameters. */
const D1_BOUND_PARAMETERS = 100

const WORKSPACE_COLUMNS =
  "w.workspace_id, w.org_id, w.project_id, w.display_name, w.repo_url, w.repo_name, w.git_branch, w.remote_directory, w.created_at, w.updated_at"

function cloudWorkspace(row: WorkspaceRow): Workspace {
  const directory = row.remote_directory ?? WORKSPACE_DIR
  return {
    id: row.workspace_id,
    org_id: row.org_id,
    project_id: row.project_id,
    workspace_name: row.display_name,
    directory,
    kind: "cloud",
    ...(row.repo_url ? { repo_url: row.repo_url } : {}),
    ...(row.repo_name ? { repo_name: row.repo_name } : {}),
    ...(row.git_branch ? { git_branch: row.git_branch } : {}),
    remote_directory: directory,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function createD1TasksHostReads(database: D1Database): TasksHostReads {
  return {
    async workspace(workspaceId) {
      const row = await database
        .prepare(`select ${WORKSPACE_COLUMNS} from workspaces w where w.workspace_id = ? and w.backing = 'cloud-vm' and w.deleted_at is null`)
        .bind(workspaceId)
        .first<WorkspaceRow>()
      return row ? cloudWorkspace(row) : undefined
    },

    async projectWorkspaces(projectId, ownerUserId) {
      const rows = await database
        .prepare(`
          select ${WORKSPACE_COLUMNS} from workspaces w
          where w.project_id = ? and w.owner_user_id = ? and w.backing = 'cloud-vm' and w.deleted_at is null
            and not exists (
              select 1 from task_session_links link
              where link.session_workspace_id = w.workspace_id and link.placement = 'cloud'
            )
          order by w.created_at, w.workspace_id
        `)
        .bind(projectId, ownerUserId)
        .all<WorkspaceRow>()
      return rows.results.map(cloudWorkspace)
    },

    async projectSource(projectId) {
      const row = await database
        .prepare(`
          select repo_url, repo_name, git_branch from workspaces
          where project_id = ? and repo_url is not null and deleted_at is null
          order by created_at, workspace_id limit 1
        `)
        .bind(projectId)
        .first<{ repo_url: string; repo_name: string | null; git_branch: string | null }>()
      if (!row) return undefined
      return {
        repoUrl: row.repo_url,
        ...(row.git_branch ? { gitBranch: row.git_branch } : {}),
        ...(row.repo_name ? { repoName: row.repo_name } : {}),
      }
    },

    async sessionMetas(sessionIds) {
      const metas = new Map<string, { workspaceID: string; archived?: number }>()
      for (let start = 0; start < sessionIds.length; start += D1_BOUND_PARAMETERS) {
        const ids = sessionIds.slice(start, start + D1_BOUND_PARAMETERS)
        const rows = await database
          .prepare(`
            select session_id, workspace_id, archived_at from sessions
            where session_id in (${ids.map(() => "?").join(", ")}) and deleted_at is null
          `)
          .bind(...ids)
          .all<{ session_id: string; workspace_id: string; archived_at: number | null }>()
        for (const row of rows.results) {
          metas.set(row.session_id, { workspaceID: row.workspace_id, ...(row.archived_at ? { archived: row.archived_at } : {}) })
        }
      }
      return metas
    },
  }
}
