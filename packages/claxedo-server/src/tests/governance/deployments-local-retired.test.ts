import { describe, expect, test } from "vitest"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

/**
 * `deployments/local` stays gone.
 *
 * It was the mixed composition: one function serving the self-hosted product
 * and a `CLAXEDO_DEPLOYMENT_MODE=local` mode with no authority, which is why
 * neither product's boot gate could be applied to it. Unit 7 split them and
 * deleted the directory.
 *
 * A directory can come back by accident more easily than it went away — a
 * revert, a cherry-pick, a merge that resurrects a path nobody is looking at.
 * The plan asks for the old path to be rejected in governance rather than
 * trusted to stay deleted, and this is that rejection.
 *
 * Deliberately narrow: it forbids THIS package's `src/deployments/local`, not
 * the string anywhere. `@claxedo/local-server` has a directory of the same
 * name that several modules here legitimately import from, and a rule that
 * could not tell them apart would either fail today or be widened until it
 * caught nothing.
 */

const SRC = path.resolve(import.meta.dirname, "../..")
const RETIRED = path.join(SRC, "deployments/local")

/** Production and test sources under `src/`, excluding build output. */
function sources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const file = path.join(dir, entry)
    if (statSync(file).isDirectory()) {
      return entry === "node_modules" || entry === "dist" ? [] : sources(file)
    }
    return /\.(ts|tsx|mjs)$/.test(file) ? [file] : []
  })
}

describe("deployments/local is retired", () => {
  test("the directory does not exist", () => {
    expect(existsSync(RETIRED), "src/deployments/local must stay deleted").toBe(false)
  })

  test("no module imports a path inside it", () => {
    // The import forms that would resolve there: a package-rooted specifier, a
    // relative climb, or a sibling reference from within `deployments/`.
    const offenders = sources()
      // This file's own mutation-check sample contains the forbidden string on
      // purpose, and the scanner found it — which is the positive control
      // working, not a violation.
      .filter((file) => !file.endsWith("deployments-local-retired.test.ts"))
      .flatMap((file) => {
      const text = readFileSync(file, "utf8")
      const matches = [
        ...text.matchAll(/from\s*["']([^"']*\/deployments\/local\/[^"']*)["']/g),
        ...text.matchAll(/import\s*\(\s*["']([^"']*\/deployments\/local\/[^"']*)["']\s*\)/g),
      ]
        // `@claxedo/local-server` has its own `deployments/local`, and modules
        // here import from it on purpose. Only THIS package's path is retired.
        .filter((match) => !match[1]!.includes("@claxedo/local-server"))
        .filter((match) => !match[1]!.includes("claxedo-local-server"))
      return matches.map((match) => `${path.relative(SRC, file)}: ${match[1]}`)
    })

    expect(offenders).toEqual([])
  })

  test("no deployment manifest points at it", () => {
    // The references a typecheck cannot see, and the ones that would ship a
    // broken image rather than fail a build.
    const root = path.resolve(SRC, "..")
    for (const manifest of ["Dockerfile", "package.json", "fly.toml"]) {
      const file = path.join(root, manifest)
      if (!existsSync(file)) continue
      expect(readFileSync(file, "utf8"), `${manifest} must not reference deployments/local`).not.toContain(
        "src/deployments/local",
      )
    }
  })

  test("the scan actually reads this package's sources", () => {
    // Positive control. Two assertions above are "the offenders list is
    // empty", which an empty scan also reports.
    const files = sources()

    expect(files.length).toBeGreaterThan(100)
    expect(files.some((file) => file.endsWith(path.join("deployments", "self-hosted-node", "app.ts")))).toBe(true)
  })

  test("would notice a resurrected import", () => {
    // Mutation check for the matcher, without recreating the directory.
    const pattern = /from\s*["']([^"']*\/deployments\/local\/[^"']*)["']/g
    const sample = `from "../deployments/local/server"\nfrom "@claxedo/local-server/deployments/local/embedded-workspace-runtime"`
    const found = [...sample.matchAll(pattern)].map((match) => match[1]!)

    expect(found).toHaveLength(2)
    expect(found.filter((specifier) => !specifier.includes("@claxedo/local-server"))).toEqual([
      "../deployments/local/server",
    ])
  })
})
