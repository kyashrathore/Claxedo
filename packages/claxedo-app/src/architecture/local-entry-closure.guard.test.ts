import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { importSpecifiers, resolveImport, shortestForbiddenImportChain } from "./import-graph"

const appRoot = path.resolve(import.meta.dir, "../..")
const srcRoot = path.join(appRoot, "src")

/**
 * What the local entry actually pulls in.
 *
 * The local product exists so an unsigned desktop does not ship an identity
 * provider it can never use. A separate entry file is the necessary first step
 * and — measured here — NOT a sufficient one: `app/entry/local.tsx` imports no
 * auth module directly, and Clerk still reaches its bundle through the shell's
 * provider tree.
 *
 * That reach is recorded below as a BASELINE rather than asserted away, and it
 * is recorded TWICE, because the two measurements answer different questions
 * and only one of them was here originally:
 *
 *  - The shortest chain names the tightest coupling — the one a reader has to
 *    break next.
 *  - `LOCAL_AUTH_CLIENT_IMPORTERS` names EVERY module in the local closure that
 *    imports `auth-client.ts`. This file used to claim "the test fails if a
 *    SECOND chain appears"; it did not. A shortest-path walk reports one chain
 *    and hides the rest, and there were four the whole time. Cutting the
 *    shortest one only promoted the next.
 */

/** Packages a local build has no way to use. */
const FORBIDDEN = [
  "@clerk/clerk-js",
  "@clerk/clerk-js/headless",
  "convex",
  "convex/browser",
]

function chainTo(entry: string) {
  return shortestForbiddenImportChain({
    appRoot,
    entry,
    isForbidden: ({ specifier }) => FORBIDDEN.some((name) => specifier === name || specifier.startsWith(`${name}/`)),
  })
}

/**
 * Every module in an entry's VALUE closure that imports `target`.
 *
 * The whole closure, not the first route to it: `shortestForbiddenImportChain`
 * answers "what is the tightest coupling" and is silent about the rest, so a
 * baseline built on it alone reads as progress every time one route is cut
 * while the others sit untouched.
 *
 * Value imports only, matching the walk above: the bundler erases `import
 * type`, and a type edge to the identity provider does not put Clerk in the
 * bundle.
 */
function importersOf(entry: string, target: string) {
  const seen = new Set([entry])
  const found = new Set<string>()
  let frontier = [entry]

  while (frontier.length) {
    const next: string[] = []
    for (const rel of frontier) {
      const file = path.join(srcRoot, rel)
      if (!existsSync(file)) continue
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        const resolved = resolveImport(appRoot, file, specifier)
        if (!resolved) continue
        const module = path.relative(srcRoot, resolved).split(path.sep).join("/")
        if (module === target) found.add(rel)
        if (seen.has(module)) continue
        seen.add(module)
        next.push(module)
      }
    }
    frontier = next
  }

  return [...found].toSorted()
}

/**
 * The local closure's remaining routes to Clerk, by the module that owns each.
 *
 * Was four. `platform/api/api.ts` — the authenticated transport, imported by
 * `app/entry/app.tsx` two hops from the entry, and the shortest of the four —
 * is gone: it takes its bearer from `configureApiRuntime({ bearerToken })`,
 * which the hosted entry and the desktop renderer bind and `local.tsx`
 * deliberately does not.
 *
 * The three below are separate work, and each is a different shape:
 *
 *  - `platform/auth/auth-session.ts` is the provider tree, reached from
 *    `app/entry/app.tsx`. It is on Unit 10's move list; the shell must stop
 *    mounting it in a local build.
 *  - `platform/runtime/agent/agent-runtime-client.ts` calls `getAuthToken`
 *    directly, exactly as `api.ts` did. Same remedy, different transport.
 *  - `features/workspaces/actions/project-actions.tsx` calls it in one action.
 *
 * DOWN is the only acceptable direction. A module appearing here is a new route
 * to the identity provider from local code.
 */
const LOCAL_AUTH_CLIENT_IMPORTERS = [
  "features/workspaces/actions/project-actions.tsx",
  "platform/auth/auth-session.ts",
  "platform/runtime/agent/agent-runtime-client.ts",
]

