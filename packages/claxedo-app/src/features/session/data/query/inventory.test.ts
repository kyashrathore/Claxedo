import { describe, expect, test } from "bun:test"
import { mapInventoryToSessions, mergeSignedInventoryProjects, signedInventoryItems, signedInventoryProjects } from "./inventory"
import type { GlobalSessionItem } from "./types"

const item = (id: string, input: Partial<GlobalSessionItem> = {}) => ({
  id,
  title: input.title ?? id,
  directory: input.directory ?? "/tmp/ws",
  projectID: input.projectID ?? "proj_1",
  tags: input.tags ?? [],
  attachments: input.attachments ?? [],
  time: input.time ?? { created: 1, updated: 1 },
  ...input,
}) satisfies GlobalSessionItem

describe("mapInventoryToSessions", () => {
  test("maps workspace inventory into id-sorted non-archived sessions", () => {
    expect(mapInventoryToSessions([
      item("ses_b", { archived: true }),
      item("ses_c", {
        parentID: "ses_a",
        lastTurn: { status: "failed", completedAt: 20, error: "provider failed", assistantMessageId: "msg_1_r" },
      }),
      item("ses_a", { title: "A" }),
    ])).toEqual([
      {
        id: "ses_a",
        title: "A",
        directory: "/tmp/ws",
        projectID: "proj_1",
        time: { created: 1, updated: 1 },
      },
      {
        id: "ses_c",
        title: "ses_c",
        directory: "/tmp/ws",
        projectID: "proj_1",
        parentID: "ses_a",
        lastTurn: { status: "failed", completedAt: 20, error: "provider failed", assistantMessageId: "msg_1_r" },
        time: { created: 1, updated: 1 },
      },
    ])
  })
})

describe("signedInventoryItems", () => {
  test("keeps user-hosted workspaces on synthetic workspace directories", () => {
    expect(signedInventoryItems({
      workspaces: [{
        workspace_id: "ws_user_hosted",
        project_id: "proj_1",
        backing: "local-worktree",
        access: "user-hosted",
      }],
      sessionsByWorkspace: {
        ws_user_hosted: [{
          session_id: "ses_1",
          title: "Shared",
          created_at: 1,
          updated_at: 2,
          lastTurn: { status: "completed", completedAt: 3, assistantMessageId: "msg_1_r" },
        }],
      },
    })).toMatchObject([{
      id: "ses_1",
      title: "Shared",
      directory: "workspace:ws_user_hosted",
      projectID: "proj_1",
      environment: {
        kind: "user-hosted",
        driver: "local-worktree",
      },
      lastTurn: { status: "completed", completedAt: 3, assistantMessageId: "msg_1_r" },
      time: { created: 1, updated: 2 },
    }])
  })
})

describe("signedInventoryProjects", () => {
  test("builds synthetic project refs from signed user-hosted workspaces", () => {
    expect(signedInventoryProjects({
      workspaces: [{
        workspace_id: "ws_user_hosted",
        project_id: "proj_1",
        display_name: "Shared Repo",
        access: "user-hosted",
        repo_url: "https://github.com/claxedo/shared.git",
        created_at: 1,
        updated_at: 2,
      }],
    })).toMatchObject([{
      id: "proj_1",
      // Repo identity, not `display_name`. `display_name` is the WORKSPACE
      // name: a project groups several workspaces ("main", "feature", …), so
      // naming the project after one of them picks whichever row happened to
      // be seen first. The repo is stable across every row of the project.
      name: "claxedo/shared",
      worktree: "workspace:ws_user_hosted",
      sandboxes: ["workspace:ws_user_hosted"],
      workspaces: {
        "workspace:ws_user_hosted": {
          id: "ws_user_hosted",
          kind: "user-hosted",
          repo_url: "https://github.com/claxedo/shared.git",
          workspace_name: "Shared Repo",
          directory: "workspace:ws_user_hosted",
        },
      },
      time: { created: 1, updated: 2 },
    }])
  })

  test("merges signed workspace refs into existing local projects by project id", () => {
    expect(mergeSignedInventoryProjects([
      {
        id: "proj_1",
        name: "Local Repo",
        worktree: "/Users/me/repo",
        sandboxes: [],
        time: { created: 5, updated: 5 },
      },
    ], signedInventoryProjects({
      workspaces: [{
        workspace_id: "ws_user_hosted",
        project_id: "proj_1",
        display_name: "Shared Repo",
        access: "user-hosted",
        created_at: 1,
        updated_at: 10,
      }],
    }))).toMatchObject([{
      id: "proj_1",
      name: "Local Repo",
      worktree: "/Users/me/repo",
      sandboxes: ["workspace:ws_user_hosted"],
      workspaces: {
        "workspace:ws_user_hosted": {
          id: "ws_user_hosted",
          kind: "user-hosted",
        },
      },
      time: { created: 1, updated: 10 },
    }])
  })
})

