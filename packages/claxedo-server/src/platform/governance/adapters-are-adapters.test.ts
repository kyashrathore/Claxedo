/**
 * `adapters/` holds adapters, and nothing else.
 *
 * An adapter implements a port against something EXTERNAL — a vendor SDK, a
 * `@claxedo/*` package, a network protocol. That is falsifiable: an adapter
 * that imports nothing external is not adapting anything.
 *
 * The directory had drifted to mean "code I did not know where else to put":
 * `credentials/` and `sandbox/` were full domains (their own `routes/`,
 * `operations/` and tables) filed as adapters, and `provider-auth/` imported
 * nothing external at all — it was a domain service two levels down a path that
 * claimed otherwise.
 */

import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { walk } from "../../test-support/guards"

const SRC = path.resolve(import.meta.dirname, "../..")
const ADAPTERS = path.join(SRC, "adapters")

/** A bare specifier — a package, not a relative path inside this tree. */
const EXTERNAL_IMPORT = /(?:^|\n)\s*import\s(?:type\s)?[^"';]*from\s*["']([^."'][^"']*)["']/g

function adapterDirs() {
  return fs
    .readdirSync(ADAPTERS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
}

function externalImportsIn(dir: string) {
  const found = new Set<string>()
  for (const file of walk(path.join(ADAPTERS, dir))) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue
    for (const match of fs.readFileSync(file, "utf8").matchAll(EXTERNAL_IMPORT)) {
      // node: builtins are available everywhere and adapt nothing.
      if (!match[1]!.startsWith("node:")) found.add(match[1]!)
    }
  }
  return [...found]
}

describe("adapters/ contains adapters", () => {
  test("the check is not vacuous — adapters/ exists and holds subdirectories", () => {
    expect(adapterDirs().length).toBeGreaterThan(0)
  })

  test("every adapter imports something external, because that is what it adapts", () => {
    const offenders = adapterDirs().filter((dir) => externalImportsIn(dir).length === 0)

    // A directory here adapts nothing: it is a domain, a helper, or dead.
    expect(offenders.toSorted()).toEqual([])
  })

  test("no adapter owns HTTP routes — a directory with routes/ is a domain", () => {
    // `routes/`, `operations/` and a table definition are what a DOMAIN has.
    // An adapter implements a port; it does not serve the product's API.
    const offenders = adapterDirs().filter((dir) =>
      fs.existsSync(path.join(ADAPTERS, dir, "routes")),
    )

    expect(offenders.toSorted()).toEqual([])
  })
})
