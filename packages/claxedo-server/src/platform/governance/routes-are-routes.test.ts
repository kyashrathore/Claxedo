/**
 * Every file under a `routes/` directory builds a Hono router.
 *
 * A directory name is a claim about its contents. `routes/` claimed "HTTP
 * routing lives here" while half of it was business logic, helpers and
 * constants — so the claim told a reader nothing, and finding the code that
 * actually answers a request meant opening files to check. The worst cases were
 * a 389-line extension-support module and a `platform/http/routes/` directory
 * in which no file built a router at all.
 *
 * The rule cuts both ways, which is what makes it useful:
 *   - business logic in `routes/` moves to the domain
 *   - a router outside `routes/` is fine (composition roots mount them), so
 *     this only checks the direction that was actually being violated
 */

import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { walk } from "../../test-support/guards"

const SRC = path.resolve(import.meta.dirname, "../..")

/** `new Hono()` — the only way a router is constructed in this codebase. */
const BUILDS_ROUTER = /new Hono(?:<[^>]*>)?\s*\(/

function routeFiles() {
  return walk(SRC)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .filter((file) => path.relative(SRC, file).split(path.sep).includes("routes"))
}

describe("routes/ contains routes", () => {
  test("the check is not vacuous — routes/ directories exist and hold files", () => {
    // Without this, deleting every routes/ directory would pass the test below.
    expect(routeFiles().length).toBeGreaterThan(10)
  })

  test("every file under a routes/ directory builds a Hono router", () => {
    const offenders = routeFiles()
      .filter((file) => !BUILDS_ROUTER.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC, file))

    // A file here is business logic, a helper, or a constant table wearing a
    // routing name. Move it to the domain it belongs to.
    expect(offenders.toSorted()).toEqual([])
  })
})
