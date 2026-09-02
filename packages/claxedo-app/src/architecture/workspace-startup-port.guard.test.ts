import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { allImportSpecifiers, importSpecifiers, resolveImport, shortestForbiddenImportChain } from "./import-graph"
import { prodSourcePaths } from "./scanners"

const appRoot = path.resolve(import.meta.dir, "../..")
const srcRoot = path.join(appRoot, "src")
const HOSTED_ROOT = "platform/runtime/cloud/"

/** Only these modules may import the hosted startup implementation. Everyone else uses `workspaceStartup()`. */
const ALLOWED_IMPORTERS = ["app/entry/main.tsx", "features/workspaces/data/workspace-connection.ts"] as const

function hostedImporters() {
  const found = new Set<string>()
  for (const file of prodSourcePaths(appRoot)) {
    const from = path.relative(srcRoot, file).split(path.sep).join("/")
    if (from.startsWith(HOSTED_ROOT)) continue
    const hits = allImportSpecifiers(readFileSync(file, "utf8")).some((specifier) => {
      const resolved = resolveImport(appRoot, file, specifier)
      return resolved && path.relative(srcRoot, resolved).split(path.sep).join("/").startsWith(HOSTED_ROOT)
    })
    if (hits) found.add(from)
  }
  return found
}

const reachesHosted = (entry: string) =>
  shortestForbiddenImportChain({
    appRoot,
    entry,
    isForbidden: ({ module }) => !!module && module.startsWith(HOSTED_ROOT),
  })

describe("cloud workspace startup stays behind the port", () => {
  test("only the hosted entry and connection authority import the implementation", () => {
    expect([...hostedImporters()].toSorted()).toEqual([...ALLOWED_IMPORTERS])
  })

  test("the port and the runtime record do not reach hosted code", () => {
    expect(reachesHosted("platform/runtime/workspace-startup.ts")).toBeNull()
    expect(reachesHosted("platform/runtime/workspace-runtime-record.ts")).toBeNull()
    expect(reachesHosted("app/entry/main.tsx")).not.toBeNull()
  })

  test("the port file has no value imports", () => {
    const contract = readFileSync(path.join(srcRoot, "platform/runtime/workspace-startup-port.ts"), "utf8")
    expect(importSpecifiers(contract)).toEqual([])
    expect(allImportSpecifiers(contract).toSorted()).toEqual(["./workspace-log", "./workspace-runtime"])
  })

  test("hosted entry binds the implementation; local entry does not", () => {
    const main = readFileSync(path.join(srcRoot, "app/entry/main.tsx"), "utf8")
    expect(importSpecifiers(main)).toContain("@/platform/runtime/workspace-startup")
    expect(importSpecifiers(main)).toContain("@/platform/runtime/cloud/workspace-runtime-store")
    expect(main).toMatch(/configureWorkspaceStartup\(\s*cloudWorkspaceStartup\s*\)/)

    const local = importSpecifiers(readFileSync(path.join(srcRoot, "app/entry/local.tsx"), "utf8"))
    expect(local.filter((specifier) => specifier.includes("runtime/cloud"))).toEqual([])
    expect(local.filter((specifier) => specifier.includes("workspace-startup"))).toEqual([])
  })

  test("only the hosted entry calls configureWorkspaceStartup", () => {
    const callers = prodSourcePaths(appRoot)
      .map((file) => path.relative(srcRoot, file).split(path.sep).join("/"))
      .filter((module) => module !== "platform/runtime/workspace-startup.ts")
      .filter((module) => /\bconfigureWorkspaceStartup\s*\(/.test(readFileSync(path.join(srcRoot, module), "utf8")))
      .toSorted()
    expect(callers).toEqual(["app/entry/main.tsx"])
  })

  test("local entry still reaches hosted startup only through workspace-connection", () => {
    const breach = reachesHosted("app/entry/local.tsx")
    expect(breach, "if this chain is gone, tighten to toBeNull()").not.toBeNull()
    expect(breach!.module).toBe("platform/runtime/cloud/workspace-runtime-store.ts")
    expect(breach!.chain.at(-1)).toBe("features/workspaces/data/workspace-connection.ts")
  })
})
