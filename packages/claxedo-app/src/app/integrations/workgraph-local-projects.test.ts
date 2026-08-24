import { describe, expect, test } from "bun:test"
import { workGraphLocalProjectOptions } from "./workgraph-local-projects"

describe("workGraphLocalProjectOptions", () => {
  test("offers an open project the control-plane catalog has not published yet", () => {
    // The rail renders the open-project list, which is populated before (and
    // independently of) the /project catalog. A project the user has open must be
    // selectable in New stream rather than leaving only "Choose another folder…".
    expect(workGraphLocalProjectOptions([{ worktree: "/Users/me/formlink", name: "formlink" }], [])).toEqual([
      { value: "/Users/me/formlink", label: "formlink" },
    ])
  })

  test("labels from the catalog-independent project name and falls back to the path", () => {
    expect(
      workGraphLocalProjectOptions(
        [
          { worktree: "/Users/me/formlink", name: "  " },
          { worktree: "/Users/me/claxedo", name: "Claxedo" },
        ],
        [{ worktree: "/Users/me/claxedo" }],
      ),
    ).toEqual([
      { value: "/Users/me/formlink", label: "/Users/me/formlink" },
      { value: "/Users/me/claxedo", label: "Claxedo" },
    ])
  })

  test("never offers a hosted workspace or a non-absolute directory as a local worktree", () => {
    const options = workGraphLocalProjectOptions(
      [{ worktree: "workspace:ws_cloud" }, { worktree: "relative/path" }, { worktree: "/Users/me/local" }],
      [
        {
          worktree: "workspace:ws_cloud",
          workspaces: { ws_cloud: { id: "ws_cloud", kind: "cloud", git_remote: "https://example.com/acme.git" } },
        },
      ],
    )
    expect(options).toEqual([{ value: "/Users/me/local", label: "/Users/me/local" }])
  })

  test("deduplicates repeated worktrees and drops blank ones", () => {
    expect(
      workGraphLocalProjectOptions([{ worktree: "/Users/me/a" }, { worktree: "/Users/me/a" }, { worktree: "   " }], []),
    ).toEqual([{ value: "/Users/me/a", label: "/Users/me/a" }])
  })
})
