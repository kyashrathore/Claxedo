/**
 * Two things this must prove, and one it must NOT do.
 *
 * 1. The defect is still present in the installed `@opencode-ai/core`. This is
 *    the deletion trigger: when upstream fixes the cycle and we bump the pin,
 *    this test fails and names the files to remove. A repair kept past its
 *    usefulness is a permanent fork by another name.
 * 2. The repair makes real SDK calls work — not that an array element changed.
 *    `config.get`, `agent.list` and `provider.list` are the surfaces that
 *    return an empty 500 without it.
 *
 * Both run in SUBPROCESSES with a clean module graph. `repairCoreLayerGraph()`
 * mutates a module-scope object, so an in-process assertion would depend on
 * which test file ran first — exactly the kind of order coupling that makes a
 * suite lie.
 */
import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import * as path from "node:path"

const packageRoot = path.resolve(import.meta.dir, "..")

function run(source: string): string {
  return execFileSync(process.execPath, ["-e", source], {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  }).trim()
}

describe("published @opencode-ai/core layer graph", () => {
  test("still ships the filesystem/search cycle this repair exists for", () => {
    const holes = run(`
      const { FileSystem } = await import("@opencode-ai/core/filesystem")
      const deps = FileSystem.node.dependencies
      console.log(JSON.stringify(deps.map((d) => (d === undefined ? null : d.name))))
    `)
    // If this fails with no nulls, upstream fixed it: delete src/upstream-repair.ts,
    // this file, the repairCoreLayerGraph() call in host.ts, the index.ts
    // re-exports, and the @opencode-ai/core dependency in package.json.
    expect(JSON.parse(holes)).toEqual(["@opencode/FSUtil", "@opencode/Location", null])
  })

  test("the repair fills the hole with the search node", () => {
    const after = run(`
      const { repairCoreLayerGraph } = await import("./src/upstream-repair.ts")
      const { FileSystem } = await import("@opencode-ai/core/filesystem")
      const first = repairCoreLayerGraph()
      const second = repairCoreLayerGraph()
      console.log(JSON.stringify({
        first,
        second,
        deps: FileSystem.node.dependencies.map((d) => (d === undefined ? null : d.name)),
      }))
    `)
    expect(JSON.parse(after)).toEqual({
      first: { repaired: true, node: "@opencode/FileSystem", dependency: "@opencode/FileSystem/Search", index: 2 },
      second: { repaired: false, reason: "already-repaired" },
      deps: ["@opencode/FSUtil", "@opencode/Location", "@opencode/FileSystem/Search"],
    })
  })

  test("without the repair the location surfaces 500; with it they answer", () => {
    const probe = (repair: boolean) => `
      ${repair ? `const { repairCoreLayerGraph } = await import("./src/upstream-repair.ts"); repairCoreLayerGraph();` : ""}
      const { OpenCode } = await import("@opencode-ai/sdk")
      const fs = await import("node:fs"), os = await import("node:os"), p = await import("node:path")
      const dir = fs.mkdtempSync(p.join(os.tmpdir(), "repair-"))
      fs.writeFileSync(p.join(dir, "README.md"), "# probe\\n")
      const oc = await OpenCode.create({ database: { path: p.join(dir, "oc.db") } })
      const out = {}
      for (const name of ["config", "agent", "provider"]) {
        try {
          await (name === "config" ? oc.config.get({ location: { directory: dir } })
                                   : oc[name].list({ location: { directory: dir } }))
          out[name] = "ok"
        } catch (error) { out[name] = "status " + (error?.cause?.status ?? error?.name) }
      }
      await oc.close()
      fs.rmSync(dir, { recursive: true, force: true })
      console.log(JSON.stringify(out))
    `
    expect(JSON.parse(run(probe(false)))).toEqual({ config: "status 500", agent: "status 500", provider: "status 500" })
    expect(JSON.parse(run(probe(true)))).toEqual({ config: "ok", agent: "ok", provider: "ok" })
  }, 180_000)
})
