import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * Route-shadow analysis for the shared e2e mock (`e2e/helpers/mock-runtime.ts`).
 *
 * WHY THIS EXISTS — Playwright matches `page.route` handlers MOST-RECENTLY-REGISTERED
 * FIRST. A broad pattern registered after a narrow one therefore takes the narrow one's
 * requests, and the narrow handler simply never runs. That failure is silent by
 * construction, because the broad handler still answers 200 with a plausible body:
 *
 *   `**​/session/status` was swallowed by the `**​/session/*` catch-all for the entire
 *   life of the suite and answered with a SESSION ROW instead of a status map. Nothing
 *   caught it, because every consumer indexes the response by session id
 *   (`statuses[id] ?? {type:"idle"}`) and a session row has no such key — so the wrong
 *   body decoded as the plausible default "everything is idle", and `/session/status`
 *   coverage was decorative for months.
 *
 * Same failure shape as a permanently-false tripwire: the signal reads OK, so nobody
 * looks. This module makes the shape mechanically detectable.
 *
 * WHAT IT DOES — parses the `page.route(...)` calls in registration order, converts each
 * glob with Playwright's own translation, and asks of every earlier route: does some
 * LATER pattern match every URL this route is realistically for? If so the earlier route
 * is unreachable, and must be either fixed or listed in `ALLOWED_SHADOWS` with the
 * verbatim hand-back expression that keeps it reachable at runtime.
 */

const MOCK_RUNTIME = "e2e/helpers/mock-runtime.ts"

/**
 * Placeholders substituted for the template holes in `page.route(\`${base}/...\`)`.
 * Values only have to be internally consistent — the analysis compares patterns against
 * each other, never against a live server.
 */
const ORIGIN = "http://127.0.0.1:4455"
const RELAY_ORIGIN = "https://relay.spec.test"
const WORKSPACE_ID = "ws_shadow_probe"
const TEMPLATE_VALUES: Record<string, string> = {
  "${base}": `${RELAY_ORIGIN}/workspaces/${WORKSPACE_ID}`,
  "${relayOrigin}": RELAY_ORIGIN,
  "${workspaceId}": WORKSPACE_ID,
}

export type MockRoute = {
  /** 1-based line of the `page.route(` call. */
  line: number
  /** Pattern exactly as written, `${…}` holes intact — this is the allowlist key. */
  raw: string
  /** Pattern with template holes substituted. */
  resolved: string
  /** Source text of the whole `page.route(...)` call, used to check hand-back expressions. */
  body: string
  /** Registered with the explicit canonical-contract marker. */
  bound: boolean
}

export type RouteShadow = {
  shadowed: MockRoute
  shadower: MockRoute
  /** A concrete URL the shadowed route is for that the shadower takes instead. */
  sample: string
}

export type AllowedShadow = {
  /** `raw` pattern of the route that is swallowed. */
  shadowed: string
  /** `raw` pattern of the later route that swallows it. */
  shadower: string
  /**
   * Verbatim source from the SHADOWER's handler that hands these URLs back. Asserted to
   * still be present: delete the hand-back and this entry becomes a failure instead of
   * silently re-opening the hole. An entry with no hand-back is not allowed — a shadow
   * that nothing mitigates is a bug, not a policy.
   */
  handsBack: string
  reason: string
}

/**
 * Every shadow that is real but mitigated at runtime. Pattern-level analysis cannot see
 * a `route.fallback()` guard, so each of these pins the exact expression that performs
 * it. Adding an entry here is a claim that the narrow route still receives its requests
 * — check it before you write one.
 */
