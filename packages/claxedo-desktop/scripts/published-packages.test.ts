import { describe, expect, test } from "bun:test"
import * as path from "node:path"

import { publishedPackageNames } from "./published-packages"

const REPO_ROOT = path.resolve(import.meta.dir, "../../..")

describe("published packages the server bundle consumes from dist", () => {
  test("every published @claxedo package with a build is included, and no private one", () => {
    const names = publishedPackageNames(REPO_ROOT)
    expect(names).toContain("@claxedo/sandbox-manager")
    expect(names).toContain("@claxedo/egress-broker")
    expect(names).toContain("@claxedo/workspace-runtime")
    expect(names).not.toContain("@claxedo/server-core")
    expect(names).not.toContain("@claxedo/local-server")
    expect(names).not.toContain("@claxedo/desktop")
  })
})