describe("signedInventoryProjects project naming", () => {
  // `display_name` is the WORKSPACE name and the hosted create dialog posts
  // `workspaceName: "main"`, so preferring it named every hosted cloud PROJECT
  // "main"; with no name the composer fell through to the directory basename,
  // and hosted cloud workspaces live in the literal directory "/workspace".
  test("names a hosted cloud project after its repo, not the workspace name", () => {
    const [project] = signedInventoryProjects({
      workspaces: [{
        workspace_id: "ws_1",
        project_id: "proj_1",
        display_name: "main",
        access: "cloud",
        remote_directory: "/workspace",
        repo_url: "https://github.com/claxedo/opencode.git",
      }],
    })
    expect(project?.name).toBe("claxedo/opencode")
    expect(project?.name).not.toBe("main")
  })

  test("prefers an explicit repo_name over the parsed remote", () => {
    const [project] = signedInventoryProjects({
      workspaces: [{
        workspace_id: "ws_1",
        project_id: "proj_1",
        display_name: "main",
        access: "cloud",
        repo_name: "opencode",
        repo_url: "https://github.com/other/thing.git",
      }],
    })
    expect(project?.name).toBe("opencode")
  })

  test("carries repo identity onto each workspace for client-side derivation", () => {
    const [project] = signedInventoryProjects({
      workspaces: [{
        workspace_id: "ws_1",
        project_id: "proj_1",
        access: "cloud",
        remote_directory: "/workspace",
        repo_url: "https://github.com/claxedo/opencode.git",
        repo_name: "opencode",
      }],
    })
    expect((project as { workspaces?: Record<string, unknown> }).workspaces?.["/workspace"]).toMatchObject({
      repo_url: "https://github.com/claxedo/opencode.git",
      repo_name: "opencode",
    })
  })

  // A group is opened by whichever row is seen FIRST; a bare row must not lock
  // in the raw project id as the project's name forever.
  test("a later row carrying repo identity upgrades a placeholder project name", () => {
    const [project] = signedInventoryProjects({
      workspaces: [
        { workspace_id: "ws_bare", project_id: "proj_1", access: "cloud", remote_directory: "/workspace" },
        { workspace_id: "ws_repo", project_id: "proj_1", access: "cloud", remote_directory: "/w2", repo_url: "git@github.com:claxedo/opencode.git" },
      ],
    })
    expect(project?.name).toBe("claxedo/opencode")
  })

  // Both cloud workspaces of one project must survive grouping — this is the
  // list the composer's third select offers as "pick an existing workspace".
  test("keeps every cloud workspace of a project selectable", () => {
    const [project] = signedInventoryProjects({
      workspaces: [
        { workspace_id: "ws_1", project_id: "proj_1", access: "cloud", remote_directory: "/workspace", workspace_name: "main" },
        { workspace_id: "ws_2", project_id: "proj_1", access: "cloud", remote_directory: "/workspace-2", workspace_name: "feature" },
      ],
    })
    expect(Object.keys((project as { workspaces?: Record<string, unknown> }).workspaces ?? {}))
      .toEqual(["/workspace", "/workspace-2"])
  })

  // `project.name ?? signed.name` preserved a PLACEHOLDER: both groupings fall
  // back to the raw project id, and an id is a present-but-meaningless string
  // that `??` happily keeps, so the real repo-derived name lost to it.
  test("a placeholder id-name loses to a real signed name on merge", () => {
    const [project] = mergeSignedInventoryProjects([
      { id: "proj_1", name: "proj_1", worktree: "/workspace", sandboxes: [], time: { created: 5, updated: 5 } },
    ], signedInventoryProjects({
      workspaces: [{
        workspace_id: "ws_1",
        project_id: "proj_1",
        access: "cloud",
        remote_directory: "/workspace",
        repo_url: "https://github.com/claxedo/opencode.git",
      }],
    }))
    expect(project?.name).toBe("claxedo/opencode")
  })

  test("a REAL existing name still wins over the signed one", () => {
    const [project] = mergeSignedInventoryProjects([
      { id: "proj_1", name: "Local Repo", worktree: "/Users/me/repo", sandboxes: [], time: { created: 5, updated: 5 } },
    ], signedInventoryProjects({
      workspaces: [{ workspace_id: "ws_1", project_id: "proj_1", access: "cloud", repo_url: "https://github.com/claxedo/opencode.git" }],
    }))
    expect(project?.name).toBe("Local Repo")
  })
})
