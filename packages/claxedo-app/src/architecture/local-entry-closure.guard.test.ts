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
 * provider it can never use. A separate entry file was the necessary first step
 * and — measured here — not a sufficient one: `app/entry/local.tsx` imported no
 * auth module directly, yet Clerk reached its bundle anyway through four other
 * modules. All four are cut; this file now asserts that rather than recording
 * it.
 *
 * It measures TWICE, and both measurements are load-bearing:
 *
 *  - The shortest chain names the tightest coupling — the one a reader would
 *    have to break next, and the fastest signal when one comes back.
 *  - `LOCAL_AUTH_CLIENT_IMPORTERS` names EVERY module in the local closure that
 *    imports `auth-client.ts`. This file used to claim "the test fails if a
 *    SECOND chain appears"; it did not. A shortest-path walk reports one chain
 *    and hides the rest, and there were four the whole time. Cutting the
 *    shortest one only promoted the next, so the whole-closure check is the one
 *    that actually holds the line and the shortest-chain check is the diagnostic.
 *
 * A source closure is not an artifact, and this file cannot see the difference.
 * Rollup config can name a chunk for a dependency no module imports, so the
 * emitted-bundle check lives separately — a green result here means the SOURCE
 * graph is clean, nothing more.
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
 * EMPTY, as of 2026-08-09. It was four, and each was cut separately:
 * `platform/api/api.ts` (the authenticated transport),
 * `platform/auth/auth-session.ts` (the shell's provider tree),
 * `platform/runtime/agent/agent-runtime-client.ts`, and
 * `features/workspaces/actions/project-actions.tsx`.
 *
 * Every one of them was a module that NEEDS a token importing the thing that
 * MINTS one, and every one was fixed the same way — name the capability, let a
 * composition root bind it. The hosted entry and the desktop renderer bind
 * both ports; `local.tsx` deliberately binds neither, so the token source and
 * the identity provider are simply absent from the local bundle rather than
 * present-but-unused.
 *
 * This list is not a baseline any more, it is an invariant. A module appearing
 * here is a new route to the identity provider from local code, and the fix is
 * a port, not an entry in this array. Note this measures VALUE imports only —
 * `auth-session.ts` still names `useAuth` as a `import type`, which the bundler
 * erases and which therefore correctly does not count.
 */
const LOCAL_AUTH_CLIENT_IMPORTERS: string[] = []

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

  test("does not reach Clerk or Convex at all", () => {
    // The goal state, reached 2026-08-09. This assertion used to be its
    // inverse — `.not.toBeNull()` against a recorded baseline — because the
    // chain was real and pretending otherwise would have been the lie. The
    // history is worth keeping, because each hop was cut for a different
    // reason and the shape of the last one is the shape of the next such fix:
    //
    //  1. `app/entry/index.tsx` re-exported the auth surface and started Clerk
    //     inside the shared `initClaxedo`. The surface moved to
    //     `@claxedo/app/auth`, and starting the identity provider became the
    //     hosted entry's job.
    //  2. `platform/api/api.ts`, the authenticated transport, imported
    //     `getAuthToken`. It now takes a bearer from
    //     `configureApiRuntime({ bearerToken })` — only a build that HAS an
    //     identity provider binds one.
    //  3. `platform/auth/auth-session.ts` was reached from `app/entry/app.tsx`,
    //     so the shared shell's provider tree pulled Clerk into every build.
    //     It now imports `useAuth` as a TYPE and takes the real one through
    //     `configureAuthSession`; unbound, it returns an anonymous session,
    //     which is what a local build genuinely is.
    //  4. `agent-runtime-client.ts` and `project-actions.tsx` each called
    //     `getAuthToken` directly. Both read the bound bearer instead.
    //
    // All four were the same defect: a module that NEEDS a token importing the
    // thing that MINTS one. The remedy every time was to name the capability
    // and let a composition root supply it.
    expect(chainTo("app/entry/local.tsx"), "the local entry reached a forbidden package again").toBeNull()
  })

  test("records every remaining route to the identity provider, not just the shortest", () => {
    // Empty, and it must stay empty. A shortest-path walk reports one chain and
    // hides the rest; this file once claimed it "fails if a SECOND chain
    // appears" and it did not — there were four the whole time, and cutting the
    // shortest only promoted the next. So the check that actually holds the
    // line is this one, over the WHOLE closure, not the one above it.
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

    // The auth-session port has exactly the same shape and therefore exactly
    // the same hazard, one seam over. `platform/auth/auth-session.ts` now takes
    // its `useAuth` from `configureAuthSession` instead of importing it, which
    // is what removed the shell's provider tree from the local closure. Delete
    // the binding and every signed-in build compiles, renders, and reports
    // ANONYMOUS — account menu stuck on "Local workspace", with a green suite.
    expect(hosted).toMatch(/configureAuthSession\s*\(\s*useAuth\s*\)/)

    // BOTH signed-capable composition roots, not just the web one. The desktop
    // renderer is a third root that mounts the same shell and is signed-in
    // capable; it was missed on the first pass precisely because nothing here
    // was looking at it.
    const desktopRenderer = readFileSync(
      path.join(appRoot, "../claxedo-desktop/src/renderer/index.tsx"),
      "utf8",
    )
    expect(desktopRenderer).toMatch(/configureAuthSession\s*\(\s*useAuth\s*\)/)
    expect(desktopRenderer).toMatch(/configureApiRuntime\(\{\s*bearerToken:\s*getAuthToken\s*\}\)/)

    // And the local entry cannot bind either one even by accident: it imports
    // neither the transport nor the provider (asserted above, over specifiers).
    const local = readFileSync(path.join(appRoot, "src/app/entry/local.tsx"), "utf8")
    expect(local).not.toMatch(/configureApiRuntime\s*\(/)
    expect(local).not.toMatch(/configureAuthSession\s*\(/)
  })

  test("each root binds the machine remote access ITS product can perform", () => {
    // A third seam with the same shape, and the one that already shipped
    // broken: `/api/claxedo/remote-access/*` moved off the desktop's sidecar to
    // the Host Connector, and shared app code kept calling the route. Every
    // suite stayed green because the transport was hardcoded and unowned.
    //
    // Three roots, three different correct answers, none of them a default.
    const hosted = readFileSync(path.join(appRoot, "src/app/entry/main.tsx"), "utf8")
    const desktopRenderer = readFileSync(
      path.join(appRoot, "../claxedo-desktop/src/renderer/index.tsx"),
      "utf8",
    )
    const local = readFileSync(path.join(appRoot, "src/app/entry/local.tsx"), "utf8")

    // The browser served BY the server that mounts those routes.
    expect(hosted).toMatch(/configureHttpMachineRemoteAccess\s*\(/)
    expect(hosted).not.toMatch(/configureDesktopMachineRemoteAccess\s*\(/)

    // Electron, where the connector and the machine key are. Never the HTTP
    // one: its sidecar serves none of those paths, so a fallback would post
    // into a 404 wearing the costume of resilience.
    expect(desktopRenderer).toMatch(/configureDesktopMachineRemoteAccess\s*\(/)
    expect(desktopRenderer).not.toMatch(/configureHttpMachineRemoteAccess\s*\(/)

    // And the local browser product binds NOTHING: `@claxedo/local-server`
    // serves no remote-access route and there is no main process under it, so
    // the panel reports a capability this build does not have.
    expect(local).not.toMatch(/configure(Http|Desktop)?MachineRemoteAccess\s*\(/)
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
