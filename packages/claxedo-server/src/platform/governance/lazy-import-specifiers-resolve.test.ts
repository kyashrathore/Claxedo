/**
 * Every bundler-hidden lazy import specifier must resolve to a real module.
 *
 * NOTE (2026-08-08): there are no such call sites left — all three became
 * ports. This guard now asserts that, and keeps the resolver so a
 * reintroduced one is still checked. The rest of this comment records why the
 * pattern existed and why it was worth removing.
 *
 * A handful of call sites held their specifier in a variable
 * (`const embeddedMod = "../deployments/local/…"`) precisely so esbuild/Vite
 * cannot follow the edge — the targets are Node-only deployment modules that
 * must not land in a Worker build. The cost of that trick is that tsc cannot
 * see the edge either: a directory reorg that moves the importer or the target
 * leaves the string pointing at nothing, typecheck stays green, every unit
 * suite stays green, and the failure surfaces as a runtime
 * `ERR_MODULE_NOT_FOUND` the first time a live server executes the branch —
 * which is exactly how the 2026-08 reorg broke `sandboxFetch` for local
 * workspaces with zero red tests.
 *
 * This guard finds each vite-ignore `import(<variable>)` call, walks
 * back to the variable's string-literal assignment in the same file, resolves
 * it relative to that file, and asserts a module is there. It fails loudly on
 * a variable it cannot trace, so a new hidden import cannot opt out silently.
 */

import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { walk } from "../../test-support/guards"

const SRC = path.resolve(import.meta.dirname, "../..")

const LAZY_IMPORT = /import\(\s*\/\*\s*@vite-ignore\s*\*\/\s*([A-Za-z_$][\w$]*)\s*\)/g

function moduleExists(base: string): boolean {
  return ["", ".ts", ".tsx", ".mts", ".js", ".mjs", "/index.ts"].some((suffix) => {
    const candidate = base + suffix
    return fs.existsSync(candidate) && (suffix !== "" || fs.statSync(candidate).isFile())
  })
}

describe("lazy import specifiers", () => {
  test("every variable-held @vite-ignore specifier resolves from its importer", () => {
    const failures: string[] = []
    let sites = 0
    for (const file of walk(SRC)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue
      const source = fs.readFileSync(file, "utf8")
      for (const match of source.matchAll(LAZY_IMPORT)) {
        sites++
        const variable = match[1]!
        const assignment = new RegExp(`(?:const|let)\\s+${variable}\\s*=\\s*["']([^"']+)["']`).exec(source)
        const rel = path.relative(SRC, file)
        if (!assignment) {
          failures.push(`${rel}: cannot trace \`${variable}\` to a string-literal assignment`)
          continue
        }
        const specifier = assignment[1]!
        if (!specifier.startsWith(".")) continue // bare specifiers are package deps, resolved by Node
        if (!moduleExists(path.resolve(path.dirname(file), specifier))) {
          failures.push(`${rel}: \`${variable}\` = "${specifier}" resolves to nothing`)
        }
      }
    }
    expect(failures).toEqual([])
    // There are now ZERO of these, and that is the point.
    //
    // All three call sites reached a Node-only deployment module from shared
    // code, hiding the edge from the bundler on purpose. They are ports now
    // (`workspace/local-runtime-port.ts`, `workspace/supervisor-port.ts`),
    // which keeps the Worker build clean AND leaves the edge visible to tsc,
    // to import rewriters, and to the closure walker.
    //
    // The resolver above stays: a new hidden import must still point at a real
    // module. This assertion is the stronger statement — do not reintroduce
    // the pattern. If a case genuinely needs it, this line is where to argue
    // for it.
    expect(sites).toBe(0)
  })
})
