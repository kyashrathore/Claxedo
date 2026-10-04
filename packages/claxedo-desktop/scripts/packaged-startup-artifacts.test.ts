import { describe, expect, test } from "bun:test"
import * as path from "node:path"

import { isMinifiedScript, unresolvedCompileCacheEntries } from "./packaged-startup-artifacts"

const manifest = (files: string[]) =>
  JSON.stringify({ version: 1, entries: files.map((file) => ({ file, type: "esm", blob: `${file}.v8cache`, bytes: 1 })) })

describe("packaged startup artifacts", () => {
  test("a bundle with long lines is minified and one statement per line is not", () => {
    const minified = `${"var a=1;".repeat(400)}\n${"var b=2;".repeat(400)}`
    const unminified = Array.from({ length: 400 }, (_, i) => `const value${i} = ${i};`).join("\n")

    expect(isMinifiedScript(minified)).toBe(true)
    expect(isMinifiedScript(unminified)).toBe(false)
  })

  test("a minified bundle carrying a multi-line CSS string still counts as minified", () => {
    const css = Array.from({ length: 300 }, (_, i) => `  .rule-${i} { padding: 12px; }`).join("\n")
    const text = `${"var a=1;".repeat(2000)}\`${css}\`;${"var b=2;".repeat(2000)}`

    expect(isMinifiedScript(text)).toBe(true)
  })

  test("a dependency packaged into Resources/node_modules resolves from the bundle root", () => {
    const resources = path.join(path.sep, "App.app", "Contents", "Resources")
    const bundle = path.join(resources, "app.asar", "out", "main", "claxedo-server")
    const shipped = new Set([
      path.join(bundle, "chunks", "boot.js"),
      path.join(resources, "node_modules", "effect", "dist", "Equivalence.js"),
    ])

    const unresolved = unresolvedCompileCacheEntries(
      manifest(["chunks/boot.js", "node_modules/effect/dist/Equivalence.js", "node_modules/gone/index.js", "chunks/gone.js"]),
      bundle,
      (file) => shipped.has(file),
    )

    expect(unresolved).toEqual(["node_modules/gone/index.js", "chunks/gone.js"])
  })
})
