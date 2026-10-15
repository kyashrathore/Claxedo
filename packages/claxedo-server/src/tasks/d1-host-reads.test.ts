import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { D1Database } from "@cloudflare/workers-types"
import { miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../test-support/control-plane-migrations"
import { createD1TasksHostReads } from "./d1-host-reads"

let instance: ControlPlaneDatabase
let database: D1Database

type Row = { id: string; owner: string; backing?: "cloud-vm" | "local-worktree"; created: number; repoUrl?: string; deleted?: boolean }

const workspace = (row: Row) =>
  database
    .prepare(`insert into workspaces
      (workspace_id, org_id, project_id, owner_user_id, backing, display_name, repo_url, git_branch, remote_directory, created_at, updated_at, deleted_at)
      values (?, 'org', 'prj', ?, ?, ?, ?, ?, '/workspace', ?, ?, ?)`)
    .bind(row.id, row.owner, row.backing ?? "cloud-vm", `name ${row.id}`, row.repoUrl ?? null, row.repoUrl ? "main" : null, row.created, row.created, row.deleted ? row.created : null)

const session = (id: string, options: { archived?: boolean; deleted?: boolean; humanTurnAt?: number } = {}) => [
  database
    .prepare(`insert into session_registration_operations
      (operation_id, session_id, workspace_id, org_id, project_id, creator_actor_id, operation_kind, state, created_at, updated_at)
      values (?, ?, 'ws_alice', 'org', 'prj', 'act_alice', 'create', 'registered', 1, 1)`)
    .bind(`op_${id}`, id),
  database
    .prepare(`insert into sessions
      (session_id, operation_id, workspace_id, org_id, project_id, creator_actor_id, lifecycle_generation, created_at, updated_at, archived_at, deleted_at, last_human_turn_at)
      values (?, ?, 'ws_alice', 'org', 'prj', 'act_alice', 1, 1, 1, ?, ?, ?)`)
    .bind(id, `op_${id}`, options.archived ? 5 : null, options.deleted ? 6 : null, options.humanTurnAt ?? null),
]

beforeAll(async () => {
  instance = await miniflareControlPlaneDatabase()
  database = instance.database
  const sessionIds = Array.from({ length: 130 }, (_, index) => `ses_${String(index).padStart(3, "0")}`)
  await database.batch([
    database.prepare("insert into users values ('alice', 'active', 1, 1, null, null), ('bob', 'active', 1, 1, null, null)"),
    database.prepare("insert into actors (actor_id, user_id, kind, state, created_at, updated_at) values ('act_alice', 'alice', 'human', 'active', 1, 1)"),
    database.prepare("insert into orgs (org_id, name, kind, owner_user_id, deployment_id, created_at, updated_at, deleted_at) values ('org', 'Org', 'deployment', 'alice', 'deployment-1', 1, 1, null)"),
    database.prepare("insert into projects values ('prj', 'org', 'repo:importer', 'alice', 1, 1, null)"),
    workspace({ id: "ws_gone", owner: "alice", created: 1, repoUrl: "https://github.com/acme/old.git", deleted: true }),
    workspace({ id: "ws_alice", owner: "alice", created: 2, repoUrl: "https://github.com/acme/importer.git" }),
    workspace({ id: "ws_alice_second", owner: "alice", created: 3 }),
    workspace({ id: "ws_bob", owner: "bob", created: 4, repoUrl: "https://github.com/acme/importer.git" }),
    workspace({ id: "ws_machine", owner: "alice", backing: "local-worktree", created: 5 }),
    workspace({ id: "ws_task_root", owner: "alice", created: 6, repoUrl: "https://github.com/acme/importer.git" }),
    database.prepare(`insert into task_session_links
      (scope_id, task_id, slot, attempt, session_id, session_workspace_id, preset_id, preset_revision, preset_name_at_start, configuration_digest, created_at, placement)
      values ('org', 'tsk_1', 'primary', 1, 'ses_root', 'ws_task_root', 'tpr_1', 1, 'Cloud', 'digest', 1, 'cloud')`),
    ...sessionIds.flatMap((id) => session(id)),
    ...session("ses_archived", { archived: true }),
    ...session("ses_deleted", { deleted: true }),
    ...session("ses_turned", { humanTurnAt: 7 }),
  ])
})

afterAll(async () => {
  await instance?.dispose()
})

describe("the hosted Tasks host's D1 reads", () => {
  test("answers a live cloud workspace by id, and no machine or deleted one", async () => {
    const reads = createD1TasksHostReads(database)
    expect(await reads.workspace("ws_alice")).toEqual({
      id: "ws_alice",
      org_id: "org",
      project_id: "prj",
      workspace_name: "name ws_alice",
      directory: "/workspace",
      kind: "cloud",
      repo_url: "https://github.com/acme/importer.git",
      git_branch: "main",
      remote_directory: "/workspace",
      created_at: 2,
      updated_at: 2,
    })
    expect(await reads.workspace("ws_machine")).toBeUndefined()
    expect(await reads.workspace("ws_gone")).toBeUndefined()
    expect(await reads.workspace("ws_task_root")).toMatchObject({ id: "ws_task_root" })
  })

  test("lists a person's own cloud workspaces in a project, oldest first, without a cloud task's root", async () => {
    const reads = createD1TasksHostReads(database)
    expect((await reads.projectWorkspaces("prj", "alice")).map((row) => row.id)).toEqual(["ws_alice", "ws_alice_second"])
    expect((await reads.projectWorkspaces("prj", "bob")).map((row) => row.id)).toEqual(["ws_bob"])
    expect(await reads.projectWorkspaces("prj", "carol")).toEqual([])
  })

  test("takes a project's source from its oldest live workspace that names a remote", async () => {
    const reads = createD1TasksHostReads(database)
    expect(await reads.projectSource("prj")).toEqual({ repoUrl: "https://github.com/acme/importer.git", gitBranch: "main" })
    expect(await reads.projectSource("prj_none")).toBeUndefined()
  })

  test("reads every registered session asked about, past D1's bound-parameter limit, with archived ones and a person's last turn marked and deleted ones absent", async () => {
    const reads = createD1TasksHostReads(database)
    const ids = [...Array.from({ length: 130 }, (_, index) => `ses_${String(index).padStart(3, "0")}`), "ses_archived", "ses_deleted", "ses_turned", "ses_never"]
    const metas = await reads.sessions(ids)
    expect(metas.size).toBe(132)
    expect(metas.get("ses_129")).toEqual({ workspaceID: "ws_alice" })
    expect(metas.get("ses_archived")).toEqual({ workspaceID: "ws_alice", archived: 5 })
    expect(metas.get("ses_turned")).toEqual({ workspaceID: "ws_alice", lastHumanTurnAt: 7 })
    expect(metas.has("ses_deleted")).toBe(false)
    expect(metas.has("ses_never")).toBe(false)
    expect(await reads.sessions([])).toEqual(new Map())
  })
})
