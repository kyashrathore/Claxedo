import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { walk } from "../../test-support/guards"

/**
 * platform never imports a domain. domains import platform.
 * deployments compose both.
 *
 * `platform/` is organized by LAYER (http, db, auth, telemetry, runtime,
 * governance) — reusable machinery that knows nothing about any feature.
 * Domains are organized by FEATURE and consume those layers. The direction of
 * that dependency is the whole point of the split: once platform is allowed to
 * reach into a domain, "shared machinery" and "this feature's code" stop being
 * distinguishable and the tree re-entangles.
 *
 * The previous implicit version of this rule rotted precisely because nothing
 * checked it. Three passes each optimized a different axis and left the
 * previous one half-applied.
 *
 * WHAT COUNTS AS A VIOLATION: any relative import from a file under
 * `platform/` that resolves outside `platform/` and inside `src/`. Package
 * imports (`@claxedo/*`, `hono`) are fine — platform is allowed to depend on
 * libraries. A *type-only* import is still a violation: it couples platform to
 * a domain's shape, and this codebase has repeatedly seen a type import become
 * a value import later.
 */

// This file lives at src/platform/governance/, so src/ is two levels up.
const SRC = path.resolve(import.meta.dirname, "../..")
const PLATFORM = path.join(SRC, "platform")

const RELATIVE_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bvi\.(?:do)?mock\(\s*)["'](\.\.?\/[^"']+)["']/g

function platformFiles() {
  return walk(PLATFORM).filter((file) => file.endsWith(".ts") || file.endsWith(".mjs"))
}

/**
 * The one sanctioned inversion, and why it is narrow.
 *
 * Each domain owns its own table definitions (`channels/delivery.sql.ts`), so a
 * change to that domain touches one directory. But drizzle needs a single place
 * that names every table — the migration generator and `ClaxedoDB` both read
 * the whole schema. So `platform/db/schema.ts` is a BARREL: it re-exports the
 * domains' tables and holds no logic of its own.
 *
 * This is a dependency inversion, not a leak, because the direction of KNOWLEDGE
 * still runs the right way — the barrel names modules, the domains never learn
 * about the barrel. It is scoped to this single file, and only for `*.sql`
 * targets: schema.ts importing a domain's SERVICE would still fail, which is the
 * failure mode worth guarding.
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
   * Tests are held to a weaker rule on purpose. A platform test may compose a
   * real deployment or drive a domain route to prove the layer works in situ —
   * `cli-session-registry.durable.test.ts` boots the hosted app on purpose.
   * Banning that would push those tests into asserting against mocks, which is
   * how the Convex policy suites ended up validating nothing.
   *
   * What is NOT allowed is a production module acquiring a domain dependency by
   * hiding behind a test file, so this pins the count: it may shrink freely,
   * but growing it is a deliberate act that has to be made here.
   */
  test("platform test files keep their domain reach bounded", () => {
    const offenders = platformFiles()
      .filter((file) => file.endsWith(".test.ts"))
      .flatMap(escapes)

    // 28 -> 32 (W11.1): route-posture-inventory.test.ts composes the real
    // hosted app to drive anonymous requests at every mounted route. Reaching
    // for domains is the point — a posture guard that asserted against a mock
    // route table would prove nothing about the app that ships.
    expect(offenders.length).toBeLessThanOrEqual(32)
  })

})

/**
 * Deliberately NOT here: a check that no file under platform/ is NAMED after a
 * domain. It was written, run, and removed — it flagged 22 files that are all
 * correct. `db/channel-delivery.sql.ts` is a table definition (a domain's data
 * living in the db layer is the point of having a db layer),
 * `auth/cli-session-token.ts` mints auth tokens, `auth/workspace-id.ts` parses
 * an identifier. Naming a domain and being domain logic are different things,
 * and a filename heuristic cannot tell them apart.
 *
 * What actually caught the real cases — proxy.ts branching on `ws.kind`,
 * worker-credentials.ts constructing credential backends — was the import
 * check above, because domain logic has to import the domain to do its work.
 * Structure over spelling.
 */
