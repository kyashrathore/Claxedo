import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"

/**
 * Every feature app-ports module must actually be configured — in production AND
 * in the test stub.
 *
 * WHY THIS GUARD EXISTS. `features/workgraph/app-ports.ts` shipped with a
 * `configureWorkGraphAppPorts` that NOTHING ever called. Its accessor is
 * deliberately tolerant — it returns `undefined` for an
 * unconfigured port instead of throwing — so the entire WorkGraph live-sync
 * doorbell degraded to "revalidate on activation only", silently, in production,
 * with every unit test green. Nothing in the type system or the test suite could
 * see it: the missing thing was a call site, not a type.
 *
 * A feature declaring a ports seam and the shell forgetting to fill it is a
 * whole-feature-inert failure with no runtime symptom. It gets a guard.
 */
const appRoot = path.resolve(import.meta.dir, "../..")
const featuresRoot = path.join(appRoot, "src/features")

function configureFunctions() {
  return readdirSync(featuresRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const file = path.join(featuresRoot, entry.name, "app-ports.ts")
      let source: string
      try {
        source = readFileSync(file, "utf8")
      } catch {
        return []
      }
      const names = [...source.matchAll(/export function (configure\w*AppPorts)\b/g)].map((match) => match[1]!)
      return names.map((name) => ({ feature: entry.name, name }))
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

const wiringFiles = {
  production: [
    "src/app/integrations/feature-ports.ts",
    "src/app/integrations/secondary-feature-ports.ts",
  ],
  "test stub": ["src/app/integrations/test-support/app-ports-stub.ts"],
}

describe("app ports wiring guard", () => {
  test("finds the feature app-ports seams it is supposed to police", () => {
    // Sanity: if this ever returns nothing the guard below passes vacuously.
    expect(configureFunctions().length).toBeGreaterThanOrEqual(7)
  })

  for (const [label, files] of Object.entries(wiringFiles)) {
    test(`every feature app-ports module is configured in the ${label} wiring`, () => {
      const source = files.map((file) => readFileSync(path.join(appRoot, file), "utf8")).join("\n")
      const offenders = configureFunctions()
        .filter(({ name }) => !new RegExp(`\\b${name}\\s*\\(`).test(source))
        .map(
          ({ feature, name }) =>
            `features/${feature}/app-ports.ts: ${name}() is never called in ${files.join(", ")}` +
            " -- the feature's ports are unconfigured, so it runs inert",
        )

      expect(offenders).toEqual([])
    })
  }
})
