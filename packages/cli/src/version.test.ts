import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

import { cliVersion } from "./version"

describe("cliVersion", () => {
  test("is the version the package manifest declares", () => {
    const manifest = JSON.parse(readFileSync(path.join(import.meta.dir, "../package.json"), "utf8"))
    expect(cliVersion()).toBe(manifest.version)
  })
})
