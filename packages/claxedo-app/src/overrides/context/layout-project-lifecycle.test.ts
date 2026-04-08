import { describe, expect, test } from "bun:test"
import { canAutoOpenProject, projectCatalog, resolveRoot, sandboxRoots } from "./layout-projects"

describe("layout project catalog", () => {
  test("resolves sandbox directories to their root project", () => {
    const roots = sandboxRoots([
      {
        id: "proj_a",
        worktree: "/projects/a",
        time: { created: 1, updated: 1 },
        sandboxes: ["/projects/a/sb-1", "/projects/a/sb-2"],
      },
    ] as any)

    expect(resolveRoot(roots, "/projects/a")).toBe("/projects/a")
    expect(resolveRoot(roots, "/projects/a/sb-1")).toBe("/projects/a")
    expect(resolveRoot(roots, "/projects/a/sb-2")).toBe("/projects/a")
  })

  test("keeps sidebar order while appending API projects that are not in local UI state", () => {
    const catalog = projectCatalog({
      api: [
        {
          id: "proj_a",
          worktree: "/projects/a",
          time: { created: 1, updated: 1 },
          sandboxes: [],
        },
        {
          id: "proj_b",
          worktree: "/projects/b",
          time: { created: 1, updated: 1 },
          sandboxes: [],
        },
      ] as any,
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
        {
          id: "proj_a",
          worktree: "/projects/a",
          time: { created: 1, updated: 1 },
          sandboxes: ["/projects/a/sb-1"],
        },
      ] as any,
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
        {
          id: "proj_a",
          worktree: "/projects/a",
          time: { created: 1, updated: 1 },
          sandboxes: [],
        },
      ] as any,
      current: [],
      closed: (directory) => directory === "/projects/a",
      valid: () => true,
    })

    expect(catalog.list).toEqual([])
  })

  test("does not surface local-only roots that are missing from the API catalog", () => {
    const catalog = projectCatalog({
      api: [
        {
          id: "proj_a",
          worktree: "/projects/a",
          time: { created: 1, updated: 1 },
          sandboxes: [],
        },
      ] as any,
      current: [
        { worktree: "/projects/a", expanded: true },
        { worktree: "/projects/ghost", expanded: true },
      ],
      closed: () => false,
      valid: () => true,
    })

    expect(catalog.list).toEqual([{ worktree: "/projects/a", expanded: true }])
  })

  test("does not auto-open a closed sandbox root", () => {
    expect(canAutoOpenProject({
      api: [
        {
          id: "proj_a",
          worktree: "/projects/a",
          time: { created: 1, updated: 1 },
          sandboxes: ["/projects/a/sb-1"],
        },
      ] as any,
      list: [],
      dir: "/projects/a/sb-1",
      closed: (directory) => directory === "/projects/a",
    })).toBe(false)
  })

  test("auto-opens when the workspace is missing and not closed", () => {
    expect(canAutoOpenProject({
      api: [
        {
          id: "proj_a",
          worktree: "/projects/a",
          time: { created: 1, updated: 1 },
          sandboxes: ["/projects/a/sb-1"],
        },
      ] as any,
      list: [],
      dir: "/projects/a/sb-1",
      closed: () => false,
    })).toBe(true)
  })
})
