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
    // is emitted. The CSS the Solid components import is loaded by Vite,
    // which treats an absent hint as "has side effects" and keeps it.
    expect("sideEffects" in manifest).toBe(false)
  })
})
