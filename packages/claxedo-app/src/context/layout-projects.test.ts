import { describe, expect, test } from "bun:test"
import {
  canAutoOpenProject,
  planProjectColorAssignment,
  projectCatalog,
  resolveRoot,
  resolveSandboxRootActions,
  sandboxRoots,
  sidebarProjectsMissingFromApi,
  syncApiProjectsToSidebar,
} from "./layout-projects"
import { validProjectRef } from "@claxedo/utils/worktree"
import type { Project } from "@opencode-ai/sdk/v2"

function project(input: Pick<Project, "id" | "worktree"> & Partial<Project>): Project {
  return {
    time: { created: 1, updated: 1 },
    sandboxes: [],
    ...input,
  }
}

describe("layout project catalog", () => {
  test("resolves sandbox directories to their root project", () => {
    const roots = sandboxRoots([
      project({
        id: "proj_a",
        worktree: "/projects/a",
        sandboxes: ["/projects/a/sb-1", "/projects/a/sb-2"],
      }),
    ])

    expect(resolveRoot(roots, "/projects/a")).toBe("/projects/a")
    expect(resolveRoot(roots, "/projects/a/sb-1")).toBe("/projects/a")
    expect(resolveRoot(roots, "/projects/a/sb-2")).toBe("/projects/a")
  })

  test("keeps sidebar order while appending API projects that are not in local UI state", () => {
    const catalog = projectCatalog({
      api: [
        project({
          id: "proj_a",
          worktree: "/projects/a",
        }),
        project({
          id: "proj_b",
          worktree: "/projects/b",
        }),
      ],
      current: [{ worktree: "/projects/a", expanded: false }],
      closed: () => false,
      valid: () => true,
    })

    expect(catalog.list).toEqual([
      { worktree: "/projects/a", expanded: false },
      { worktree: "/projects/b", expanded: true },
    ])
  })

  test("dedupes sandbox entries to a single root project", () => {
    const catalog = projectCatalog({
      api: [
        project({
          id: "proj_a",
          worktree: "/projects/a",
          sandboxes: ["/projects/a/sb-1"],
        }),
      ],
      current: [
        { worktree: "/projects/a/sb-1", expanded: true },
        { worktree: "/projects/a", expanded: false },
      ],
      closed: () => false,
      valid: () => true,
    })

    expect(catalog.list).toEqual([{ worktree: "/projects/a", expanded: true }])
  })

  test("does not re-add API projects the user explicitly closed", () => {
    const catalog = projectCatalog({
      api: [
        project({
          id: "proj_a",
          worktree: "/projects/a",
        }),
      ],
      current: [],
      closed: (directory) => directory === "/projects/a",
      valid: () => true,
    })

    expect(catalog.list).toEqual([])
  })

  test("does not surface local-only roots that are missing from the API catalog", () => {
    const catalog = projectCatalog({
      api: [
        project({
          id: "proj_a",
          worktree: "/projects/a",
        }),
      ],
      current: [
        { worktree: "/projects/a", expanded: true },
        { worktree: "/projects/ghost", expanded: true },
      ],
      closed: () => false,
      valid: () => true,
    })

    expect(catalog.list).toEqual([{ worktree: "/projects/a", expanded: true }])
  })

  test("surfaces signed workspace references from the API catalog", () => {
    const catalog = projectCatalog({
      api: [
        project({
          id: "proj_signed",
          worktree: "workspace:ws_signed",
          sandboxes: ["workspace:ws_signed"],
        }),
      ],
      current: [],
      closed: () => false,
      valid: validProjectRef,
    })

    expect(catalog.list).toEqual([{ worktree: "workspace:ws_signed", expanded: true }])
    expect(catalog.meta.get("workspace:ws_signed")?.id).toBe("proj_signed")
  })

  test("does not auto-open a closed sandbox root", () => {
    expect(canAutoOpenProject({
      api: [
        project({
          id: "proj_a",
          worktree: "/projects/a",
          sandboxes: ["/projects/a/sb-1"],
        }),
      ],
      list: [],
      dir: "/projects/a/sb-1",
      closed: (directory) => directory === "/projects/a",
    })).toBe(false)
  })

  test("auto-opens when the workspace is missing and not closed", () => {
    expect(canAutoOpenProject({
      api: [
        project({
          id: "proj_a",
          worktree: "/projects/a",
          sandboxes: ["/projects/a/sb-1"],
        }),
      ],
      list: [],
      dir: "/projects/a/sb-1",
      closed: () => false,
    })).toBe(true)
  })

  test("can reopen the active routed workspace even when the project was previously closed", () => {
    expect(canAutoOpenProject({
      api: [
        project({
          id: "proj_a",
          worktree: "/projects/a",
          sandboxes: ["/projects/a/sb-1"],
        }),
      ],
      list: [],
      dir: "/projects/a/sb-1",
      closed: (directory) => directory === "/projects/a",
      ignoreClosed: true,
    })).toBe(true)
  })

  test("drops worktrees the validity predicate rejects from both the list and meta", () => {
    const catalog = projectCatalog({
      api: [
        project({ id: "proj_ok", worktree: "/projects/ok" }),
        project({ id: "proj_bad", worktree: "relative/path" }),
      ],
      current: [],
      closed: () => false,
      valid: (directory) => directory.startsWith("/"),
    })

    expect(catalog.list).toEqual([{ worktree: "/projects/ok", expanded: true }])
    expect([...catalog.meta.keys()]).toEqual(["/projects/ok"])
  })

  test("rejects the /workspace container root even when the validity predicate allows it", () => {
    const catalog = projectCatalog({
      api: [
        project({ id: "proj_real", worktree: "/projects/real" }),
        project({ id: "proj_container", worktree: "/workspace" }),
      ],
      current: [],
      closed: () => false,
      valid: () => true,
    })

    expect(catalog.list).toEqual([{ worktree: "/projects/real", expanded: true }])
    expect(catalog.meta.has("/workspace")).toBe(false)
  })

  test("preserves the raw per-workspace metadata field on the catalog meta entry", () => {
    // listProjects() attaches a `workspaces` record that is not part of the SDK
    // Project type; projectCatalog must carry that extra JSON through untouched
    // so the sidebar can read per-workspace kind/name.
    const workspaces = {
      "/projects/a": { kind: "local", workspace_name: "main" },
      "workspace:ws_cloud": { kind: "cloud", workspace_name: "main" },
    }
    const apiProject = {
      id: "proj_a",
      worktree: "/projects/a",
      sandboxes: ["workspace:ws_cloud"],
      time: { created: 1, updated: 1 },
      workspaces,
    }

    const catalog = projectCatalog({ api: [apiProject], current: [], closed: () => false, valid: () => true })
    const meta = catalog.meta.get("/projects/a") as { workspaces?: typeof workspaces } | undefined
    expect(meta?.workspaces).toEqual(workspaces)
  })

  test("does not auto-open without a target directory", () => {
    expect(canAutoOpenProject({ api: [], list: [], dir: undefined, closed: () => false })).toBe(false)
  })

  test("does not auto-open a directory already shown as a sidebar project", () => {
    expect(
      canAutoOpenProject({
        api: [],
        list: [{ worktree: "/projects/a", sandboxes: [] }],
        dir: "/projects/a",
        closed: () => false,
      }),
    ).toBe(false)
  })

  test("does not auto-open a directory already shown as a sandbox of a sidebar project", () => {
    expect(
      canAutoOpenProject({
        api: [],
        list: [{ worktree: "/projects/a", sandboxes: ["/projects/a/sb-1"] }],
        dir: "/projects/a/sb-1",
        closed: () => false,
      }),
    ).toBe(false)
  })

  test("auto-opens a brand-new directory unknown to both the API and the sidebar", () => {
    expect(canAutoOpenProject({ api: [], list: [], dir: "/projects/new", closed: () => false })).toBe(true)
  })
})