export const ALLOWED_SHADOWS: AllowedShadow[] = [
  {
    shadowed: "**/api/workspace/resolve**",
    shadower: "**/api/workspace/resolve**",
    handsBack: `if (q !== workspaceId && !q.includes(workspaceId)) return r.fallback()`,
    reason:
      "The cloud block re-registers the SAME pattern to claim resolves for its own workspace id, " +
      "and hands every other directory back to the local handler above. Registration is inside " +
      "`if (options.cloud)`, which pattern analysis cannot see, so the pair always reads as a shadow.",
  },
  {
    shadowed: "**/api/claxedo/workspace/resolve**",
    shadower: "**/api/claxedo/workspace/resolve**",
    handsBack: `if (q !== workspaceId && !q.includes(workspaceId)) return r.fallback()`,
    reason:
      // The route is spelled without its /api prefix here on purpose: the
      // workspace-runtime route audit greps production sources for quoted
      // control-plane paths, and a backtick-quoted full path in this prose
      // would read as a hand-built route.
      "Loopback-spelling twin of the workspace/resolve pair above: `workspaceResolveUrl` " +
      "rewrites the path on loopback transports, so both the generic default and the cloud block " +
      "register both spellings, with the same workspace-id hand-back.",
  },
  {
    shadowed: "**/api/claxedo/agent-config/harness/options**",
    shadower: "**/api/claxedo/agent-config/harness**",
    handsBack: `if (new URL(r.request().url()).pathname !== "/api/claxedo/agent-config/harness") return r.fallback()`,
    reason:
      "`/harness`'s trailing `**` also matches `/harness/options`. The exact-pathname guard hands " +
      "the options request back, which is what keeps `requests.harnessOptionsCount` a live signal.",
  },
  {
    shadowed: "**/api/claxedo/agent-config/harness/acp-connections**",
    shadower: "**/api/claxedo/agent-config/harness**",
    handsBack: `if (new URL(r.request().url()).pathname !== "/api/claxedo/agent-config/harness") return r.fallback()`,
    reason:
      "Same shape as `/harness/options` above: `/harness`'s trailing `**` also matches the operator " +
      "ACP connection discovery route, and the same exact-pathname guard hands it back.",
  },
  {
    shadowed: "**/api/claxedo/session-list**",
    shadower: "**/api/claxedo/session**",
    handsBack: `if (new URL(r.request().url()).pathname !== "/api/claxedo/session") return r.fallback()`,
    reason:
      "The flat local inventory route (GET /api/claxedo/session, fetchLocalControlSessions) is a " +
      "prefix of the rail sidebar's session-list spelling, so its glob necessarily matches both; " +
      "the exact-pathname guard hands `/api/claxedo/session-list` back to the registration above.",
  },
  {
    shadowed: "**/session/status**",
    shadower: "**/session/*",
    handsBack: `if (pathname.endsWith("/session/status")) return r.fallback()`,
    reason:
      "`/session/status` is a bulk status map, not a session whose id is \"status\", but it is " +
      "`/session/<one-segment>` shaped so the catch-all matches it. This is the original defect " +
      "this guard exists for; the hand-back is the fix.",
  },
  {
    shadowed: "${base}/session/status**",
    shadower: "${base}/session/*",
    handsBack: `if (new URL(r.request().url()).pathname.endsWith("/session/status")) return r.fallback()`,
    reason: "Cloud-lane twin of the primary-origin `/session/status` shadow above, with the same fix.",
  },
]

export function mockRuntimePath(appRoot: string) {
  return path.join(appRoot, MOCK_RUNTIME)
}

/**
 * Total `page.route(` call sites, however the pattern is written. Compared against
 * `mockRoutes().length` by the guard: a pattern this module cannot parse (a RegExp, a
 * predicate, a pattern built in a variable) would otherwise be skipped in silence, which
 * is the same "analysis quietly covers less than you think" failure the guard exists to
 * catch — just one level up.
 */
