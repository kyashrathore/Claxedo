/**
 * Project Lifecycle Tests — Split Effects + on() Contract
 *
 * Verifies that the two project lifecycle effects in layout.tsx are
 * structurally decoupled:
 *
 * 1. Sandbox resolution — tracks server.projects.list(), resolves
 *    sandbox directories to their parent project.
 *
 * 2. Stale orphan cleanup — tracks ONLY API project data via on(),
 *    reads server.projects.list() inside the callback body (untracked).
 *    This prevents a race where opening a project (mutating the sidebar)
 *    would trigger cleanup before the API confirms the project.
 *
 * Strategy: Replicate the two effects with controllable signals inside
 * createRoot, then verify the reactive dependencies match the contract.
 *
 * Note: SolidJS batches all effects inside createRoot — they only fire
 * after the callback returns. So we set up effects in createRoot, then
 * do signal changes outside it (effects fire synchronously there).
 */
import { describe, expect, test } from "bun:test"
import { batch, createEffect, createRoot, createSignal, on } from "solid-js"
import { createStore } from "solid-js/store"

// ---------------------------------------------------------------------------
// Helpers — minimal mock of server.projects + globalSync.data.project
// ---------------------------------------------------------------------------

type ProjectEntry = { worktree: string; expanded: boolean }
type ApiProject = { worktree: string; sandboxes?: string[] }

function createMockServer() {
  const [store, setStore] = createStore<{ projects: ProjectEntry[] }>({ projects: [] })
  return {
    projects: {
      list: () => store.projects,
      open(worktree: string) {
        setStore("projects", (prev) => [...prev, { worktree, expanded: false }])
      },
      remove(worktree: string) {
        setStore("projects", (prev) => prev.filter((p) => p.worktree !== worktree))
      },
      expand(worktree: string) {
        setStore("projects", (p) => p.worktree === worktree, "expanded", true)
      },
    },
    isLocal: () => true,
  }
}

/**
 * Mock globalSync using a signal for the project list.
 * This accurately models the reactive contract: the `on()` dependency
 * `() => globalSync.data.project` tracks a reactive source that fires
 * when the API data changes.
 */
function createMockGlobalSync() {
  const [project, setProject] = createSignal<ApiProject[]>([])
  return {
    data: {
      get project() {
        return project()
      },
    },
    setProject,
  }
}

/** Identity rootFor — no sandbox resolution (tests can override). */
const identityRootFor = (dir: string) => dir

/** Always-valid worktree check for tests. */
const alwaysValid = (_dir: string) => true

// ---------------------------------------------------------------------------
// Wire up the two effects exactly as layout.tsx does, returning handles
// for signal manipulation outside createRoot.
// ---------------------------------------------------------------------------

interface LifecycleHandle {
  server: ReturnType<typeof createMockServer>
  globalSync: ReturnType<typeof createMockGlobalSync>
  cleanupLog: string[]
  sandboxLog: string[]
  dispose: () => void
}

