/**
 * Every mocked bootstrap body declares a deployment posture.
 *
 * `deployment.issuesSessions` is the only thing the sign-in gate, the browser
 * identity provider's startup and the first-project canvas read. A fixture that
 * omits it models a server no producer can be — the app resolves an error
 * instead of an answer, its gate holds on a surface the harness never expects,
 * and the spec around it still looks like it is exercising a real deployment.
 *
 * Two scans, because a body can go undeclared two ways: one more body inside a
 * spec that already declares others, and one more FILE that fakes the route.
 *
 * Scanned as text over the sources, because each of these bodies is a literal
 * inside its own route handler and there is no runtime to ask.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"

const e2eDir = path.resolve(import.meta.dir, "..")
const specDir = path.join(e2eDir, "playwright")

/**
 * Where a fake bootstrap can live. Deliberately not this directory: the scan
 * matches on the route path, which this file's own scanner would otherwise
 * match on itself.
 */
const producerDirs = [specDir, path.join(e2eDir, "helpers"), path.resolve(e2eDir, "../perf-harness/src/browser")]

const BOOTSTRAP_ROUTE = "/api/claxedo/bootstrap"

type Body = { file: string; line: number; declares: boolean }

/**
 * Every object literal in the Playwright specs that answers the bootstrap
 * route, found by the one field every such body carries.
 *
 * `events: { hostAggregate: … }` is the anchor rather than the route pattern:
 * the pattern and the body are often lines apart, behind a shared `**\/*`
 * handler that switches on `url.pathname`, and the body is what this guard is
 * about.
 */
function bootstrapBodies(): Body[] {
  return readdirSync(specDir)
    .filter((name) => name.endsWith(".spec.ts"))
    .flatMap((name) => {
      const lines = readFileSync(path.join(specDir, name), "utf8").split("\n")
      return lines.flatMap((line, index) => {
        if (!/events:\s*\{\s*hostAggregate:/.test(line)) return []
        // The declaration sits beside it in the same literal; three lines of
        // slack covers the formatter without reaching the next property group.
        const near = lines.slice(index, index + 4).join("\n")
        return [{ file: name, line: index + 1, declares: near.includes("deployment:") }]
      })
    })
}

/**
 * Every file that answers the bootstrap route in code, with whether it states
 * a posture anywhere — either the field itself or the shared helper that
 * produces it.
 *
 * A line whose first non-space character opens a comment does not answer
 * anything — several helpers cite the route in prose to explain which body the
 * real server takes.
 */
function bootstrapProducers(): { file: string; declares: boolean }[] {
  return producerDirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => /\.(ts|tsx|mjs)$/.test(name))
      .flatMap((name) => {
        const source = readFileSync(path.join(dir, name), "utf8")
        const routes = source
          .split("\n")
          .some((line) => line.includes(BOOTSTRAP_ROUTE) && !/^\s*(\/\/|\/\*|\*)/.test(line))
        if (!routes) return []
        const declares = source.includes("issuesSessions") || source.includes("bootstrapDeployment(")
        return [{ file: path.relative(e2eDir, path.join(dir, name)), declares }]
      }),
  )
}

/**
 * A spec that fakes the whole backend itself — a catch-all `page.route("**\/*")`
 * with no `installMockRuntime` — answers the bootstrap route from its own
 * handler or from its fallback. A fallback body declares nothing, and the
 * scans above cannot see it because no line names the route or the anchor.
 */
function catchAllSpecs(): { file: string; declares: boolean }[] {
  return readdirSync(specDir)
    .filter((name) => name.endsWith(".spec.ts"))
    .flatMap((name) => {
      const source = readFileSync(path.join(specDir, name), "utf8")
      if (!source.includes('page.route("**/*"') || source.includes("installMockRuntime(")) return []
      return [{ file: name, declares: source.includes("bootstrapDeployment(") || source.includes("issuesSessions") }]
    })
}

describe("mocked bootstrap bodies", () => {
  test("every spec that fakes the whole backend itself declares a posture", () => {
    const specs = catchAllSpecs()
    expect(specs.length).toBeGreaterThan(2)
    expect(specs.filter((spec) => !spec.declares).map((spec) => spec.file)).toEqual([])
  })

  test("the scan finds the bodies it is meant to guard", () => {
    // A guard over zero files passes for the wrong reason.
    const bodies = bootstrapBodies()
    expect(bodies.length).toBeGreaterThan(8)
    expect(new Set(bodies.map((body) => body.file)).size).toBeGreaterThan(4)
  })

  test("every one of them declares a deployment posture", () => {
    const missing = bootstrapBodies()
      .filter((body) => !body.declares)
      .map((body) => `${body.file}:${body.line}`)

    expect(missing).toEqual([])
  })

  test("the producer scan reaches the harnesses outside the specs", () => {
    const files = bootstrapProducers().map((producer) => producer.file)

    expect(files).toContain("helpers/mock-runtime.ts")
    expect(files).toContain("../perf-harness/src/browser/mock-api.ts")
  })

  test("every file that fakes the bootstrap route declares a posture", () => {
    const missing = bootstrapProducers()
      .filter((producer) => !producer.declares)
      .map((producer) => producer.file)

    expect(missing).toEqual([])
  })
})