// These four functions are the decision cores of the four createEffect blocks
// in context/layout.tsx that used to hold this logic inline (audit gap: "the
// two createEffect blocks inside layout.tsx have no direct test").

describe("resolveSandboxRootActions (layout Effect 1)", () => {
  const rootFor = (dir: string) => (dir === "/p/a/sb-1" || dir === "/p/a/sb-2" ? "/p/a" : dir)

  test("collapses a sandbox worktree into its root: removes the sandbox and opens the root once", () => {
    const actions = resolveSandboxRootActions({
      projects: [{ worktree: "/p/a/sb-1", expanded: false }],
      rootFor,
      valid: () => true,
    })
    expect(actions).toEqual({ removals: ["/p/a/sb-1"], opens: ["/p/a"], expands: [] })
  })

  test("does not re-open the root when it is already a sidebar project", () => {
    const actions = resolveSandboxRootActions({
      projects: [
        { worktree: "/p/a", expanded: false },
        { worktree: "/p/a/sb-1", expanded: true },
      ],
      rootFor,
      valid: () => true,
    })
    // root /p/a is already present → not re-opened; sandbox removed and its root expanded
    expect(actions).toEqual({ removals: ["/p/a/sb-1"], opens: [], expands: ["/p/a"] })
  })

  test("opens the shared root only once for two sandboxes of the same project", () => {
    const actions = resolveSandboxRootActions({
      projects: [
        { worktree: "/p/a/sb-1", expanded: false },
        { worktree: "/p/a/sb-2", expanded: false },
      ],
      rootFor,
      valid: () => true,
    })
    expect(actions.opens).toEqual(["/p/a"])
    expect(actions.removals).toEqual(["/p/a/sb-1", "/p/a/sb-2"])
  })

  test("removes the sandbox but skips opening an invalid root", () => {
    const actions = resolveSandboxRootActions({
      projects: [{ worktree: "/p/a/sb-1", expanded: false }],
      rootFor,
      valid: (dir) => dir !== "/p/a",
    })
    expect(actions).toEqual({ removals: ["/p/a/sb-1"], opens: [], expands: [] })
  })

  test("leaves a plain root project untouched", () => {
    const actions = resolveSandboxRootActions({
      projects: [{ worktree: "/p/a", expanded: true }],
      rootFor,
      valid: () => true,
    })
    expect(actions).toEqual({ removals: [], opens: [], expands: [] })
  })
})

