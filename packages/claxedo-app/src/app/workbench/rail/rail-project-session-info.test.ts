import { beforeEach, describe, expect, test } from "bun:test"
import { directorySessionCacheQueryOptions } from "../../../features/session/data/sync/queries"
import { queryClient } from "@/platform/query/query-client"
import type { ProjectItem } from "./domain-types"
import {
  createRailProjectSessionLookups,
  railProjectCaption,
  railProjectGitSessions,
  railProjectRepoName,
  railProjectWorkspaces,
  railWorktreeInfo,
  type RailSessionGitSource,
} from "./rail-project-session-info"

type RailSessionInventory = Parameters<typeof railProjectGitSessions>[0]["inventory"]

const emptyInventory: RailSessionInventory = {
  sessions: [],
  byProject: {},
  byWorkspace: {},
}

beforeEach(() => {
  queryClient.clear()
})

describe("createRailProjectSessionLookups", () => {
  test("builds the layout caption and worktree callbacks over current inventory accessors", () => {
    const project = projectItem({
      worktree: "/repo/main",
      workspaces: {
        "/repo/feature": {
          id: "feature_workspace",
          workspaceId: "runtime_feature",
          directory: "/repo/feature",
          kind: "cloud",
        },
      },
    })
    const lookup = createRailProjectSessionLookups({
      mainIsCloud: () => true,
      projects: () => [project],
      sessionInventory: () => ({
        ...emptyInventory,
        sessions: [
          session("project-session", {
            projectID: project.id,
            updated: 4,
            remote: "git@github.com:owner/live.git",
          }),
          {
            ...session("feature-session", {
              directory: "/repo/feature",
              updated: 5,
            }),
            git: { repo: "owner/feature", branch: "feature-branch" },
          },
        ],
      }),
    })

    expect(lookup.projectRepoName(project)).toBe("owner/live")
    expect(lookup.projectCaption(project)).toBe("owner/live · main")
    expect(lookup.worktreeInfo("/repo/feature")).toMatchObject({
      gitBranch: "feature-branch",
      gitRepo: "owner/feature",
      isMain: false,
      name: "feature",
      projectName: "owner/live",
    })
  })
})

describe("railProjectGitSessions", () => {
  test("collects matching sessions across inventory buckets and cached workspace directories", () => {
    const project = projectItem()
    cacheSession("/repo/main", {
      id: "cached-main",
      directory: "/repo/main",
      time: { updated: 80 },
      git: { remote: "git@github.com:owner/cached.git" },
    })
    const sessions = railProjectGitSessions({
      project,
      inventory: {
        sessions: [
          session("global-project", { projectID: "project_a", updated: 20 }),
          session("global-duplicate", { projectID: "project_a", updated: 15 }),
          session("global-duplicate", { projectID: "project_a", updated: 10 }),
          session("unrelated", { projectID: "other", directory: "/elsewhere", updated: 90 }),
        ],
        byProject: {
          other_project: [session("workspace-meta-directory", { directory: "/repo/meta", updated: 60 })],
        },
        byWorkspace: {
          workspace: { sessions: [session("workspace-runtime", { workspaceId: "runtime_ws", updated: 70 })] },
        },
      },
    })

    expect(sessions.map((item) => item.id)).toEqual([
      "cached-main",
      "workspace-runtime",
      "workspace-meta-directory",
      "global-project",
      "global-duplicate",
    ])
  })
})

