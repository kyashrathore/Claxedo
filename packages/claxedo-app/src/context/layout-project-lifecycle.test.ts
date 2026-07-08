import { describe, expect, test } from "bun:test"
import { canAutoOpenProject, projectCatalog, resolveRoot, sandboxRoots } from "./layout-projects"
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
})
