import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const manifest = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf8")) as Record<string, unknown>

describe("@claxedo/tasks package manifest", () => {
  test("declares no sideEffects hint, because Bun's split bundle drops every module of a package that carries one", () => {
    // Measured 2026-09-13 on the desktop claxedo-server bundle (Bun.build,
    // splitting on): with `"sideEffects": ["**/*.css"]` present, the bundle
    // kept the call to `serializedTransactions` and dropped its definition,
    // along with the routes, services and commands, and the packaged server
    // threw a ReferenceError at startup. Without the hint every definition
    // is emitted.
    expect("sideEffects" in manifest).toBe(false)
  })

  test("opens one door per responsibility, and the two test-only ones are not the production entry", () => {
    expect(Object.keys(manifest.exports as Record<string, unknown>)).toEqual([
      ".",
      "./http",
      "./client",
      "./conformance",
      "./test-support",
    ])
  })
})
