/// <reference types="bun" />
import { expect, onTestFinished, test } from "bun:test"
import { batch, createSignal } from "solid-js"
import { createWorkspaceServer, FIXTURE_PLACEMENT } from "@/lib/test-workspace-server"
import { createTreeSource, type TreeExpansion, type TreeSource } from "./tree-source"

function createExpansion(open: readonly string[]): TreeExpansion {
  const [expanded, setExpanded] = createSignal<readonly string[]>(open)
  const without = (dir: string) => expanded().filter((known) => known !== dir)
  return {
    expanded: (dir) => expanded().includes(dir),
    expandedDirs: expanded,
    setExpanded: (dir, next) => setExpanded(next ? [...without(dir), dir] : without(dir)),
  }
}

const names = (source: TreeSource, dir: string) => source.children(dir).map((node) => node.name)

test("tree source: when one folder closes and another opens in the same batch, every open folder shows its own listing", async () => {
  const workspace = createWorkspaceServer({ "": ["alpha", "bravo", "charlie"], alpha: ["alpha-1"], bravo: ["bravo-1"], charlie: ["charlie-1"] })
  onTestFinished(workspace.dispose)
  const expansion = createExpansion(["alpha", "bravo"])
  const source = workspace.mount(() => createTreeSource(expansion, () => FIXTURE_PLACEMENT, () => true))
  await workspace.loaded(["", "alpha", "bravo"])
  batch(() => {
    source.collapse("alpha")
    source.expand("charlie")
  })
  expect(names(source, "bravo")).toEqual(["bravo-1"])
  await workspace.loaded(["charlie"])
  expect(["", "bravo", "charlie"].map((dir) => names(source, dir))).toEqual([["alpha", "bravo", "charlie"], ["bravo-1"], ["charlie-1"]])
})
