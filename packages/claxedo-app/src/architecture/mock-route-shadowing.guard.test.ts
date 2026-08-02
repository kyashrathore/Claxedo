/**
 * GUARD: no `page.route` handler in the shared e2e mock is unreachable.
 *
 * Playwright matches routes most-recently-registered-first, so a broad pattern
 * registered after a narrow one silently takes the narrow one's requests — and answers
 * them with a body that is wrong but plausible. `**​/session/status` spent the whole life
 * of the suite being answered by the `**​/session/*` catch-all with a SESSION ROW; every
 * consumer coerced the unusable body to `{type:"idle"}`, so the suite stayed green and
 * the route's coverage was decorative. See `./mock-route-shadowing.ts` for the analysis.
 *
 * A shadow is a failure unless `ALLOWED_SHADOWS` names the verbatim hand-back expression
 * that keeps the narrow route reachable — so "allowlisted" never means "tolerated", it
 * means "mitigated, and here is the line that does it".
 */
import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  ALLOWED_SHADOWS,
  globToRegexPattern,
  mockRouteCallCount,
  mockRoutes,
  routeShadows,
  type MockRoute,
  type RouteShadow,
} from "./mock-route-shadowing"

const appRoot = path.resolve(import.meta.dir, "../..")

const allowKey = (shadow: { shadowed: string; shadower: string }) => `${shadow.shadowed} ${shadow.shadower}`
const shadowKey = (shadow: RouteShadow) => allowKey({ shadowed: shadow.shadowed.raw, shadower: shadow.shadower.raw })
const describeShadow = (shadow: RouteShadow) =>
  `${shadow.shadowed.raw} (line ${shadow.shadowed.line}) is unreachable: ` +
  `${shadow.shadower.raw} (line ${shadow.shadower.line}, registered later) takes ${shadow.sample}`

describe("mock-runtime route shadowing", () => {
  test("parses every registered route with a balanced handler body", () => {
    const routes = mockRoutes(appRoot)
    // A parse that silently produced zero (or a truncated body) would make every
    // assertion below vacuously pass, which is the failure mode this guard exists for.
    expect(routes.length).toBeGreaterThan(50)
    // And a pattern written as something other than a string/template literal (a RegExp,
    // a predicate, a variable) would be skipped without a word. Route it through a
    // literal, or teach `mockRoutes` to read it — do not let the analysis shrink quietly.
    expect(routes.length).toBe(mockRouteCallCount(appRoot))
    const malformed = routes
      .filter((route: MockRoute) => !route.body.startsWith("(") || !route.body.endsWith(")"))
      .map((route: MockRoute) => `${route.raw} (line ${route.line}): handler body did not parse`)
    expect(malformed).toEqual([])
  })

  test("no route is swallowed by a later, broader pattern", () => {
    const allowed = new Set(ALLOWED_SHADOWS.map(allowKey))
    const offenders = routeShadows(mockRoutes(appRoot))
      .filter((shadow) => !allowed.has(shadowKey(shadow)))
      .map(
        (shadow) =>
          `${describeShadow(shadow)} -- register the narrow pattern later, narrow the broad one, ` +
          `or hand the request back with route.fallback() and record it in ALLOWED_SHADOWS`,
      )

    expect(offenders).toEqual([])
  })

  test("every allowed shadow still carries its hand-back expression", () => {
    const shadows = routeShadows(mockRoutes(appRoot))
    const offenders: string[] = []
    for (const allowed of ALLOWED_SHADOWS) {
      const hits = shadows.filter((shadow) => shadowKey(shadow) === allowKey(allowed))
      if (!hits.length) {
        offenders.push(
          `${allowed.shadowed} <- ${allowed.shadower}: no longer shadowed -- remove it from ALLOWED_SHADOWS`,
        )
        continue
      }
      for (const hit of hits) {
        if (hit.shadower.body.includes(allowed.handsBack)) continue
        offenders.push(
          `${allowed.shadowed} <- ${allowed.shadower} (line ${hit.shadower.line}): hand-back expression is gone, ` +
            `so the shadowed route is now genuinely unreachable. Expected to find: ${allowed.handsBack}`,
        )
      }
    }

    expect(offenders).toEqual([])
  })

  test("glob translation still matches Playwright's own", () => {
    // Pins the behaviours `globToRegexPattern` is copied for. `**` crossing `/` and `*`
    // NOT crossing it is the whole basis of the analysis: get it backwards and every
    // `/session/:id`-shaped collision disappears from the report.
    const cases: [glob: string, url: string, matches: boolean][] = [
      ["**/session/*", "http://h/session/status", true],
      ["**/session/*", "http://h/session/ses_a/config", false],
      ["**/session/status**", "http://h/session/status?directory=%2Ftmp", true],
      ["**/session/status", "http://h/session/status?directory=%2Ftmp", false],
      ["**/event?**", "http://h/global/event?x=1", true],
      ["**/global/event?**", "http://h/event?x=1", false],
      ["**/api/claxedo/agent-config/harness**", "http://h/api/claxedo/agent-config/harness/options", true],
    ]
    const offenders = cases
      .filter(([glob, url, matches]) => new RegExp(globToRegexPattern(glob)).test(url) !== matches)
      .map(([glob, url, matches]) => `${glob} vs ${url}: expected ${matches}`)

    expect(offenders).toEqual([])
  })
})
