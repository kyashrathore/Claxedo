import { describe, expect, test } from "bun:test"
import { buildDiffKindTree } from "./diff-kind-tree"

describe("buildDiffKindTree", () => {
  test("maps an added file and its ancestor directories to 'add'", () => {
    const tree = buildDiffKindTree([{ file: "src/app/main.ts", status: "added" }])
    expect(tree.get("src/app/main.ts")).toBe("add")
    expect(tree.get("src")).toBe("add")
    expect(tree.get("src/app")).toBe("add")
  })

  test("treats modified/renamed (non add/delete) status as 'mix'", () => {
    const tree = buildDiffKindTree([{ file: "a.ts", status: "modified" }])
    expect(tree.get("a.ts")).toBe("mix")
  })

  test("maps a deleted file to 'del'", () => {
    const tree = buildDiffKindTree([{ file: "old.ts", status: "deleted" }])
    expect(tree.get("old.ts")).toBe("del")
  })

  test("a directory with both added and deleted children becomes 'mix'", () => {
    const tree = buildDiffKindTree([
      { file: "src/new.ts", status: "added" },
      { file: "src/gone.ts", status: "deleted" },
    ])
    expect(tree.get("src/new.ts")).toBe("add")
    expect(tree.get("src/gone.ts")).toBe("del")
    expect(tree.get("src")).toBe("mix")
  })

  test("a directory whose children agree keeps the shared kind", () => {
    const tree = buildDiffKindTree([
      { file: "src/a.ts", status: "added" },
      { file: "src/b.ts", status: "added" },
    ])
    expect(tree.get("src")).toBe("add")
  })

  test("normalizes backslash separators and trailing slashes", () => {
    const tree = buildDiffKindTree([{ file: "src\\\\util\\\\", status: "added" }])
    expect(tree.get("src/util")).toBe("add")
    expect(tree.get("src")).toBe("add")
  })

  test("ignores empty ancestor segments and handles a bare filename", () => {
    const tree = buildDiffKindTree([{ file: "top.ts", status: "added" }])
    expect(tree.get("top.ts")).toBe("add")
    expect([...tree.keys()]).toEqual(["top.ts"])
  })

  test("later diffs merge into earlier directory entries", () => {
    const tree = buildDiffKindTree([
      { file: "src/a.ts", status: "added" },
      { file: "src/sub/c.ts", status: "deleted" },
    ])
    expect(tree.get("src")).toBe("mix")
    expect(tree.get("src/sub")).toBe("del")
  })
})
