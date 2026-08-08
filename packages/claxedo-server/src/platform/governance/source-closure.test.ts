import { describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { importSpecifiers, opaqueDynamicImports, packageNameOf, runtimeImportSpecifiers, shortestForbiddenChain, sourceClosure } from "./source-closure"

function fixture(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-closure-"))
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, contents)
  }
  return root
}

describe("importSpecifiers", () => {
  it("finds every shape this repository actually uses", () => {
    expect(importSpecifiers([
      `import a from "./a"`,
      `import { b } from './b'`,
      `import type { C } from "../c"`,
      `export { d } from "./d"`,
      `export * from "./e"`,
      `const f = await import("./f")`,
      `import "./g"`,
      `const h = require("./h")`,
    ].join("\n"))).toEqual(["./a", "./b", "../c", "./d", "./e", "./f", "./g", "./h"])
  })

  it("finds multi-line import lists, which is how most modules are written", () => {
    expect(importSpecifiers(`import {\n  one,\n  two,\n} from "./pair"`)).toEqual(["./pair"])
  })
})

describe("runtimeImportSpecifiers", () => {
  it("drops statements the compiler erases whole", () => {
    expect(runtimeImportSpecifiers([
      `import type { A } from "./erased"`,
      `export type { B } from "./also-erased"`,
      `import { c } from "./kept"`,
    ].join("\n"))).toEqual(["./kept"])
  })

  it("keeps a module that one statement imports as a type and another as a value", () => {
    // The value import loads the module; the type import next to it changes
    // nothing about that.
    expect(runtimeImportSpecifiers([
      `import type { Shape } from "./m"`,
      `import { build } from "./m"`,
    ].join("\n"))).toEqual(["./m"])
  })

  it("keeps an inline type specifier's module, because the statement still imports a value", () => {
    expect(runtimeImportSpecifiers(`import { type Shape, build } from "./m"`)).toEqual(["./m"])
  })
})

describe("opaqueDynamicImports", () => {
  it("reports a dynamic import whose specifier is a variable", () => {
    // This exact shape — with `@vite-ignore` — hid a shared module reaching back
    // into a product deployment, survived a package move, and broke at runtime
    // with nothing in the graph to show for it.
    expect(opaqueDynamicImports(`const m = "../x"\nawait import(/* @vite-ignore */ m)`)).toEqual(["m"])
  })

  it("ignores a literal specifier, which the walk CAN follow", () => {
    expect(opaqueDynamicImports(`await import("./known")`)).toEqual([])
  })
})

describe("packageNameOf", () => {
  it("keeps the scope but drops the subpath", () => {
    expect(packageNameOf("@claxedo/workspace-runtime/host")).toBe("@claxedo/workspace-runtime")
    expect(packageNameOf("hono/streaming")).toBe("hono")
    expect(packageNameOf("node:fs")).toBe("node:fs")
  })
})

describe("sourceClosure", () => {
  it("walks the first-party graph and records bare specifiers as dependencies", () => {
    const root = fixture({
      "entry.ts": `import "./mid"\nimport "hono/streaming"\nimport "node:fs"`,
      "mid.ts": `export * from "./leaf"\nimport "@claxedo/workspace-runtime/host"`,
      "leaf.ts": `export const leaf = 1`,
    })

    const closure = sourceClosure({ entry: path.join(root, "entry.ts"), root })

    expect(closure.modules.map((module) => module.relative)).toEqual(["entry.ts", "leaf.ts", "mid.ts"])
    // A dependency's internals are governed by its own manifest, so the walk
    // stops at the package boundary rather than descending into node_modules.
    expect(closure.packages).toEqual(["@claxedo/workspace-runtime", "hono", "node:fs"])
    expect(closure.unresolved).toEqual([])
  })

  it("resolves directory indexes and .js specifiers that stand for .ts sources", () => {
    const root = fixture({
      "entry.ts": `import "./feature"\nimport "./other.js"`,
      "feature/index.ts": `export const feature = 1`,
      "other.ts": `export const other = 1`,
    })

    expect(sourceClosure({ entry: path.join(root, "entry.ts"), root }).modules.map((m) => m.relative))
      .toEqual(["entry.ts", "feature/index.ts", "other.ts"])
  })

  it("survives an import cycle instead of walking it forever", () => {
    const root = fixture({
      "a.ts": `import "./b"`,
      "b.ts": `import "./a"`,
    })

    expect(sourceClosure({ entry: path.join(root, "a.ts"), root }).modules.map((m) => m.relative))
      .toEqual(["a.ts", "b.ts"])
  })

  it("reports a specifier that resolves to nothing rather than silently dropping it", () => {
    const root = fixture({ "entry.ts": `import "./missing"` })

    expect(sourceClosure({ entry: path.join(root, "entry.ts"), root }).unresolved)
      .toEqual(["entry.ts -> ./missing"])
  })
})

