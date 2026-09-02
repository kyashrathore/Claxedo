import { afterEach, describe, expect, test } from "bun:test"
import {
  controlPlaneCatalogProjects,
  mergeWorkspaceCatalog,
  workspaceCatalogQuery,
} from "./workspace-catalog"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"

describe("controlPlaneCatalogProjects", () => {
  test("builds synthetic project refs from signed user-hosted workspaces", () => {
    expect(controlPlaneCatalogProjects({
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
    expect(mergeWorkspaceCatalog([
      {
        id: "proj_1",
        name: "Local Repo",
        worktree: "/Users/me/repo",
        sandboxes: [],
        time: { created: 5, updated: 5 },
      },
    ], controlPlaneCatalogProjects({
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

  test("a signed echo of a locally shared workspace annotates nothing and replaces nothing", () => {
    // Sharing a LOCAL workspace registers it at the control plane under the
    // SAME id; the next signed snapshot echoes it back with `/workspace` as a
    // placeholder directory. The echo must not shadow the local entry, add a
    // phantom sandbox, or materialize a duplicate project.
    const local = [{
      id: "15e0fa38-1992-4636-bb60-665a57cd43df",
      name: "opencode",
      worktree: "/Users/me/opencode",
      sandboxes: ["/Users/me/opencode"],
      time: { created: 5, updated: 5 },
      workspaces: {
        "/Users/me/opencode": {
          id: "15e0fa38-1992-4636-bb60-665a57cd43df",
          kind: "local",
          directory: "/Users/me/opencode",
        },
      },
    }]
    const echo = controlPlaneCatalogProjects({
      workspaces: [{
        workspace_id: "15e0fa38-1992-4636-bb60-665a57cd43df",
        display_name: "opencode",
        access: "user-hosted",
        created_at: 1,
        updated_at: 10,
      }],
    })

    const merged = mergeWorkspaceCatalog(local as never, echo)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      name: "opencode",
      worktree: "/Users/me/opencode",
      sandboxes: ["/Users/me/opencode"],
    })
    expect(Object.keys((merged[0] as { workspaces?: Record<string, unknown> }).workspaces ?? {}))
      .toEqual(["/Users/me/opencode"])
    expect((merged[0] as { workspaces: Record<string, { kind?: string }> }).workspaces["/Users/me/opencode"]?.kind)
      .toBe("local")
  })
})

describe("controlPlaneCatalogProjects project naming", () => {
  // `display_name` is the WORKSPACE name and the hosted create dialog posts
  // `workspaceName: "main"`, so preferring it named every hosted cloud PROJECT
  // "main"; with no name the composer fell through to the directory basename,
  // and hosted cloud workspaces live in the literal directory "/workspace".
  test("names a hosted cloud project after its repo, not the workspace name", () => {
    const [project] = controlPlaneCatalogProjects({
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
    const [project] = controlPlaneCatalogProjects({
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
    const [project] = controlPlaneCatalogProjects({
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
    const [project] = controlPlaneCatalogProjects({
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
    const [project] = controlPlaneCatalogProjects({
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
    const [project] = mergeWorkspaceCatalog([
      { id: "proj_1", name: "proj_1", worktree: "/workspace", sandboxes: [], time: { created: 5, updated: 5 } },
    ], controlPlaneCatalogProjects({
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
    const [project] = mergeWorkspaceCatalog([
      { id: "proj_1", name: "Local Repo", worktree: "/Users/me/repo", sandboxes: [], time: { created: 5, updated: 5 } },
    ], controlPlaneCatalogProjects({
      workspaces: [{ workspace_id: "ws_1", project_id: "proj_1", access: "cloud", repo_url: "https://github.com/claxedo/opencode.git" }],
    }))
    expect(project?.name).toBe("Local Repo")
  })
})

const LOOPBACK = "http://127.0.0.1:3001"
const HOSTED = "https://app.claxedo.test"

function daemonClient(projects: unknown[]) {
  return { project: { list: async () => ({ data: projects as never }) } }
}

function controlPlaneFetch(rows: Record<"cloud" | "user-hosted", unknown[]>, calls: string[] = []) {
  return (async (input: URL | RequestInfo) => {
    const url = new URL(input.toString())
    calls.push(url.toString())
    const access = url.searchParams.get("access") as "cloud" | "user-hosted"
    return Response.json({ workspaces: rows[access] ?? [] })
  }) as typeof fetch
}

const userHostedRow = (workspaceId: string, input: Record<string, unknown> = {}) => ({
  workspace_id: workspaceId,
  project_id: input.project_id ?? workspaceId,
  access: "user-hosted",
  display_name: "Shared Repo",
  ...input,
})

describe("workspaceCatalogQuery", () => {
  afterEach(() => queryClient.clear())

  test("a loopback catalog merges the daemon's own workspaces with the control plane's", async () => {
    const calls: string[] = []
    const options = workspaceCatalogQuery({
      baseUrl: LOOPBACK,
      client: daemonClient([{ id: "proj_local", worktree: "/Users/me/repo", time: { created: 1, updated: 1 } }]),
      request: controlPlaneFetch({ cloud: [userHostedRow("ws_cloud", { access: "cloud", project_id: "proj_cloud" })], "user-hosted": [] }, calls),
      signedAccess: true,
    })

    const catalog = await options.queryFn()
    expect(catalog.map((project) => project.id).toSorted()).toEqual(["proj_cloud", "proj_local"])
    expect(calls.toSorted()).toEqual([
      `${LOOPBACK}/api/workspace?access=cloud`,
      `${LOOPBACK}/api/workspace?access=user-hosted`,
    ])
  })

  test("a workspace this machine both serves and publishes is one local row", async () => {
    const workspaceId = "15e0fa38-1992-4636-bb60-665a57cd43df"
    const options = workspaceCatalogQuery({
      baseUrl: LOOPBACK,
      client: daemonClient([{
        id: "proj_local",
        name: "opencode",
        worktree: "/Users/me/opencode",
        sandboxes: ["/Users/me/opencode"],
        time: { created: 1, updated: 1 },
        workspaces: {
          "/Users/me/opencode": { id: workspaceId, kind: "local", directory: "/Users/me/opencode" },
        },
      }]),
      request: controlPlaneFetch({ cloud: [], "user-hosted": [userHostedRow(workspaceId, { project_id: "proj_local" })] }),
      signedAccess: true,
    })

    const catalog = await options.queryFn()
    expect(catalog).toHaveLength(1)
    const workspaces = (catalog[0] as { workspaces?: Record<string, { kind?: string }> }).workspaces ?? {}
    expect(Object.keys(workspaces)).toEqual(["/Users/me/opencode"])
    expect(workspaces["/Users/me/opencode"]?.kind).toBe("local")
  })

  test("an unreachable control plane never erases the workspaces the daemon serves", async () => {
    const options = workspaceCatalogQuery({
      baseUrl: LOOPBACK,
      client: daemonClient([{ id: "proj_local", worktree: "/Users/me/repo", time: { created: 1, updated: 1 } }]),
      request: (async () => new Response("gone", { status: 503 })) as typeof fetch,
      signedAccess: true,
    })

    expect((await options.queryFn()).map((project) => project.id)).toEqual(["proj_local"])
  })

  test("the hosted web reads the control plane alone and never the daemon's project route", async () => {
    let daemonCalls = 0
    const options = workspaceCatalogQuery({
      baseUrl: HOSTED,
      client: {
        project: {
          list: async () => {
            daemonCalls++
            return { data: [] as never }
          },
        },
      },
      request: controlPlaneFetch({ cloud: [], "user-hosted": [userHostedRow("ws_shared", { role: "viewer", status: "offline" })] }),
      signedAccess: true,
    })

    const catalog = await options.queryFn()
    expect(daemonCalls).toBe(0)
    const entry = (catalog[0] as { workspaces: Record<string, { role?: string; status?: string; kind?: string }> })
      .workspaces["workspace:ws_shared"]
    // Role and host state come from the control plane, so the rail can render
    // "viewer · offline" for a workspace no pane has opened.
    expect(entry).toMatchObject({ kind: "user-hosted", role: "viewer", status: "offline" })
  })

  test("an unsigned surface reports the control plane's failure instead of an empty catalog", async () => {
    const options = workspaceCatalogQuery({
      baseUrl: HOSTED,
      client: daemonClient([]),
      request: (async () => new Response("nope", { status: 500 })) as typeof fetch,
      signedAccess: true,
    })

    await expect(options.queryFn()).rejects.toThrow(/workspace list failed with 500/)
  })

  test("an empty refetch never replaces a populated catalog", () => {
    const populated = [{ id: "proj_1", worktree: "/Users/me/repo", time: { created: 1, updated: 1 } }]
    expect(workspaceCatalogQuery({
      baseUrl: LOOPBACK,
      client: daemonClient([]),
      signedAccess: false,
    }).structuralSharing(populated, [])).toEqual(populated)
  })

  test("a real replacement still lands", () => {
    const populated = [{ id: "proj_1", worktree: "/Users/me/repo", time: { created: 1, updated: 1 } }]
    const next = [{ id: "proj_2", worktree: "/Users/me/other", time: { created: 1, updated: 1 } }]
    expect(workspaceCatalogQuery({
      baseUrl: LOOPBACK,
      client: daemonClient([]),
      signedAccess: false,
    }).structuralSharing(populated, next)).toEqual(next)
  })

  test("the catalog owns the rail's query key", () => {
    expect(workspaceCatalogQuery({ baseUrl: LOOPBACK, client: daemonClient([]), signedAccess: false }).queryKey)
      .toEqual(queryKeys.controlPlane.projects(LOOPBACK))
  })
})