describe("sidebarProjectsMissingFromApi (layout Effect 2)", () => {
  const api = (worktree: string): Project => ({
    id: worktree,
    worktree,
    time: { created: 1, updated: 1 },
    sandboxes: [],
  })

  test("returns sidebar worktrees absent from the API catalog", () => {
    expect(
      sidebarProjectsMissingFromApi({
        sidebar: [
          { worktree: "/p/a", expanded: false },
          { worktree: "/p/ghost", expanded: false },
        ],
        api: [api("/p/a")],
      }),
    ).toEqual(["/p/ghost"])
  })

  test("returns nothing when every sidebar project is still in the API", () => {
    expect(
      sidebarProjectsMissingFromApi({
        sidebar: [{ worktree: "/p/a", expanded: false }],
        api: [api("/p/a")],
      }),
    ).toEqual([])
  })
})

describe("syncApiProjectsToSidebar", () => {
  const proj = (worktree: string, sandboxes: string[] = []): Project => ({
    id: worktree,
    worktree,
    time: { created: 1, updated: 1 },
    sandboxes,
  })

  test("appends API worktrees the sidebar has not shown yet, keeping existing order", () => {
    expect(
      syncApiProjectsToSidebar({
        api: [proj("/p/a"), proj("/p/b")],
        sidebar: ["/p/a"],
        isClosed: () => false,
        valid: () => true,
      }),
    ).toEqual(["/p/a", "/p/b"])
  })

  test("never surfaces a sandbox directory as its own project", () => {
    expect(
      syncApiProjectsToSidebar({
        api: [proj("/p/a", ["/p/a/sb-1"])],
        sidebar: [],
        isClosed: () => false,
        valid: () => true,
      }),
    ).toEqual(["/p/a"])
  })

  test("skips API projects the user explicitly closed", () => {
    expect(
      syncApiProjectsToSidebar({
        api: [proj("/p/a"), proj("/p/b")],
        sidebar: [],
        isClosed: (dir) => dir === "/p/b",
        valid: () => true,
      }),
    ).toEqual(["/p/a"])
  })

  test("returns undefined when the sidebar already matches the API order", () => {
    expect(
      syncApiProjectsToSidebar({
        api: [proj("/p/a")],
        sidebar: ["/p/a"],
        isClosed: () => false,
        valid: () => true,
      }),
    ).toBeUndefined()
  })
})

