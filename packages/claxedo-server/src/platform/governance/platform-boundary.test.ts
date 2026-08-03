import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { walk } from "../../test-support/guards"

/**
 * Platform never imports a domain. Domains import platform. Deployments compose
 * both. Once platform may reach into a domain, "shared machinery" and "this
 * feature's code" stop being distinguishable and the tree re-entangles.
 *
 * A violation is any relative import from a file under `platform/` that
 * resolves outside `platform/` and inside `src/`. Package imports (`@claxedo/*`,
 * `hono`) are fine. A TYPE-ONLY import still counts: it couples platform to a
 * domain's shape, and a type import becomes a value import later.
 */

const SRC = path.resolve(import.meta.dirname, "../..")
const PLATFORM = path.join(SRC, "platform")

const RELATIVE_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bvi\.(?:do)?mock\(\s*)["'](\.\.?\/[^"']+)["']/g

function platformFiles() {
  return walk(PLATFORM).filter((file) => file.endsWith(".ts") || file.endsWith(".mjs"))
}

/**
 * The one sanctioned inversion: drizzle needs a single module naming every
 * table, so `platform/db/schema.ts` re-exports the domains' table definitions
 * and holds no logic. Knowledge still flows the right way — the barrel names
 * the modules, the domains never learn about the barrel.
 *
 * Scoped to `*.sql` targets only: schema.ts importing a domain's SERVICE still
 * fails, which is the failure mode worth guarding.
 */
const SCHEMA_BARREL = path.join("platform", "db", "schema.ts")

function escapes(file: string) {
  const text = fs.readFileSync(file, "utf8")
  const rel = path.relative(SRC, file)
  const out: string[] = []
  for (const match of text.matchAll(RELATIVE_IMPORT)) {
    const target = path.relative(SRC, path.resolve(path.dirname(file), match[1]!))
    // Leaves src/ entirely (sibling packages, repo-root convex/) — not a domain.
    if (target.startsWith("..")) continue
    if (target.split(path.sep)[0] === "platform") continue
    if (rel === SCHEMA_BARREL && target.endsWith(".sql")) continue
    out.push(`${rel} -> ${target}`)
  }
  return out
}

describe("platform boundary", () => {
  test("no production file under platform/ imports a domain", () => {
    const offenders = platformFiles()
      .filter((file) => !file.endsWith(".test.ts"))
      .flatMap(escapes)
      .sort()

    expect(offenders).toEqual([])
  })

  /**
   * Tests are held to a weaker rule deliberately: a platform test may compose a
   * real deployment or drive a domain route to prove the layer works in situ,
   * and banning that would push those tests into asserting against mocks.
   *
   * What the count prevents is a PRODUCTION module acquiring a domain
   * dependency by hiding behind a test file. It may shrink freely; raising it
   * is a deliberate edit here.
   */
  test("platform test files keep their domain reach bounded", () => {
    const offenders = platformFiles()
      .filter((file) => file.endsWith(".test.ts"))
      .flatMap(escapes)

    // 37 -> 38 for governance/no-declare-class-fields.test.ts. The escape it
    // adds is `test-support/guards`, the shared walker every guard in this
    // directory imports — not a domain dependency, which is what the count is
    // watching for.
    expect(offenders.length).toBeLessThanOrEqual(38)
  })
})