export function mockRouteCallCount(appRoot: string) {
  return readFileSync(mockRuntimePath(appRoot), "utf8").match(/(?:page\.route|contractRoute)\(/g)?.length ?? 0
}

export function mockRoutes(appRoot: string): MockRoute[] {
  const source = readFileSync(mockRuntimePath(appRoot), "utf8")
  const routes: MockRoute[] = []
  const call = /(page\.route|contractRoute)\(\s*(?:page\s*,\s*)?(`[^`]*`|"[^"]*")/g
  for (const match of source.matchAll(call)) {
    const open = source.indexOf("(", match.index!)
    const raw = match[2]!.slice(1, -1)
    routes.push({
      line: source.slice(0, match.index!).split("\n").length,
      raw,
      resolved: resolveTemplate(raw),
      body: balancedCall(source, open),
      bound: match[1] === "contractRoute",
    })
  }
  return routes
}

export function routeShadows(routes: MockRoute[]): RouteShadow[] {
  const compiled = routes.map((route) => ({ route, re: new RegExp(globToRegexPattern(route.resolved)) }))
  const shadows: RouteShadow[] = []
  for (let i = 0; i < compiled.length; i++) {
    const earlier = compiled[i]!
    const urls = witnesses(earlier.route.resolved).filter((url) => earlier.re.test(url))
    if (!urls.length) continue
    for (let j = i + 1; j < compiled.length; j++) {
      const later = compiled[j]!
      if (!urls.every((url) => later.re.test(url))) continue
      shadows.push({ shadowed: earlier.route, shadower: later.route, sample: urls[0]! })
    }
  }
  return shadows
}

function resolveTemplate(raw: string) {
  let out = raw
  for (const [hole, value] of Object.entries(TEMPLATE_VALUES)) out = out.replaceAll(hole, value)
  return out
}

/**
 * The URLs a route is realistically FOR: wildcards collapse to their smallest plausible
 * instantiation, never to pathological deep paths. Expanding `**` into `/deep/path`
 * instead reports ~44 "overlaps" that are all legitimate origin-scoped overrides, which
 * is how a guard like this ends up allowlisted into uselessness.
 */
function witnesses(glob: string) {
  let out = [glob]
  const expand = (find: string, options: string[]) => {
    let changed = false
    const next: string[] = []
    for (const candidate of out) {
      const index = candidate.indexOf(find)
      if (index === -1) {
        next.push(candidate)
        continue
      }
      changed = true
      for (const option of options) next.push(candidate.slice(0, index) + option + candidate.slice(index + find.length))
    }
    out = next
    return changed
  }
  for (let pass = 0; pass < 8; pass++) {
    let changed = false
    changed = expand("**/", [`${ORIGIN}/`]) || changed
    changed = expand("/**", ["/x", "/x?directory=%2Ftmp%2Fw"]) || changed
    changed = expand("**", ["", "?directory=%2Ftmp%2Fw"]) || changed
    changed = expand("*", ["ses_shadow_probe"]) || changed
    if (!changed) break
  }
  return [...new Set(out)].filter((url) => /^https?:\/\//.test(url))
}

/** Source text of `source[open..]`'s balanced parenthesis group, quotes and comments skipped. */
function balancedCall(source: string, open: number) {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const c = source[i]!
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(source, i)
      continue
    }
    if (c === "/" && source[i + 1] === "/") {
      i = source.indexOf("\n", i)
      if (i === -1) break
      continue
    }
    if (c === "/" && source[i + 1] === "*") {
      i = source.indexOf("*/", i + 2) + 1
      if (i === 0) break
      continue
    }
    if (c === "(") depth++
    else if (c === ")" && --depth === 0) return source.slice(open, i + 1)
  }
  return source.slice(open)
}

function skipString(source: string, start: number) {
  const quote = source[start]!
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === "\\") {
      i++
      continue
    }
    if (source[i] === quote) return i
  }
  return source.length
}

/**
 * Verbatim copy of `globToRegexPattern` from
 * `playwright-core/lib/utils/isomorphic/urlMatch.js` (v1.5x). Copied rather than
 * imported because the module is not reachable through playwright-core's `exports` map.
 * `globTranslationCases` in the guard test pins the behaviours this copy has to keep.
 */
export function globToRegexPattern(glob: string) {
  const escaped = new Set(["$", "^", "+", ".", "*", "(", ")", "|", "\\", "?", "{", "}", "[", "]"])
  const tokens = ["^"]
  let inGroup = false
  for (let i = 0; i < glob.length; ++i) {
    const c = glob[i]!
    if (c === "\\" && i + 1 < glob.length) {
      const char = glob[++i]!
      tokens.push(escaped.has(char) ? "\\" + char : char)
      continue
    }
    if (c === "*") {
      const charBefore = glob[i - 1]
      let starCount = 1
      while (glob[i + 1] === "*") {
        starCount++
        i++
      }
      if (starCount > 1) {
        if (glob[i + 1] === "/") {
          tokens.push(charBefore === "/" ? "((.+/)|)" : "(.*/)")
          ++i
        } else tokens.push("(.*)")
      } else tokens.push("([^/]*)")
      continue
    }
    switch (c) {
      case "{":
        inGroup = true
        tokens.push("(")
        break
      case "}":
        inGroup = false
        tokens.push(")")
        break
      case ",":
        tokens.push(inGroup ? "|" : "\\,")
        break
      default:
        tokens.push(escaped.has(c) ? "\\" + c : c)
    }
  }
  tokens.push("$")
  return tokens.join("")
}
