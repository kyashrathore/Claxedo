/**
 * Workspace / Project frontend integrity tests
 *
 * Tests the full frontend data pipeline from API response → display logic.
 * Fakes API responses matching the contract schema, then verifies that
 * projects, workspaces, labels, and grouping are computed correctly.
 *
 * No real server. No DOM rendering. Pure logic assertions on the functions
 * that drive the UI.
 */
import { describe, expect, test } from "bun:test"
import { getFilename } from "@opencode-ai/util/path"
import { projectCatalog, canAutoOpenProject, type ProjectState } from "../../overrides/context/layout-projects"
import type { Project } from "@opencode-ai/sdk/v2"

// ── Types inlined from rail-sidebar.tsx (avoids importing SolidJS components) ──

type WorkspaceInfo = { kind: "local" | "cloud"; workspace_name?: string; provider?: string }

type ProjectItem = {
  id: string
  worktree: string
  name?: string
  icon?: { url?: string; override?: string; color?: string }
  expanded?: boolean
  sandboxes?: string[]
  workspaces?: Record<string, WorkspaceInfo>
  commands?: { start?: string }
}

type WorkspaceItem = {
  id: string
  directory: string
  name?: string
  isMain?: boolean
  projectWorktree?: string
  isCloud?: boolean
  canDelete?: boolean
}

/** Inlined from rail-sidebar.tsx:144-149 — avoids pulling in SolidJS deps */
function parseOwnerRepo(remote: string | undefined): string | undefined {
  if (!remote) return
  const ssh = remote.match(/[:\/]([^/]+\/[^/]+?)(?:\.git)?$/)
  if (ssh?.[1]) return ssh[1]
  return
}

// ── Helpers matching the real functions in rail-layout.tsx ──────────────
//
// DRIFT RISK: These helpers mirror production logic from rail-layout.tsx
// and rail-sidebar.tsx. If those files change their workspace/project
// resolution, these mirrors must be updated. Grep for "projectWorkspaces"
// and "allWorkspaceItems" across test files if the source changes.

/** Matches projectWorkspaces() in rail-layout.tsx:546-572 */
function projectWorkspaces(project: ProjectItem, isCloud: boolean): WorkspaceItem[] {
  const mainWs = project.workspaces?.[project.worktree]
  const mainIsCloud = mainWs ? mainWs.kind === "cloud" : isCloud
  const items: WorkspaceItem[] = [
    {
      id: project.worktree,
      directory: project.worktree,
      name: "main",
      isMain: true,
      projectWorktree: project.worktree,
      isCloud: mainIsCloud,
      canDelete: mainIsCloud,
    },
  ]
  for (const sandbox of project.sandboxes ?? []) {
    if (sandbox === project.worktree) continue
    const ws = project.workspaces?.[sandbox]
    const rawName = ws?.workspace_name ?? getFilename(sandbox)
    const sbIsCloud = ws?.kind === "cloud"
    items.push({
      id: sandbox,
      directory: sandbox,
      name: sbIsCloud && rawName === "main" ? "main (cloud)" : rawName,
      projectWorktree: project.worktree,
      isCloud: sbIsCloud,
      canDelete: true,
    })
  }
  return items
}

/** Matches projectDisplayName() in rail-layout.tsx:574-576 */
function projectDisplayName(project: ProjectItem, repoName?: string): string {
  return repoName ?? project.name ?? getFilename(project.worktree)
}

/** Matches projectLabel() in rail-sidebar.tsx:243-245 */
function projectLabel(
  project: ProjectItem,
  sessionsByProject: Record<string, Array<{ git?: { remote?: string } }>>,
): string {
  const sessions = sessionsByProject[project.id]
  const remote = sessions?.find((s) => s.git?.remote)?.git?.remote
  const repoName = parseOwnerRepo(remote)
  return repoName ?? project.name ?? getFilename(project.worktree)
}

// ── Fake API data builders ─────────────────────────────────────────────

function fakeApiProject(overrides: Partial<Project> & { id: string; worktree: string }): Project {
  return {
    sandboxes: [],
    time: { created: Date.now(), updated: Date.now() },
    ...overrides,
  }
}

function fakeProjectItem(overrides: Partial<ProjectItem> & { id: string; worktree: string }): ProjectItem {
  return {
    ...overrides,
  }
}

function workspaceKey(directory: string) {
  const value = directory.replaceAll("\\", "/")
  const drive = value.match(/^([A-Za-z]:)\/+$/)
  if (drive) return `${drive[1]}/`
  if (/^\/+$/i.test(value)) return "/"
  return value.replace(/\/+$/, "")
}

function effectiveWorkspaceOrder(local: string, dirs: string[], persisted?: string[]) {
  const root = workspaceKey(local)
  const live = new Map<string, string>()

  for (const dir of dirs) {
    const key = workspaceKey(dir)
    if (key === root) continue
    if (!live.has(key)) live.set(key, dir)
  }

  if (!persisted?.length) return [local, ...live.values()]

  const result = [local]
  for (const dir of persisted) {
    const key = workspaceKey(dir)
    if (key === root) continue
    const match = live.get(key)
    if (!match) continue
    result.push(match)
    live.delete(key)
  }

  return [...result, ...live.values()]
}