describe("railProjectCaption", () => {
  test("uses the newest matching git remote and appends the folder when it differs", () => {
    const project = projectItem({ worktree: "/work/local-folder" })
    const inventory: RailSessionInventory = {
      ...emptyInventory,
      sessions: [
        session("old", {
          projectID: project.id,
          updated: 1,
          remote: "git@github.com:owner/old.git",
        }),
        session("new", {
          projectID: project.id,
          updated: 2,
          remote: "https://gitlab.com/org/new.git",
        }),
      ],
    }

    expect(railProjectRepoName({ project, inventory })).toBe("org/new")
    expect(railProjectCaption({ project, inventory })).toBe("org/new · local-folder")
  })

  test("falls back to project name or folder without duplicating equal labels", () => {
    expect(railProjectCaption({
      project: projectItem({ worktree: "/work/same", name: "same" }),
      inventory: emptyInventory,
    })).toBe("same")
    expect(railProjectCaption({
      project: projectItem({ worktree: "/work/fallback" }),
      inventory: emptyInventory,
    })).toBe("fallback")
  })
})

describe("railProjectWorkspaces", () => {
  test("adapts project workspace metadata for the rail sidebar", () => {
    expect(railProjectWorkspaces(projectItem({
      worktree: "/repo/main",
      workspaces: {
        "/repo/main": {
          id: "main_workspace",
          workspaceId: "runtime_main",
          directory: "/repo/main",
          workspace_name: "Main Cloud",
          kind: "cloud",
          available: false,
        },
        "/repo/local": {
          id: "local_workspace",
          directory: "/repo/local",
          workspace_name: "Local Feature",
          kind: "local",
        },
      },
    }), true)).toEqual([
      {
        id: "/repo/main",
        workspaceId: "runtime_main",
        workspaceName: "Main Cloud",
        directory: "/repo/main",
        name: "Main Cloud",
        isMain: true,
        projectWorktree: "/repo/main",
        isCloud: true,
        canDelete: true,
        available: false,
      },
      {
        id: "/repo/local",
        workspaceId: undefined,
        workspaceName: "Local Feature",
        directory: "/repo/local",
        name: "Local Feature",
        isMain: false,
        projectWorktree: "/repo/main",
        isCloud: false,
        canDelete: true,
        available: true,
      },
    ])
  })
})

describe("railWorktreeInfo", () => {
  test("prefers exact cached git metadata and preserves project display from project sessions", () => {
    const project = projectItem({
      workspaces: {
        "/repo/feature": {
          id: "workspace_meta",
          workspaceId: "runtime_ws",
          directory: "/repo/feature",
          kind: "cloud",
        },
      },
    })
    cacheSession("/repo/feature", {
      id: "cached-feature",
      directory: "/repo/feature",
      time: { updated: 5 },
      git: { repo: "cached/repo", branch: "cached-branch" },
    })

    expect(railWorktreeInfo({
      dir: "/repo/feature",
      projects: [project],
      inventory: {
        ...emptyInventory,
        sessions: [
          session("project-remote", {
            projectID: project.id,
            updated: 10,
            remote: "git@github.com:owner/project.git",
          }),
        ],
      },
      isCloud: true,
    })).toEqual({
      name: "feature",
      projectName: "owner/project",
      projectWorktree: "/repo/main",
      gitRepo: "cached/repo",
      gitBranch: "cached-branch",
      gitRemote: undefined,
      isMain: false,
      tooltip: "🌳 feature",
    })
  })
})

function projectItem(input?: Partial<ProjectItem>): ProjectItem {
  return {
    id: "project_a",
    worktree: "/repo/main",
    workspaces: {
      "/repo/meta": {
        id: "workspace_meta",
        workspaceId: "runtime_ws",
        directory: "/repo/meta",
        kind: "cloud",
      },
    },
    ...input,
  }
}

function session(id: string, input: {
  projectID?: string
  directory?: string
  workspaceId?: string
  updated: number
  remote?: string
}): RailSessionGitSource {
  return {
    id,
    projectID: input.projectID,
    directory: input.directory,
    workspaceId: input.workspaceId,
    time: { updated: input.updated },
    git: input.remote ? { remote: input.remote } : undefined,
  }
}

function cacheSession(directory: string, session: RailSessionGitSource) {
  queryClient.setQueryData<unknown>(directorySessionCacheQueryOptions({ directory }).queryKey, {
    at: 0,
    limit: 10,
    total: 1,
    session: [session],
  })
}
