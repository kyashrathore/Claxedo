/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import type { FileNode } from "@/server"
import { treeRows, type TreeRow } from "./tree-rows"
import type { TreeDirState, TreeSource } from "./tree-source"

const file = (path: string): FileNode => ({ name: path.split("/").pop() ?? path, path, kind: "file", ignored: false })
const dir = (path: string): FileNode => ({ ...file(path), kind: "directory" })

function source(listings: Record<string, readonly FileNode[]>, expanded: readonly string[], states: Record<string, Partial<TreeDirState>> = {}): TreeSource {
  return {
    children: (path) => listings[path] ?? [],
    state: (path) => ({ expanded: path === "" || expanded.includes(path), loaded: path in listings, loading: false, error: undefined, retry: () => undefined, ...states[path] }),
    expand: () => undefined,
    collapse: () => undefined,
  }
}

const describeRow = (row: TreeRow) => (row.kind === "node" ? `${"  ".repeat(row.level)}${row.node.path}` : row.kind === "more" ? `more ${row.side} ${row.count} ${row.dir}` : row.kind)
const flat = { batchSize: Number.POSITIVE_INFINITY, active: undefined, batches: () => ({ before: 0, after: 0 }) }

describe("treeRows", () => {
  test("walks expanded folders depth first, in the order the tree draws them", () => {
    const rows = treeRows({ ...flat, source: source({ "": [dir("src"), dir("docs"), file("top.md")], src: [file("src/a.ts")], docs: [file("docs/b.md")] }, ["src"]) })
    expect(rows.map(describeRow)).toEqual(["src", "  src/a.ts", "docs", "top.md"])
  })

  test("draws a loading row for an expanded folder still being listed", () => {
    const rows = treeRows({ ...flat, source: source({ "": [dir("src")] }, ["src"], { src: { loading: true } }) })
    expect(rows.map(describeRow)).toEqual(["src", "loading"])
  })

  test("shows a batch of the listing around the active file with Show more on either side", () => {
    const names = Array.from({ length: 10 }, (_, index) => file(`f${index}.ts`))
    const rows = treeRows({ source: source({ "": names }, []), active: "f5.ts", batchSize: 3, batches: () => ({ before: 0, after: 0 }) })
    expect(rows.map(describeRow)).toEqual(["more before 3 ", "f3.ts", "f4.ts", "f5.ts", "more after 3 "])
  })

  test("draws a folder that repeats one of its ancestors, then stops under it", () => {
    const rows = treeRows({ ...flat, source: source({ "": [dir("a")], a: [dir("a/")] }, ["a", "a/"]) })
    expect(rows.map(describeRow)).toEqual(["a", "  a/", "cycle"])
  })
})