function setupLifecycleEffects(opts?: {
  rootFor?: (dir: string) => string
  validWorktree?: (dir: string) => boolean
}): LifecycleHandle {
  const rootFor = opts?.rootFor ?? identityRootFor
  const validWorktree = opts?.validWorktree ?? alwaysValid

  let server!: ReturnType<typeof createMockServer>
  let globalSync!: ReturnType<typeof createMockGlobalSync>
  const cleanupLog: string[] = []
  const sandboxLog: string[] = []

  const dispose = createRoot((d) => {
    server = createMockServer()
    globalSync = createMockGlobalSync()

    // Effect 1: Sandbox → parent resolution (mirrors layout.tsx)
    createEffect(() => {
      const projects = server.projects.list()
      const seen = new Set(projects.map((p) => p.worktree))
      batch(() => {
        for (const project of projects) {
          const root = rootFor(project.worktree)
          if (root === project.worktree) continue
          sandboxLog.push(`resolve:${project.worktree}->${root}`)
          server.projects.remove(project.worktree)
          if (!seen.has(root) && validWorktree(root)) {
            server.projects.open(root)
            seen.add(root)
          }
          if (project.expanded) server.projects.expand(root)
        }
      })
    })

    // Effect 2: Stale orphan cleanup via on() (mirrors layout.tsx)
    createEffect(
      on(
        () => globalSync.data.project,
        (apiProjects) => {
          if (!server.isLocal()) return
          if (apiProjects.length === 0) return
          const apiWorktrees = new Set(apiProjects.map((p) => p.worktree))
          // server.projects.list() is read inside on() callback body → untracked
          const projects = server.projects.list()
          batch(() => {
            for (const project of projects) {
              if (!apiWorktrees.has(project.worktree)) {
                cleanupLog.push(`remove:${project.worktree}`)
                server.projects.remove(project.worktree)
              }
            }
          })
        },
      ),
    )

    return d
  })

  return { server, globalSync, cleanupLog, sandboxLog, dispose }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("project lifecycle — split effects", () => {
  test("opening a project does not trigger stale cleanup", () => {
    const { server, globalSync, cleanupLog, dispose } = setupLifecycleEffects()
    try {
      // Seed API with one existing project
      globalSync.setProject([{ worktree: "/projects/existing" }])
      server.projects.open("/projects/existing")

      // Reset log
      cleanupLog.length = 0

      // User opens a NEW project — not yet in API
      server.projects.open("/projects/new-one")

      // The cleanup effect should NOT have fired (it only tracks API data)
      expect(cleanupLog).toEqual([])

      // Verify the new project is still in sidebar
      const worktrees = server.projects.list().map((p) => p.worktree)
      expect(worktrees).toContain("/projects/new-one")
    } finally {
      dispose()
    }
  })

  test("API data change triggers cleanup of stale projects", () => {
    const { server, globalSync, cleanupLog, dispose } = setupLifecycleEffects()
    try {
      // Sidebar has two projects
      server.projects.open("/projects/a")
      server.projects.open("/projects/b")

      // API initially has both
      globalSync.setProject([{ worktree: "/projects/a" }, { worktree: "/projects/b" }])

      cleanupLog.length = 0

      // API changes: project B was deleted on another device
      globalSync.setProject([{ worktree: "/projects/a" }])

      // Cleanup should have removed /projects/b
      expect(cleanupLog).toContain("remove:/projects/b")

      const worktrees = server.projects.list().map((p) => p.worktree)
      expect(worktrees).toContain("/projects/a")
      expect(worktrees).not.toContain("/projects/b")
    } finally {
      dispose()
    }
  })

  test("project confirmed by API is not removed during cleanup", () => {
    const { server, globalSync, cleanupLog, dispose } = setupLifecycleEffects()
    try {
      // Sidebar has one project
      server.projects.open("/projects/a")

      // API confirms it
      globalSync.setProject([{ worktree: "/projects/a" }])

      cleanupLog.length = 0

      // Trigger API change (add another project)
      globalSync.setProject([{ worktree: "/projects/a" }, { worktree: "/projects/b" }])

      // /projects/a should NOT be removed
      expect(cleanupLog).not.toContain("remove:/projects/a")
      expect(server.projects.list().map((p) => p.worktree)).toContain("/projects/a")
    } finally {
      dispose()
    }
  })

  test("opening then confirming — full lifecycle without race", () => {
    const { server, globalSync, cleanupLog, dispose } = setupLifecycleEffects()
    try {
      // Start with one confirmed project
      globalSync.setProject([{ worktree: "/projects/existing" }])
      server.projects.open("/projects/existing")
      cleanupLog.length = 0

      // Step 1: User opens new project (sidebar only, not yet in API)
      server.projects.open("/projects/new")

      // No cleanup should fire
      expect(cleanupLog).toEqual([])

      // Step 2: API confirms the new project
      globalSync.setProject([{ worktree: "/projects/existing" }, { worktree: "/projects/new" }])

      // Cleanup fires but both projects are in API — nothing removed
      expect(cleanupLog.filter((l) => l.includes("/projects/new"))).toEqual([])

      const worktrees = server.projects.list().map((p) => p.worktree)
      expect(worktrees).toContain("/projects/existing")
      expect(worktrees).toContain("/projects/new")
    } finally {
      dispose()
    }
  })

  test("empty API data does not trigger cleanup", () => {
    const { server, globalSync, cleanupLog, dispose } = setupLifecycleEffects()
    try {
      // Sidebar has a project, API has no data yet
      server.projects.open("/projects/a")

      // API starts empty — should not clean up
      globalSync.setProject([])

      expect(cleanupLog).toEqual([])
      expect(server.projects.list().map((p) => p.worktree)).toContain("/projects/a")
    } finally {
      dispose()
    }
  })

  test("multiple stale projects removed in one API update", () => {
    const { server, globalSync, cleanupLog, dispose } = setupLifecycleEffects()
    try {
      // Sidebar has three projects
      server.projects.open("/projects/a")
      server.projects.open("/projects/b")
      server.projects.open("/projects/c")

      // API has all three
      globalSync.setProject([
        { worktree: "/projects/a" },
        { worktree: "/projects/b" },
        { worktree: "/projects/c" },
      ])
      cleanupLog.length = 0

      // API update: only project A remains
      globalSync.setProject([{ worktree: "/projects/a" }])

      expect(cleanupLog).toContain("remove:/projects/b")
      expect(cleanupLog).toContain("remove:/projects/c")
      expect(cleanupLog).not.toContain("remove:/projects/a")

      const worktrees = server.projects.list().map((p) => p.worktree)
      expect(worktrees).toEqual(["/projects/a"])
    } finally {
      dispose()
    }
  })
})

describe("project lifecycle — sandbox resolution", () => {
  test("sandbox directory is resolved to parent project", () => {
    const rootMap = new Map<string, string>([["/sandboxes/sb1", "/projects/parent"]])
    const rootFor = (dir: string) => rootMap.get(dir) ?? dir

    const { server, sandboxLog, dispose } = setupLifecycleEffects({ rootFor })
    try {
      // Open a sandbox directory
      server.projects.open("/sandboxes/sb1")

      // Should resolve to parent
      expect(sandboxLog).toContain("resolve:/sandboxes/sb1->/projects/parent")

      const worktrees = server.projects.list().map((p) => p.worktree)
      expect(worktrees).not.toContain("/sandboxes/sb1")
      expect(worktrees).toContain("/projects/parent")
    } finally {
      dispose()
    }
  })

  test("non-sandbox directory is left as-is", () => {
    const { server, sandboxLog, dispose } = setupLifecycleEffects()
    try {
      server.projects.open("/projects/regular")

      expect(sandboxLog).toEqual([])
      expect(server.projects.list().map((p) => p.worktree)).toContain("/projects/regular")
    } finally {
      dispose()
    }
  })

  test("expanded state transfers from sandbox to parent", () => {
    const rootMap = new Map<string, string>([["/sandboxes/sb1", "/projects/parent"]])
    const rootFor = (dir: string) => rootMap.get(dir) ?? dir

    const { server, dispose } = setupLifecycleEffects({ rootFor })
    try {
      // Batch open+expand so the effect sees expanded=true before resolving
      batch(() => {
        server.projects.open("/sandboxes/sb1")
        server.projects.expand("/sandboxes/sb1")
      })

      // After resolution, parent should exist and be expanded
      const parent = server.projects.list().find((p) => p.worktree === "/projects/parent")
      expect(parent).toBeTruthy()
      expect(parent!.expanded).toBe(true)
    } finally {
      dispose()
    }
  })
})

describe("project lifecycle — on() untracked contract", () => {
  test("on() callback body does not track reads of other signals", () => {
    let trigger!: () => number
    let setTrigger!: (v: number) => void
    let other!: () => string
    let setOther!: (v: string) => void
    const runs: Array<{ trigger: number; other: string }> = []

    const dispose = createRoot((d) => {
      const [t, st] = createSignal(0)
      const [o, so] = createSignal("initial")
      trigger = t
      setTrigger = st
      other = o
      setOther = so

      createEffect(
        on(trigger, () => {
          // Reading `other()` inside on() body — should be untracked
          runs.push({ trigger: trigger(), other: other() })
        }),
      )

      return d
    })

    try {
      // Initial run happened during createRoot's completeUpdates
      expect(runs).toHaveLength(1)
      expect(runs[0]).toEqual({ trigger: 0, other: "initial" })

      // Changing `other` should NOT re-run the effect
      setOther("changed")
      expect(runs).toHaveLength(1)

      // Changing `trigger` SHOULD re-run
      setTrigger(1)
      expect(runs).toHaveLength(2)
      expect(runs[1]).toEqual({ trigger: 1, other: "changed" })
    } finally {
      dispose()
    }
  })

  test("sidebar mutation does not trigger cleanup effect (structural proof)", () => {
    let apiData!: () => ApiProject[]
    let setApiData!: (v: ApiProject[]) => void
    let sidebarData!: () => string[]
    let setSidebarData!: (v: string[]) => void
    const cleanupRuns: number[] = []
    let runCount = 0

    const dispose = createRoot((d) => {
      const [a, sa] = createSignal<ApiProject[]>([])
      const [s, ss] = createSignal<string[]>([])
      apiData = a
      setApiData = sa
      sidebarData = s
      setSidebarData = ss

      // Mirrors the on() pattern from layout.tsx
      createEffect(
        on(
          () => apiData(),
          () => {
            // Reading sidebarData() here — untracked
            const sidebar = sidebarData()
            cleanupRuns.push(++runCount)
          },
        ),
      )

      return d
    })

    try {
      expect(cleanupRuns).toEqual([1]) // initial run

      // Mutating sidebar should NOT trigger cleanup
      setSidebarData(["/projects/a"])
      expect(cleanupRuns).toEqual([1])

      setSidebarData(["/projects/a", "/projects/b"])
      expect(cleanupRuns).toEqual([1])

      // Mutating API data SHOULD trigger cleanup
      setApiData([{ worktree: "/projects/a" }])
      expect(cleanupRuns).toEqual([1, 2])

      // Another sidebar mutation — still no cleanup trigger
      setSidebarData(["/projects/a", "/projects/b", "/projects/c"])
      expect(cleanupRuns).toEqual([1, 2])
    } finally {
      dispose()
    }
  })
})