describe("planProjectColorAssignment", () => {
  test("assigns a fresh color and schedules a remote update for a real project", () => {
    const colorRequested = new Map<string, string>()
    const plan = planProjectColorAssignment({
      projects: [{ worktree: "/p/a", id: "proj_a" }],
      colors: {},
      colorRequested,
      pick: () => "mint",
      isSigned: () => false,
    })
    expect(plan.assignments).toEqual([{ worktree: "/p/a", color: "mint" }])
    expect(plan.remoteUpdates).toEqual([{ worktree: "/p/a", id: "proj_a", color: "mint" }])
    expect(plan.metaUpserts).toEqual([])
    expect(colorRequested.get("/p/a")).toBe("mint")
  })

  test("routes global/signed workspaces through project-meta instead of a remote update", () => {
    const plan = planProjectColorAssignment({
      projects: [{ worktree: "/p/a", id: "global" }],
      colors: {},
      colorRequested: new Map(),
      pick: () => "cyan",
      isSigned: (worktree) => worktree === "/p/a",
    })
    expect(plan.metaUpserts).toEqual([{ worktree: "/p/a", color: "cyan" }])
    expect(plan.remoteUpdates).toEqual([])
  })

  test("does not re-push a color already requested for that worktree", () => {
    const colorRequested = new Map<string, string>([["/p/a", "mint"]])
    const plan = planProjectColorAssignment({
      projects: [{ worktree: "/p/a", id: "proj_a" }],
      colors: { "/p/a": "mint" },
      colorRequested,
      pick: () => "orange",
      isSigned: () => false,
    })
    // existing color reused, requested color unchanged → no assignment, no remote push
    expect(plan.assignments).toEqual([])
    expect(plan.remoteUpdates).toEqual([])
  })

  test("clears the requested color and skips a project that now carries its own icon color", () => {
    const colorRequested = new Map<string, string>([["/p/a", "mint"]])
    const plan = planProjectColorAssignment({
      projects: [{ worktree: "/p/a", id: "proj_a", icon: { color: "purple" } }],
      colors: {},
      colorRequested,
      pick: () => "mint",
      isSigned: () => false,
    })
    expect(plan.clears).toEqual(["/p/a"])
    expect(colorRequested.has("/p/a")).toBe(false)
    expect(plan.assignments).toEqual([])
    expect(plan.remoteUpdates).toEqual([])
  })

  test("assigns a color locally but does not push for an id-less project", () => {
    const plan = planProjectColorAssignment({
      projects: [{ worktree: "/p/a" }],
      colors: {},
      colorRequested: new Map(),
      pick: () => "lime",
      isSigned: () => false,
    })
    expect(plan.assignments).toEqual([{ worktree: "/p/a", color: "lime" }])
    expect(plan.remoteUpdates).toEqual([])
    expect(plan.metaUpserts).toEqual([])
  })
})