describe("the local entry", () => {
  test("exists and is what index.local.html loads", () => {
    // The entry is only meaningful if the HTML actually points at it; a build
    // that quietly kept `main.tsx` would produce the hosted bundle under a
    // local name.
    expect(existsSync(path.join(appRoot, "src/app/entry/local.tsx"))).toBe(true)
    expect(readFileSync(path.join(appRoot, "index.local.html"), "utf8")).toContain("/src/app/entry/local.tsx")
  })

  test("imports no identity provider directly", () => {
    // What this entry itself controls. The transitive reach is measured below.
    //
    // Scanned over IMPORT SPECIFIERS, not the whole file: the first version
    // read the raw source and failed on this entry's own doc comment, which
    // names the modules it deliberately avoids. A guard that cannot tell an
    // import from a sentence about an import is not measuring the code.
    const source = readFileSync(path.join(appRoot, "src/app/entry/local.tsx"), "utf8")
    const specifiers = [...source.matchAll(/from\s*["']([^"']+)["']/g)].map((match) => match[1]!)

    for (const forbidden of ["auth-client", "@clerk/", "platform/api/api"]) {
      expect(
        specifiers.filter((specifier) => specifier.includes(forbidden)),
        `the local entry must not import ${forbidden}`,
      ).toEqual([])
    }
  })

  test("reaches Clerk through the shell's provider tree, and that is the shortest route left", () => {
    // MEASURED, not assumed. If this shrinks to null the assertion below
    // should be replaced with `toBeNull()` — that is the goal state, and this
    // test is how anyone knows whether it has been reached.
    const breach = chainTo("app/entry/local.tsx")

    expect(breach, "expected the known Clerk chain; if it is gone, tighten this test").not.toBeNull()
    expect(breach!.specifier).toContain("@clerk/clerk-js")
    // The chain is now
    // `local.tsx -> app/entry/app.tsx -> platform/auth/auth-session.ts -> auth-client.ts`.
    //
    // It used to run through `app/entry/index.tsx`, which re-exported the auth
    // surface and started Clerk inside the shared `initClaxedo`. Both are gone:
    // the auth surface moved to `@claxedo/app/auth`, and starting the identity
    // provider is the hosted entry's job.
    //
    // Then it ran through `platform/api/api.ts` — the authenticated transport,
    // which the cloud-app extraction measurement named as the structural edge
    // because api.ts STAYS in `@claxedo/app` while `auth-client.ts` moves. That
    // hop is gone too: the transport takes a bearer from
    // `configureApiRuntime({ bearerToken })` instead of importing the provider,
    // and only a build with an identity provider binds one.
    //
    // What is left is what the top of this file described from the beginning —
    // the shell's provider tree, mounted by `app/entry/app.tsx`. Making it
    // local is a different unit's work.
    expect(breach!.chain).toContain("platform/auth/auth-session.ts")
    // The transport is still in the local closure — it is the local product's
    // fetch path too — it just no longer leads anywhere near Clerk.
    expect(breach!.chain).not.toContain("platform/api/api.ts")
  })

  test("records every remaining route to the identity provider, not just the shortest", () => {
    expect(importersOf("app/entry/local.tsx", "platform/auth/auth-client.ts")).toEqual(LOCAL_AUTH_CLIENT_IMPORTERS)
  })

  test("the importer walk sees the closure it is supposed to be measuring", () => {
    // Positive control for the assertion above. A walk that resolved nothing
    // would report an empty importer list and read as a finished migration.
    // `platform/api/api.ts` is the right probe: it is unquestionably in the
    // local closure (`app/entry/app.tsx` imports it) and it is the module whose
    // auth edge was just cut, so this fails loudly if the edge comes back under
    // some other name.
    expect(importersOf("app/entry/local.tsx", "platform/api/api.ts")).toContain("app/entry/app.tsx")
    expect(importersOf("app/entry/main.tsx", "platform/auth/auth-client.ts")).toContain("app/entry/main.tsx")
  })

  test("the asymmetry that keeps the transport out of the chain is a call site, not a type", () => {
    // WHY api.ts dropped off the chain above, and the one way it comes back.
    //
    // `platform/api/api.ts` takes its bearer from
    // `configureApiRuntime({ bearerToken })`. Nothing forces a build to bind
    // one — that is the point, since the local product has no identity
    // provider to bind — so the hosted binding is a call site with no type to
    // protect it. Delete it and `app/entry/main.tsx` still compiles, still
    // renders, and sends every hosted request with no Authorization header.
    // `app-ports-wiring.guard.test.ts` records the same failure shape costing
    // WorkGraph its entire live-sync doorbell with a green suite.
    const hosted = readFileSync(path.join(appRoot, "src/app/entry/main.tsx"), "utf8")

    expect(hosted).toMatch(/configureApiRuntime\(\{\s*bearerToken:\s*getAuthToken\s*\}\)/)
    expect(importSpecifiers(hosted)).toContain("@/platform/auth/auth-client")

    // And the local entry cannot bind one even by accident: it imports neither
    // the transport nor the provider (asserted above, over specifiers).
    const local = readFileSync(path.join(appRoot, "src/app/entry/local.tsx"), "utf8")
    expect(local).not.toMatch(/configureApiRuntime\s*\(/)
  })

  test("the hosted entry reaches it too, so the measurement is not local-specific", () => {
    // Positive control for the walk itself: a walker that resolved nothing
    // would report `null` for the local entry and look like success.
    expect(chainTo("app/entry/main.tsx")).not.toBeNull()
  })

  test("the local vite config builds the local html, not the hosted one", () => {
    // The other way a "local build" silently becomes a hosted one.
    const config = readFileSync(path.join(appRoot, "vite.local.config.ts"), "utf8")

    expect(config).toContain("index.local.html")
    // And writes somewhere else, so one build cannot overwrite the other's
    // output — both are produced by CI.
    expect(config).toContain("dist-local")
  })
})
