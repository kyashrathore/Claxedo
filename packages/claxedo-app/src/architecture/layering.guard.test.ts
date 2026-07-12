import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  directoryCycles,
  directoryCyclesFromEdges,
  directoryImportEdgesFromFiles,
  newDirectoryCycles,
  staleDirectoryCycles,
  topLevelDir,
} from "./layering"
import baseline from "./layering-baseline.json"

const appRoot = path.resolve(import.meta.dir, "../..")

describe("directory layering guard", () => {
  test("topLevelDir names the owning directory and treats root files as unowned", () => {
    expect(topLevelDir("claxedo-ui/components/foo.tsx")).toBe("claxedo-ui")
    expect(topLevelDir("shell/boot/data/bootstrap.ts")).toBe("shell")
    expect(topLevelDir("app.tsx")).toBeNull()
  })

  test("does not introduce a new cross-directory import cycle beyond the baseline", () => {
    const offenders = newDirectoryCycles(directoryCycles(appRoot), baseline).map(
      (pair) => `${pair}: new bidirectional import cycle -- import in one direction only, or add a documented exception`,
    )

    expect(offenders).toEqual([])
  })

  test("keeps the layering baseline pruned as cycles are untangled", () => {
    const offenders = staleDirectoryCycles(directoryCycles(appRoot), baseline).map(
      (pair) => `${pair}: no longer a cycle -- remove it from layering-baseline.json`,
    )

    expect(offenders).toEqual([])
  })
})

describe("directory layering guard (synthetic cycle detection)", () => {
  test("flags a bidirectional 2-node cycle between two directories", () => {
    expect(
      directoryCyclesFromEdges([
        { from: "context", to: "shell" },
        { from: "shell", to: "context" },
      ]),
    ).toEqual(["context<->shell"])
  })

  test("does not flag a one-directional import between two directories", () => {
    expect(directoryCyclesFromEdges([{ from: "context", to: "shell" }])).toEqual([])
  })

  test("extracts cross-directory edges from source text via an injected resolver and detects the resulting cycle", () => {
    const files = [
      { path: "context/a.ts", text: `import { b } from "../shell/b"` },
      { path: "shell/b.ts", text: `import { a } from "../context/a"` },
    ]
    const resolve = (fromRelFile: string, specifier: string) => {
      if (fromRelFile === "context/a.ts" && specifier === "../shell/b") return "shell/b.ts"
      if (fromRelFile === "shell/b.ts" && specifier === "../context/a") return "context/a.ts"
      return null
    }

    const edges = directoryImportEdgesFromFiles(files, resolve)
    expect(directoryCyclesFromEdges(edges)).toEqual(["context<->shell"])
  })

  test("does not flag same-directory or unresolvable imports", () => {
    const files = [
      { path: "context/a.ts", text: `import { b } from "./b"` },
      { path: "context/b.ts", text: `import { external } from "some-package"` },
    ]
    const resolve = (fromRelFile: string, specifier: string) => {
      if (fromRelFile === "context/a.ts" && specifier === "./b") return "context/b.ts"
      return null
    }

    expect(directoryCyclesFromEdges(directoryImportEdgesFromFiles(files, resolve))).toEqual([])
  })

  test("newDirectoryCycles fails on a cycle absent from the baseline", () => {
    expect(newDirectoryCycles(["a<->b"], [])).toEqual(["a<->b"])
    expect(newDirectoryCycles(["a<->b"], ["a<->b"])).toEqual([])
  })

  test("staleDirectoryCycles demands pruning once a baseline cycle is resolved", () => {
    expect(staleDirectoryCycles([], ["a<->b"])).toEqual(["a<->b"])
    expect(staleDirectoryCycles(["a<->b"], ["a<->b"])).toEqual([])
  })
})