describe("sourceClosure opacity", () => {
  it("says when the graph contains an edge it cannot follow", () => {
    const root = fixture({
      "entry.ts": `const target = "./hidden"\nawait import(target)`,
      "hidden.ts": `export const hidden = 1`,
    })

    const closure = sourceClosure({ entry: path.join(root, "entry.ts"), root })

    // `hidden.ts` is genuinely reachable and genuinely absent from the walk.
    // The closure reports itself as a lower bound rather than as an answer.
    expect(closure.modules.map((m) => m.relative)).toEqual(["entry.ts"])
    expect(closure.opaque).toEqual(["entry.ts -> import(target)"])
  })

  it("reports nothing opaque for a graph of literal specifiers", () => {
    const root = fixture({ "entry.ts": `import "./ok"`, "ok.ts": `export const ok = 1` })
    expect(sourceClosure({ entry: path.join(root, "entry.ts"), root }).opaque).toEqual([])
  })
})

describe("sourceClosure with runtimeOnly", () => {
  it("stops at a type-only edge, so an erased import cannot report reachable surface", () => {
    const root = fixture({
      "entry.ts": `import type { Shape } from "./hosted"\nimport "./local"`,
      "hosted.ts": `import "./hosted-deep"\nexport type Shape = { id: string }`,
      "hosted-deep.ts": `export const deep = 1`,
      "local.ts": `export const local = 1`,
    })
    const entry = path.join(root, "entry.ts")

    expect(sourceClosure({ entry, root }).modules.map((m) => m.relative))
      .toEqual(["entry.ts", "hosted-deep.ts", "hosted.ts", "local.ts"])
    expect(sourceClosure({ entry, root, runtimeOnly: true }).modules.map((m) => m.relative))
      .toEqual(["entry.ts", "local.ts"])
  })
})

describe("shortestForbiddenChain", () => {
  it("reports the tightest coupling, not whichever branch a walk descended first", () => {
    const root = fixture({
      // Two routes reach `forbidden`: a direct one through `near`, and a long
      // one through the `deep` chain. A depth-first walk can report either.
      "entry.ts": `import "./deep1"\nimport "./near"`,
      "deep1.ts": `import "./deep2"`,
      "deep2.ts": `import "./deep3"`,
      "deep3.ts": `import "./forbidden"`,
      "near.ts": `import "./forbidden"`,
      "forbidden.ts": `export const forbidden = 1`,
    })

    const chain = shortestForbiddenChain({
      entry: path.join(root, "entry.ts"),
      root,
      isForbidden: (module) => module.relative === "forbidden.ts",
    })

    expect(chain?.map((module) => module.relative)).toEqual(["entry.ts", "near.ts", "forbidden.ts"])
  })

  it("returns null when the closure is clean", () => {
    const root = fixture({ "entry.ts": `import "./ok"`, "ok.ts": `export const ok = 1` })

    expect(shortestForbiddenChain({
      entry: path.join(root, "entry.ts"),
      root,
      isForbidden: (module) => module.relative === "forbidden.ts",
    })).toBeNull()
  })
})