function workspaceIds(input: {
  project?: { worktree: string; sandboxes?: string[] }
  activeProjectWorktree?: string
  currentDir?: string
  pending?: boolean
  order?: string[]
}) {
  const project = input.project
  if (!project) return []
  const local = project.worktree
  const dirs = [local, ...(project.sandboxes ?? [])]
  const directory = workspaceKey(input.activeProjectWorktree ?? "") === workspaceKey(project.worktree)
    ? input.currentDir
    : undefined
  const extra =
    directory &&
    workspaceKey(directory) !== workspaceKey(local) &&
    !dirs.some((item) => workspaceKey(item) === workspaceKey(directory))
      ? directory
      : undefined
  const ordered = effectiveWorkspaceOrder(local, dirs, input.order)
  if (input.pending && extra) return [local, extra, ...ordered.filter((item) => item !== local)]
  return ordered
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("parseOwnerRepo", () => {
  test("extracts owner/repo from HTTPS remote", () => {
    expect(parseOwnerRepo("https://github.com/kyashrathore/Claxedo.git")).toBe("kyashrathore/Claxedo")
  })

  test("extracts owner/repo from HTTPS remote without .git", () => {
    expect(parseOwnerRepo("https://github.com/kyashrathore/Claxedo")).toBe("kyashrathore/Claxedo")
  })

  test("extracts owner/repo from SSH remote", () => {
    expect(parseOwnerRepo("git@github.com:kyashrathore/Claxedo.git")).toBe("kyashrathore/Claxedo")
  })

  test("extracts owner/repo from SSH remote without .git", () => {
    expect(parseOwnerRepo("git@github.com:kyashrathore/Claxedo")).toBe("kyashrathore/Claxedo")
  })

  test("returns undefined for undefined input", () => {
    expect(parseOwnerRepo(undefined)).toBeUndefined()
  })

  test("returns undefined for empty string", () => {
    expect(parseOwnerRepo("")).toBeUndefined()
  })

  test("handles gitlab URLs", () => {
    expect(parseOwnerRepo("https://gitlab.com/org/project.git")).toBe("org/project")
  })
})

describe("projectDisplayName", () => {
  test("prefers repo name over project.name", () => {
    const project = fakeProjectItem({ id: "p1", worktree: "/home/user/myapp", name: "MyApp" })
    expect(projectDisplayName(project, "kyashrathore/Claxedo")).toBe("kyashrathore/Claxedo")
  })

  test("falls back to project.name when no repo name", () => {
    const project = fakeProjectItem({ id: "p1", worktree: "/home/user/myapp", name: "MyApp" })
    expect(projectDisplayName(project)).toBe("MyApp")
  })

  test("falls back to directory basename when no name", () => {
    const project = fakeProjectItem({ id: "p1", worktree: "/home/user/myapp" })
    expect(projectDisplayName(project)).toBe("myapp")
  })

  test("does not return meaningless 'workspace' for /workspace path", () => {
    const project = fakeProjectItem({ id: "p1", worktree: "/workspace", name: "workspace" })
    // If both name and basename are "workspace", display name is misleading.
    // With a proper repo name it should be fine.
    expect(projectDisplayName(project, "kyashrathore/Claxedo")).toBe("kyashrathore/Claxedo")
  })
})

describe("projectLabel (sidebar section header)", () => {
  test("derives owner/repo from session git remote", () => {
    const project = fakeProjectItem({ id: "p1", worktree: "/home/user/myapp", name: "myapp" })
    const sessions = {
      p1: [{ git: { remote: "https://github.com/kyashrathore/Claxedo.git" } }],
    }
    expect(projectLabel(project, sessions)).toBe("kyashrathore/Claxedo")
  })

  test("falls back to project.name when no sessions have git remote", () => {
    const project = fakeProjectItem({ id: "p1", worktree: "/home/user/myapp", name: "MyApp" })
    const sessions = { p1: [{ git: undefined }] }
    expect(projectLabel(project, sessions)).toBe("MyApp")
  })

  test("falls back to project.name when no sessions exist", () => {
    const project = fakeProjectItem({ id: "p1", worktree: "/home/user/myapp", name: "MyApp" })
    expect(projectLabel(project, {})).toBe("MyApp")
  })

  test("falls back to directory basename as last resort", () => {
    const project = fakeProjectItem({ id: "p1", worktree: "/home/user/myapp" })
    expect(projectLabel(project, {})).toBe("myapp")
  })
})

describe("projectWorkspaces", () => {
  test("returns main worktree as first item", () => {
    const project = fakeProjectItem({
      id: "p1",
      worktree: "/home/user/myapp",
      sandboxes: ["/home/user/myapp-feature"],
    })
    const ws = projectWorkspaces(project, false)
    expect(ws[0].name).toBe("main")
    expect(ws[0].isMain).toBe(true)
    expect(ws[0].directory).toBe("/home/user/myapp")
  })

  test("marks workspaces as local when isCloud=false", () => {
    const project = fakeProjectItem({ id: "p1", worktree: "/home/user/myapp" })
    const ws = projectWorkspaces(project, false)
    expect(ws[0].isCloud).toBe(false)
  })

  test("marks workspaces as cloud when isCloud=true", () => {
    const project = fakeProjectItem({ id: "p1", worktree: "/home/user/myapp" })
    const ws = projectWorkspaces(project, true)
    expect(ws[0].isCloud).toBe(true)
  })

  test("sandboxes get basename as name", () => {
    const project = fakeProjectItem({
      id: "p1",
      worktree: "/home/user/myapp",
      sandboxes: ["/home/user/myapp-feature"],
    })
    const ws = projectWorkspaces(project, false)
    expect(ws).toHaveLength(2)
    expect(ws[1].name).toBe("myapp-feature")
    expect(ws[1].isMain).toBeUndefined()
  })

  test("skips sandbox that equals worktree", () => {
    const project = fakeProjectItem({
      id: "p1",
      worktree: "/home/user/myapp",
      sandboxes: ["/home/user/myapp", "/home/user/myapp-feature"],
    })
    const ws = projectWorkspaces(project, false)
    expect(ws).toHaveLength(2) // main + feature, not main + main-dupe + feature
  })

  test("handles project with no sandboxes", () => {
    const project = fakeProjectItem({ id: "p1", worktree: "/home/user/myapp" })
    const ws = projectWorkspaces(project, false)
    expect(ws).toHaveLength(1)
    expect(ws[0].name).toBe("main")
  })

  test("isCloud derives from per-workspace metadata when available", () => {
    const project = fakeProjectItem({
      id: "p1",
      worktree: "/home/user/myapp",
      sandboxes: ["/home/cloud/sandbox"],
      workspaces: {
        "/home/user/myapp": { kind: "local" },
        "/home/cloud/sandbox": { kind: "cloud" },
      },
    })

    // project-level isCloud=false, but sandbox has kind=cloud via metadata
    const ws = projectWorkspaces(project, false)
    expect(ws[0].isCloud).toBe(false) // main inherits project-level
    expect(ws[1].isCloud).toBe(true)  // sandbox uses per-workspace kind
  })

  test("isCloud falls back to false when no workspace metadata", () => {
    const project = fakeProjectItem({
      id: "p1",
      worktree: "/home/user/myapp",
      sandboxes: ["/home/cloud/sandbox"],
    })

    const ws = projectWorkspaces(project, false)
    expect(ws[0].isCloud).toBe(false)
    expect(ws[1].isCloud).toBe(false) // no metadata → defaults to false
  })
})

describe("workspaceIds", () => {
  test("does not inject the repo root when currentDir is a nested path in the same project", () => {
    expect(workspaceIds({
      project: {
        worktree: "/Users/test/opencode",
        sandboxes: ["/Users/test/opencode/.claxedo/wt-a"],
      },
      activeProjectWorktree: "/Users/test/opencode",
      currentDir: "/Users/test/opencode/packages/claxedo-app",
    })).toEqual([
      "/Users/test/opencode",
      "/Users/test/opencode/.claxedo/wt-a",
    ])
  })

  test("does not duplicate an equivalent workspace when only path formatting differs", () => {
    expect(workspaceIds({
      project: {
        worktree: "/Users/test/opencode",
        sandboxes: ["/Users/test/opencode/glowing-mountain"],
      },
      activeProjectWorktree: "/Users/test/opencode/",
      currentDir: "/Users/test/opencode/glowing-mountain/",
      order: ["/Users/test/opencode/glowing-mountain"],
    })).toEqual([
      "/Users/test/opencode",
      "/Users/test/opencode/glowing-mountain",
    ])
  })

  test("keeps a pending workspace visible before it lands in project sandboxes", () => {
    expect(workspaceIds({
      project: {
        worktree: "/Users/test/opencode",
        sandboxes: ["/Users/test/opencode/glowing-mountain"],
      },
      activeProjectWorktree: "/Users/test/opencode",
      currentDir: "/Users/test/opencode/neon-rocket",
      pending: true,
    })).toEqual([
      "/Users/test/opencode",
      "/Users/test/opencode/neon-rocket",
      "/Users/test/opencode/glowing-mountain",
    ])
  })
})

describe("projectCatalog", () => {
  const valid = (dir: string) => dir.startsWith("/")

  test("returns projects from API that pass validation", () => {
    const api: Project[] = [
      fakeApiProject({ id: "p1", worktree: "/home/user/proj1" }),
      fakeApiProject({ id: "p2", worktree: "/home/user/proj2" }),
    ]
    const result = projectCatalog({ api, current: [], closed: () => false, valid })
    expect(result.list).toHaveLength(2)
    expect(result.meta.size).toBe(2)
  })

  test("filters out invalid worktrees", () => {
    const api: Project[] = [
      fakeApiProject({ id: "p1", worktree: "/home/user/proj1" }),
      fakeApiProject({ id: "p2", worktree: "relative/path" }), // invalid
    ]
    const result = projectCatalog({ api, current: [], closed: () => false, valid })
    expect(result.list).toHaveLength(1)
    expect(result.meta.size).toBe(1)
  })

  test("filters out closed projects", () => {
    const api: Project[] = [
      fakeApiProject({ id: "p1", worktree: "/home/user/proj1" }),
      fakeApiProject({ id: "p2", worktree: "/home/user/proj2" }),
    ]
    const closed = (dir: string) => dir === "/home/user/proj2"
    const result = projectCatalog({ api, current: [], closed, valid })
    expect(result.list).toHaveLength(1)
    expect(result.list[0].worktree).toBe("/home/user/proj1")
  })

  test("preserves order: current projects first, then new from API", () => {
    const api: Project[] = [
      fakeApiProject({ id: "p1", worktree: "/home/user/proj1" }),
      fakeApiProject({ id: "p2", worktree: "/home/user/proj2" }),
    ]
    const current: ProjectState[] = [
      { worktree: "/home/user/proj2", expanded: true },
    ]
    const result = projectCatalog({ api, current, closed: () => false, valid })
    expect(result.list[0].worktree).toBe("/home/user/proj2") // current first
    expect(result.list[1].worktree).toBe("/home/user/proj1") // then new
  })

  test("deduplicates projects with same worktree", () => {
    const api: Project[] = [
      fakeApiProject({ id: "p1", worktree: "/home/user/proj1" }),
    ]
    const current: ProjectState[] = [
      { worktree: "/home/user/proj1", expanded: true },
      { worktree: "/home/user/proj1", expanded: false }, // duplicate
    ]
    const result = projectCatalog({ api, current, closed: () => false, valid })
    expect(result.list).toHaveLength(1)
  })

  test("resolves sandbox directories to their parent project", () => {
    const api: Project[] = [
      fakeApiProject({
        id: "p1",
        worktree: "/home/user/proj1",
        sandboxes: ["/home/user/sandbox1"],
      }),
    ]
    const current: ProjectState[] = [
      { worktree: "/home/user/sandbox1", expanded: true },
    ]
    const result = projectCatalog({ api, current, closed: () => false, valid })
    // The sandbox should resolve to its parent project, not appear as separate
    expect(result.list).toHaveLength(1)
    expect(result.list[0].worktree).toBe("/home/user/proj1")
  })

  test("filters out /workspace container path even when valid allows it", () => {
    const api: Project[] = [
      fakeApiProject({ id: "p1", worktree: "/home/user/proj1" }),
      fakeApiProject({ id: "p2", worktree: "/workspace" }),
    ]
    const result = projectCatalog({ api, current: [], closed: () => false, valid })
    const bad = result.list.find((p) => p.worktree === "/workspace")
    expect(bad).toBeUndefined()
  })

})

describe("canAutoOpenProject", () => {
  test("returns false for undefined directory", () => {
    expect(canAutoOpenProject({ api: [], list: [], dir: undefined, closed: () => false })).toBe(false)
  })

  test("returns false if directory already in project list", () => {
    const list = [{ worktree: "/home/user/proj1", sandboxes: [] }]
    expect(canAutoOpenProject({ api: [], list, dir: "/home/user/proj1", closed: () => false })).toBe(false)
  })

  test("returns false if directory is a sandbox in project list", () => {
    const list = [{ worktree: "/home/user/proj1", sandboxes: ["/home/user/sandbox1"] }]
    expect(canAutoOpenProject({ api: [], list, dir: "/home/user/sandbox1", closed: () => false })).toBe(false)
  })

  test("returns true for new directory not in any project", () => {
    expect(canAutoOpenProject({ api: [], list: [], dir: "/home/user/new-proj", closed: () => false })).toBe(true)
  })

  test("returns false for closed project", () => {
    const closed = (dir: string) => dir === "/home/user/closed-proj"
    expect(canAutoOpenProject({ api: [], list: [], dir: "/home/user/closed-proj", closed })).toBe(false)
  })

  test("resolves sandbox to parent project before checking closed", () => {
    const api: Project[] = [
      fakeApiProject({
        id: "p1",
        worktree: "/home/user/proj1",
        sandboxes: ["/home/user/sandbox1"],
      }),
    ]
    // The parent project is closed, so opening via sandbox should also be blocked
    const closed = (dir: string) => dir === "/home/user/proj1"
    expect(canAutoOpenProject({ api, list: [], dir: "/home/user/sandbox1", closed })).toBe(false)
  })

  test("can ignore closed state for the active routed workspace", () => {
    const closed = (dir: string) => dir === "/home/user/closed-proj"
    expect(
      canAutoOpenProject({
        api: [],
        list: [],
        dir: "/home/user/closed-proj",
        closed,
        ignoreClosed: true,
      }),
    ).toBe(true)
  })
})

// ── End-to-end: fake API → frontend data pipeline ──────────────────────

describe("end-to-end: API response → project display", () => {
  /**
   * Simulates the full pipeline:
   * 1. API returns projects (as from listProjects endpoint)
   * 2. projectCatalog() processes them for the sidebar
   * 3. projectWorkspaces() generates workspace items for each project
   * 4. projectLabel() / projectDisplayName() generate display names
   */

  const valid = (dir: string) => dir.startsWith("/") && dir.length > 1

  test("single local project with git remote shows owner/repo name", () => {
    const api: Project[] = [
      fakeApiProject({
        id: "proj_abc",
        worktree: "/home/user/myapp",
        name: "myapp",
      }),
    ]
    const sessions = {
      proj_abc: [{ git: { remote: "https://github.com/acme/my-service.git" } }],
    }

    const catalog = projectCatalog({ api, current: [], closed: () => false, valid })
    expect(catalog.list).toHaveLength(1)

    const projectItem = fakeProjectItem({
      id: "proj_abc",
      worktree: "/home/user/myapp",
      name: "myapp",
    })
    const label = projectLabel(projectItem, sessions)
    expect(label).toBe("acme/my-service")

    const ws = projectWorkspaces(projectItem, false)
    expect(ws).toHaveLength(1)
    expect(ws[0].isCloud).toBe(false)
    expect(ws[0].name).toBe("main")
  })

  test("project with local checkout + cloud sandbox shows both workspaces", () => {
    const api: Project[] = [
      fakeApiProject({
        id: "proj_clax",
        worktree: "/home/user/Claxedo",
        name: "Claxedo",
        sandboxes: ["/home/cloud/workspaces/proj_clax/main"],
      }),
    ]
    const sessions = {
      proj_clax: [{ git: { remote: "https://github.com/kyashrathore/Claxedo.git" } }],
    }

    const catalog = projectCatalog({ api, current: [], closed: () => false, valid })
    expect(catalog.list).toHaveLength(1)

    const projectItem = fakeProjectItem({
      id: "proj_clax",
      worktree: "/home/user/Claxedo",
      name: "Claxedo",
      sandboxes: ["/home/cloud/workspaces/proj_clax/main"],
      workspaces: {
        "/home/user/Claxedo": { kind: "local", workspace_name: "main" },
        "/home/cloud/workspaces/proj_clax/main": { kind: "cloud", workspace_name: "main", provider: "daytona" },
      },
    })

    // Label should be owner/repo
    expect(projectLabel(projectItem, sessions)).toBe("kyashrathore/Claxedo")

    // Workspaces: main + cloud sandbox
    const ws = projectWorkspaces(projectItem, false)
    expect(ws).toHaveLength(2)
    expect(ws[0].name).toBe("main")
    expect(ws[0].directory).toBe("/home/user/Claxedo")
    expect(ws[0].isCloud).toBe(false)
    expect(ws[1].name).toBe("main (cloud)")
    expect(ws[1].directory).toBe("/home/cloud/workspaces/proj_clax/main")
    expect(ws[1].isCloud).toBe(true)

    // No duplicate names in workspace list
    const names = ws.map((w) => w.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test("project with multiple local worktrees groups correctly", () => {
    const api: Project[] = [
      fakeApiProject({
        id: "proj_multi",
        worktree: "/home/user/myapp",
        name: "myapp",
        sandboxes: ["/home/worktrees/proj_multi/feature-1", "/home/worktrees/proj_multi/hotfix"],
      }),
    ]

    const projectItem = fakeProjectItem({
      id: "proj_multi",
      worktree: "/home/user/myapp",
      name: "myapp",
      sandboxes: ["/home/worktrees/proj_multi/feature-1", "/home/worktrees/proj_multi/hotfix"],
    })

    const ws = projectWorkspaces(projectItem, false)
    expect(ws).toHaveLength(3)
    expect(ws.map((w) => w.name)).toEqual(["main", "feature-1", "hotfix"])
    expect(ws.every((w) => w.isCloud === false)).toBe(true)
    expect(ws.every((w) => w.projectWorktree === "/home/user/myapp")).toBe(true)
  })

  test("adding a new project: resolveWorkspace → listProjects → frontend", () => {
    // Simulates: user opens a new directory.
    // 1. Frontend calls ensureProject(dir) → resolveWorkspace(create=true)
    // 2. API now returns the new project in listProjects
    // 3. projectCatalog shows it, projectLabel names it

    const api: Project[] = [
      fakeApiProject({
        id: "proj_new",
        worktree: "/home/user/new-project",
        name: "new-project",
      }),
    ]
    const sessions = {
      proj_new: [{ git: { remote: "https://github.com/acme/new-project.git" } }],
    }

    // canAutoOpenProject: before API returns it, the directory is unknown → auto-open
    expect(canAutoOpenProject({
      api: [],
      list: [],
      dir: "/home/user/new-project",
      closed: () => false,
    })).toBe(true)

    // After API knows about it, canAutoOpenProject still returns true because
    // the project is not in `list` yet (list = sidebar state, not API state).
    // The caller (layout.tsx) checks catalog().meta.has(root) separately.
    expect(canAutoOpenProject({ api, list: [], dir: "/home/user/new-project", closed: () => false })).toBe(true)

    // After API returns it, catalog includes it
    const catalog = projectCatalog({ api, current: [], closed: () => false, valid })
    expect(catalog.list).toHaveLength(1)

    const projectItem = fakeProjectItem({
      id: "proj_new",
      worktree: "/home/user/new-project",
      name: "new-project",
    })
    expect(projectLabel(projectItem, sessions)).toBe("acme/new-project")
  })

  test("adding a local worktree: appears as sandbox, not new project", () => {
    // Simulates: POST /experimental/worktree creates a new worktree.
    // API now returns the project with the new worktree in sandboxes.

    const api: Project[] = [
      fakeApiProject({
        id: "proj_wt",
        worktree: "/home/user/myapp",
        name: "myapp",
        sandboxes: ["/home/worktrees/proj_wt/bugfix"],
      }),
    ]

    const catalog = projectCatalog({ api, current: [], closed: () => false, valid })
    // Still one project
    expect(catalog.list).toHaveLength(1)
    expect(catalog.list[0].worktree).toBe("/home/user/myapp")

    // Workspace items include the worktree
    const projectItem = fakeProjectItem({
      id: "proj_wt",
      worktree: "/home/user/myapp",
      name: "myapp",
      sandboxes: ["/home/worktrees/proj_wt/bugfix"],
    })
    const ws = projectWorkspaces(projectItem, false)
    expect(ws).toHaveLength(2)
    expect(ws[1].name).toBe("bugfix")
    expect(ws[1].isCloud).toBe(false)
    expect(ws[1].isMain).toBeUndefined()
  })

  test("adding a cloud workspace: appears as sandbox, not new project", () => {
    // Simulates: POST /create creates a cloud sandbox under existing project.
    // API returns project with new sandbox directory.

    const api: Project[] = [
      fakeApiProject({
        id: "proj_cs",
        worktree: "/home/user/myapp",
        name: "myapp",
        sandboxes: ["/home/cloud/workspaces/proj_cs/dev"],
      }),
    ]

    const catalog = projectCatalog({ api, current: [], closed: () => false, valid })
    expect(catalog.list).toHaveLength(1)

    const projectItem = fakeProjectItem({
      id: "proj_cs",
      worktree: "/home/user/myapp",
      name: "myapp",
      sandboxes: ["/home/cloud/workspaces/proj_cs/dev"],
    })
    const ws = projectWorkspaces(projectItem, false)
    expect(ws).toHaveLength(2)
    expect(ws[1].name).toBe("dev")
    expect(ws[1].directory).toBe("/home/cloud/workspaces/proj_cs/dev")
  })

  test("re-opening a closed project: catalog shows it again with all workspaces", () => {
    const api: Project[] = [
      fakeApiProject({
        id: "proj_reopen",
        worktree: "/home/user/myapp",
        name: "myapp",
        sandboxes: ["/home/worktrees/proj_reopen/feat", "/home/cloud/workspaces/proj_reopen/main"],
      }),
    ]

    // When closed, it's filtered out
    const closedSet = new Set(["/home/user/myapp"])
    const catalogClosed = projectCatalog({
      api,
      current: [],
      closed: (dir) => closedSet.has(dir),
      valid,
    })
    expect(catalogClosed.list).toHaveLength(0)

    // After re-opening (removed from closed set, added back to current)
    closedSet.delete("/home/user/myapp")
    const current: ProjectState[] = [{ worktree: "/home/user/myapp", expanded: true }]
    const catalogOpen = projectCatalog({
      api,
      current,
      closed: (dir) => closedSet.has(dir),
      valid,
    })
    expect(catalogOpen.list).toHaveLength(1)
    expect(catalogOpen.list[0].worktree).toBe("/home/user/myapp")

    // All workspaces are available via the project
    const projectItem = fakeProjectItem({
      id: "proj_reopen",
      worktree: "/home/user/myapp",
      name: "myapp",
      sandboxes: ["/home/worktrees/proj_reopen/feat", "/home/cloud/workspaces/proj_reopen/main"],
    })
    const ws = projectWorkspaces(projectItem, false)
    expect(ws).toHaveLength(3) // main + feat worktree + cloud sandbox
  })

  test("leaked /workspace paths do not appear in end-to-end pipeline", () => {
    const api: Project[] = [
      fakeApiProject({ id: "proj_real", worktree: "/home/user/myapp", name: "myapp" }),
      fakeApiProject({ id: "proj_leaked", worktree: "/workspace", name: "workspace" }),
    ]

    const catalog = projectCatalog({ api, current: [], closed: () => false, valid })
    expect(catalog.list).toHaveLength(1)
    expect(catalog.list[0].worktree).toBe("/home/user/myapp")
  })

  test("sandbox name derives from directory basename", () => {
    const project = fakeProjectItem({
      id: "proj_clax",
      worktree: "/home/user/Claxedo",
      name: "Claxedo",
      sandboxes: ["/home/cloud/workspaces/proj_clax/dev"],
    })

    const ws = projectWorkspaces(project, false)
    const sandbox = ws.find((w) => w.directory === "/home/cloud/workspaces/proj_clax/dev")
    expect(sandbox).toBeDefined()
    expect(sandbox!.name).toBe("dev")
  })

  test("real-world scenario: no duplicate names, correct cloud labels, no unexpected entries", () => {
    // Simulates the actual workspaces.json structure: local root + cloud sandbox + subdirectory workspace
    const api: Project[] = [
      fakeApiProject({
        id: "proj_real",
        worktree: "/Users/user/test/opencode",
        name: "opencode",
        sandboxes: [
          "/Users/user/.claxedo/cloud/workspaces/proj_real/main",
          "/Users/user/test/opencode/packages/claxedo-server",
        ],
      }),
    ]

    const catalog = projectCatalog({ api, current: [], closed: () => false, valid })
    expect(catalog.list).toHaveLength(1)

    const projectItem = fakeProjectItem({
      id: "proj_real",
      worktree: "/Users/user/test/opencode",
      name: "opencode",
      sandboxes: [
        "/Users/user/.claxedo/cloud/workspaces/proj_real/main",
        "/Users/user/test/opencode/packages/claxedo-server",
      ],
      workspaces: {
        "/Users/user/test/opencode": { kind: "local", workspace_name: "main" },
        "/Users/user/.claxedo/cloud/workspaces/proj_real/main": {
          kind: "cloud",
          workspace_name: "main",
          provider: "daytona",
        },
        "/Users/user/test/opencode/packages/claxedo-server": {
          kind: "local",
          workspace_name: "claxedo-server",
        },
      },
    })

    const ws = projectWorkspaces(projectItem, false)

    // Exactly 3 workspaces: main, cloud sandbox, subdirectory
    expect(ws).toHaveLength(3)

    // No duplicate names
    const names = ws.map((w) => w.name)
    expect(new Set(names).size).toBe(names.length)

    // Main workspace
    expect(ws[0].name).toBe("main")
    expect(ws[0].isCloud).toBe(false)
    expect(ws[0].isMain).toBe(true)

    // Cloud sandbox labeled distinctly
    expect(ws[1].name).toBe("main (cloud)")
    expect(ws[1].isCloud).toBe(true)
    expect(ws[1].isMain).toBeUndefined()

    // Subdirectory workspace keeps its name
    expect(ws[2].name).toBe("claxedo-server")
    expect(ws[2].isCloud).toBe(false)

    // Every workspace has the correct project worktree
    expect(ws.every((w) => w.projectWorktree === "/Users/user/test/opencode")).toBe(true)

    // Every workspace name is a non-empty string
    expect(ws.every((w) => typeof w.name === "string" && w.name.length > 0)).toBe(true)
  })

  test("workspace list contains only entries from sandboxes + main worktree", () => {
    const projectItem = fakeProjectItem({
      id: "p1",
      worktree: "/home/user/myapp",
      sandboxes: ["/home/cloud/sandbox-a", "/home/worktrees/feature-b"],
    })

    const ws = projectWorkspaces(projectItem, false)

    // Count must equal 1 (main) + sandboxes count
    const expectedCount = 1 + (projectItem.sandboxes?.filter((s) => s !== projectItem.worktree).length ?? 0)
    expect(ws).toHaveLength(expectedCount)

    // Every workspace directory is either the worktree or a sandbox
    const allDirs = new Set([projectItem.worktree, ...(projectItem.sandboxes ?? [])])
    for (const w of ws) {
      expect(allDirs.has(w.directory)).toBe(true)
    }
  })
})

// ── Data pipeline: API response → projectCatalog → enrich → projectToProjectItem → display ──

describe("data pipeline: workspaces metadata survives API → frontend", () => {
  /**
   * The SDK Project type has sandboxes: Array<string> but NOT workspaces.
   * listProjects() on the server adds workspaces: Record<string, Workspace>.
   * The JSON response includes it, but TypeScript doesn't know about it.
   *
   * This test traces each step to verify the workspaces field survives
   * the full pipeline and drives correct display logic.
   */

  const valid = (dir: string) => dir.startsWith("/") && dir.length > 1

  // Simulates what listProjects() returns from workspace-store.ts
  // The `workspaces` field is NOT in the SDK Project type — it's extra JSON.
  function fakeApiResponseProject(overrides: Record<string, unknown>) {
    return {
      sandboxes: [],
      time: { created: Date.now(), updated: Date.now() },
      ...overrides,
    }
  }

  // Simulates what enrich() does in layout.tsx:295-303
  function simulateEnrich(
    project: { worktree: string; expanded: boolean },
    metadata: Record<string, unknown> | undefined,
  ) {
    return {
      ...(metadata ?? {}),
      ...project,
      icon: {
        url: (metadata as any)?.icon?.url,
        override: (metadata as any)?.icon?.override,
        color: (metadata as any)?.icon?.color,
      },
    }
  }

  // Simulates what projectToProjectItem() does in ClaxedoLayout.tsx:64-75
  function simulateProjectToProjectItem(project: Record<string, unknown>): ProjectItem {
    return {
      id: (project.id as string) ?? (project.worktree as string),
      worktree: project.worktree as string,
      name: project.name as string | undefined,
      icon: project.icon as ProjectItem["icon"],
      expanded: project.expanded as boolean | undefined,
      sandboxes: project.sandboxes as string[] | undefined,
      workspaces: (project as any).workspaces,
      commands: project.commands as ProjectItem["commands"],
    }
  }

  test("step 1: projectCatalog meta preserves workspaces from API response", () => {
    // API response includes workspaces (extra field not in SDK Project type)
    const apiResponse = [
      fakeApiResponseProject({
        id: "proj_1",
        worktree: "/home/user/opencode",
        name: "opencode",
        sandboxes: ["/home/cloud/workspaces/proj_1/main"],
        workspaces: {
          "/home/user/opencode": { kind: "local", workspace_name: "main" },
          "/home/cloud/workspaces/proj_1/main": { kind: "cloud", workspace_name: "main" },
        },
      }),
    ] as Project[] // cast like the real code does

    const catalog = projectCatalog({ api: apiResponse, current: [], closed: () => false, valid })
    const meta = catalog.meta.get("/home/user/opencode")

    expect(meta).toBeDefined()
    // The workspaces field must survive projectCatalog
    expect((meta as any).workspaces).toBeDefined()
    expect((meta as any).workspaces["/home/cloud/workspaces/proj_1/main"]).toBeDefined()
    expect((meta as any).workspaces["/home/cloud/workspaces/proj_1/main"].kind).toBe("cloud")
  })

  test("step 2: enrich spread preserves workspaces from metadata", () => {
    const metadata = {
      id: "proj_1",
      worktree: "/home/user/opencode",
      name: "opencode",
      sandboxes: ["/home/cloud/workspaces/proj_1/main"],
      workspaces: {
        "/home/user/opencode": { kind: "local", workspace_name: "main" },
        "/home/cloud/workspaces/proj_1/main": { kind: "cloud", workspace_name: "main" },
      },
      time: { created: 1, updated: 2 },
    }

    const project = { worktree: "/home/user/opencode", expanded: true }
    const enriched = simulateEnrich(project, metadata)

    // workspaces must survive the spread pattern: { ...metadata, ...project, icon: {...} }
    expect((enriched as any).workspaces).toBeDefined()
    expect((enriched as any).workspaces["/home/cloud/workspaces/proj_1/main"].kind).toBe("cloud")
    // sandboxes must also survive
    expect((enriched as any).sandboxes).toEqual(["/home/cloud/workspaces/proj_1/main"])
  })

  test("step 3: projectToProjectItem extracts workspaces via (project as any).workspaces", () => {
    const enriched = {
      id: "proj_1",
      worktree: "/home/user/opencode",
      name: "opencode",
      expanded: true,
      sandboxes: ["/home/cloud/workspaces/proj_1/main"],
      workspaces: {
        "/home/user/opencode": { kind: "local", workspace_name: "main" },
        "/home/cloud/workspaces/proj_1/main": { kind: "cloud", workspace_name: "main" },
      },
      icon: {},
    }

    const item = simulateProjectToProjectItem(enriched)

    expect(item.workspaces).toBeDefined()
    expect(item.workspaces!["/home/cloud/workspaces/proj_1/main"]).toBeDefined()
    expect(item.workspaces!["/home/cloud/workspaces/proj_1/main"].kind).toBe("cloud")
  })

  test("step 4: projectWorkspaces uses workspaces metadata for correct names and isCloud", () => {
    const item: ProjectItem = {
      id: "proj_1",
      worktree: "/home/user/opencode",
      name: "opencode",
      sandboxes: ["/home/cloud/workspaces/proj_1/main"],
      workspaces: {
        "/home/user/opencode": { kind: "local", workspace_name: "main" },
        "/home/cloud/workspaces/proj_1/main": { kind: "cloud", workspace_name: "main" },
      },
    }

    const ws = projectWorkspaces(item, false)
    expect(ws).toHaveLength(2)
    expect(ws[0].name).toBe("main")
    expect(ws[0].isCloud).toBe(false)
    expect(ws[1].name).toBe("main (cloud)")
    expect(ws[1].isCloud).toBe(true)
  })

  test("full pipeline: API response → catalog → enrich → projectItem → display (no duplicates)", () => {
    // Step 1: API response (matches real listProjects() output)
    const apiResponse = [
      fakeApiResponseProject({
        id: "proj_clax",
        worktree: "/Users/user/test/opencode",
        name: "opencode",
        sandboxes: [
          "/Users/user/.claxedo/cloud/workspaces/proj_clax/main",
          "/Users/user/test/opencode/packages/claxedo-server",
        ],
        workspaces: {
          "/Users/user/test/opencode": {
            id: "proj_clax", kind: "local", workspace_name: "main", directory: "/Users/user/test/opencode",
          },
          "/Users/user/.claxedo/cloud/workspaces/proj_clax/main": {
            id: "ws_cloud", kind: "cloud", workspace_name: "main", directory: "/Users/user/.claxedo/cloud/workspaces/proj_clax/main", provider: "daytona",
          },
          "/Users/user/test/opencode/packages/claxedo-server": {
            id: "ws_sub", kind: "local", workspace_name: "claxedo-server", directory: "/Users/user/test/opencode/packages/claxedo-server",
          },
        },
      }),
    ] as Project[]

    // Step 2: projectCatalog
    const catalog = projectCatalog({ api: apiResponse, current: [], closed: () => false, valid })
    expect(catalog.list).toHaveLength(1)
    const meta = catalog.meta.get("/Users/user/test/opencode")
    expect(meta).toBeDefined()
    expect((meta as any).workspaces).toBeDefined()

    // Step 3: enrich
    const project = { worktree: "/Users/user/test/opencode", expanded: true }
    const enriched = simulateEnrich(project, meta as Record<string, unknown>)
    expect((enriched as any).workspaces).toBeDefined()

    // Step 4: projectToProjectItem
    const item = simulateProjectToProjectItem(enriched)
    expect(item.workspaces).toBeDefined()
    expect(Object.keys(item.workspaces!)).toHaveLength(3)

    // Step 5: projectWorkspaces → display
    const ws = projectWorkspaces(item, false)

    // Must have exactly 3 entries
    expect(ws).toHaveLength(3)

    // No duplicate names
    const names = ws.map((w) => w.name)
    expect(new Set(names).size).toBe(names.length)

    // Correct names
    expect(ws[0]).toMatchObject({ name: "main", isCloud: false, isMain: true })
    expect(ws[1]).toMatchObject({ name: "main (cloud)", isCloud: true })
    expect(ws[2]).toMatchObject({ name: "claxedo-server", isCloud: false })
  })

  test("main worktree isCloud comes from workspace metadata, not global server flag", () => {
    const cloudOnlyProject: ProjectItem = {
      id: "proj_cloud_only",
      worktree: "/home/cloud/workspaces/proj_cloud/main",
      name: "CloudApp",
      sandboxes: [],
      workspaces: {
        "/home/cloud/workspaces/proj_cloud/main": { kind: "cloud", workspace_name: "main" },
      },
    }

    // isCloud=false (server.isLocal()=true) but metadata says kind: "cloud" → true
    const ws = projectWorkspaces(cloudOnlyProject, false)
    expect(ws).toHaveLength(1)
    expect(ws[0].isCloud).toBe(true)
  })

  test("mixed project — main local worktree stays isCloud=false when server is local", () => {
    const mixedProject: ProjectItem = {
      id: "proj_mixed",
      worktree: "/home/user/myapp",
      name: "MyApp",
      sandboxes: ["/home/cloud/sandbox/main"],
      workspaces: {
        "/home/user/myapp": { kind: "local", workspace_name: "main" },
        "/home/cloud/sandbox/main": { kind: "cloud", workspace_name: "main" },
      },
    }

    const ws = projectWorkspaces(mixedProject, false)
    expect(ws[0].isCloud).toBe(false)  // local worktree → false
    expect(ws[1].isCloud).toBe(true)   // cloud sandbox → true
  })

  test("workspace icon: cloud workspace gets isCloud=true even when server is local", () => {
    const apiResponse = [
      fakeApiResponseProject({
        id: "proj_icon",
        worktree: "/home/user/myapp",
        name: "myapp",
        sandboxes: ["/home/cloud/sandbox/main"],
        workspaces: {
          "/home/user/myapp": { kind: "local", workspace_name: "main" },
          "/home/cloud/sandbox/main": { kind: "cloud", workspace_name: "main", provider: "daytona" },
        },
      }),
    ] as Project[]

    const catalog = projectCatalog({ api: apiResponse, current: [], closed: () => false, valid })
    const meta = catalog.meta.get("/home/user/myapp")
    const enriched = simulateEnrich({ worktree: "/home/user/myapp", expanded: true }, meta as Record<string, unknown>)
    const item = simulateProjectToProjectItem(enriched)

    const ws = projectWorkspaces(item, false)

    const cloudWs = ws.find((w) => w.directory === "/home/cloud/sandbox/main")
    expect(cloudWs).toBeDefined()
    expect(cloudWs!.isCloud).toBe(true)

    const localWs = ws.find((w) => w.directory === "/home/user/myapp")
    expect(localWs).toBeDefined()
    expect(localWs!.isCloud).toBe(false)

    // Project-level: hasCloudWorkspace should be derivable from workspaces
    const hasCloud = Object.values(item.workspaces ?? {}).some((w) => w.kind === "cloud")
    expect(hasCloud).toBe(true)
  })

})
