import { describe, expect, test } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { bundledDependencyDisagreements, packageImports, scriptFiles, undeclaredImports } from "../packed-imports"

function packedTree(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-packed-imports-"))
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), text)
  }
  return root
}

describe("packed-imports", () => {
  test("finds every package a tarball's JavaScript imports, and no builtin, relative file or require.resolve lookup", () => {
    const root = packedTree({
      "package.json": "{}",
      "dist/index.mjs": [
        `import fs from "node:fs"`,
        `import path from "path"`,
        `import { a } from "./chunk.mjs"`,
        `import { z } from "zod"`,
        `import "@scope/pkg/sub"`,
        `const late = await import("dyn-pkg")`,
        `export { fs, path, a, z, late }`,
      ].join("\n"),
      "dist/chunk.mjs": `import { index } from "@claxedo/self/file-index"\nexport const a = index`,
      "dist/legacy.cjs": `const r = require("req-pkg")\ntry { require.resolve("optional-pkg") } catch {}\nmodule.exports = r`,
      "dist/index.d.ts": `import type { X } from "types-only"\nexport type Y = X`,
    })
    expect(scriptFiles(root).map((file) => path.relative(root, file).split(path.sep).join("/"))).toEqual([
      "dist/chunk.mjs",
      "dist/index.mjs",
      "dist/legacy.cjs",
    ])

    const imports = packageImports(root, scriptFiles(root))
    expect([...imports.keys()].sort()).toEqual(["@claxedo/self", "@scope/pkg", "dyn-pkg", "req-pkg", "zod"])
    expect(undeclaredImports(imports, {
      name: "@claxedo/self",
      dependencies: { zod: "4.4.3" },
      peerDependencies: { "@scope/pkg": "^1.0.0" },
      optionalDependencies: { "dyn-pkg": "2.0.0" },
    })).toEqual(["req-pkg (imported by dist/legacy.cjs)"])
  })

  test("flags a dependency declared at a different version than a bundled sibling declares it, catalog resolved", () => {
    expect(bundledDependencyDisagreements(
      { name: "@claxedo/outer", dependencies: { hono: "4.12.34", zod: "4.4.3", "@claxedo/helpers": "0.2.0" } },
      [{ name: "@claxedo/inner", dependencies: { hono: "catalog:", zod: "4.4.2", "@claxedo/helpers": "workspace:*", other: "1.0.0" } }],
      { hono: "4.12.34" },
    )).toEqual(["dependencies.zod=4.4.3 but bundled @claxedo/inner declares 4.4.2"])
  })
})
