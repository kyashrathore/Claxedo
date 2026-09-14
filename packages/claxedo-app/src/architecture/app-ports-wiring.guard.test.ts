import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { stripComments } from "./import-graph"

/**
 * Every feature app-ports module must actually be configured — in production and
 * in the test stub.
 *
 * A feature's `app-ports.ts` can ship a `configure*AppPorts` that nothing ever
 * calls. Its accessor is deliberately tolerant — it returns `undefined` for an
 * unconfigured port instead of throwing — so the feature's live-sync doorbell
 * would silently degrade to "revalidate on activation only", with every unit
 * test green. Neither the type system nor the test suite can see it: the
 * missing thing is a call site, not a type.
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
      const names = [...source.matchAll(/export function (configure\w*AppPorts)\b/g)].map((match) => match[1])
      return names.map((name) => ({ feature: entry.name, name }))
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

const stubFile = "src/app/integrations/test-support/app-ports-stub.ts"

/** Top-level property names of a braced block, from its opening line to the `}` in column 0. */
function blockKeys(source: string, header: RegExp) {
  const body = new RegExp(`${header.source}\\{\\n([\\s\\S]*?)^\\}`, "m").exec(stripComments(source))
  return body ? [...body[1].matchAll(/^ {2}(\w+)\??:/gm)].map((match) => match[1]) : []
}

/**
 * The ports each feature declares, against the thunks the test stub supplies.
 *
 * `Thunks<P>` already requires every key, but `tsconfig.json` excludes every
 * `test-support` directory from the typecheck, so the mapped type is never
 * evaluated. A port missing from the stub is then absent from the installed
 * object AND unreachable through `AppPortsTestOverrides`, so the feature throws
 * or renders nothing under test while production is fine — and nothing reports
 * which port it was.
 */
function stubbedPorts() {
  const stub = readFileSync(path.join(appRoot, stubFile), "utf8")
  return readdirSync(featuresRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      let source: string
      try {
        source = readFileSync(path.join(featuresRoot, entry.name, "app-ports.ts"), "utf8")
      } catch {
        return []
      }
      const type = /export type (\w+AppPorts) = /.exec(source)?.[1]
      if (!type) return []
      const declared = blockKeys(source, new RegExp(`^export type ${type} = `))
      const supplied = new Set(blockKeys(stub, new RegExp(`Thunks<${type}> = `)))
      return [{ feature: entry.name, type, declared, missing: declared.filter((key) => !supplied.has(key)) }]
    })
}

const wiringFiles = {
  production: [
    "src/app/integrations/feature-ports.ts",
    "src/app/integrations/secondary-feature-ports.ts",
    // Tasks configures its ports from the module `secondary-feature-ports.ts`
    // dynamic-imports, so a `configure*AppPorts` call there is production
    // wiring too.
    "src/app/integrations/tasks-contributions.ts",
  ],
  "test stub": [stubFile],
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

  test("reads a port name out of every feature that declares a seam", () => {
    // Sanity: a parse that returned nothing would pass the guard below vacuously.
    const read = stubbedPorts()
    expect(read.length).toBeGreaterThanOrEqual(7)
    expect(read.filter((entry) => entry.declared.length === 0)).toEqual([])
  })

  test("the test stub supplies every port each feature declares", () => {
    const offenders = stubbedPorts()
      .filter((entry) => entry.missing.length > 0)
      .map(
        (entry) =>
          `${stubFile}: Thunks<${entry.type}> is missing ${entry.missing.join(", ")}` +
          ` -- features/${entry.feature} runs without that under test`,
      )

    expect(offenders).toEqual([])
  })
})
