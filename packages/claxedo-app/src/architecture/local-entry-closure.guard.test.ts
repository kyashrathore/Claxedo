import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { importSpecifiers, resolveImport, shortestForbiddenImportChain, stripComments } from "./import-graph"

const appRoot = path.resolve(import.meta.dir, "../..")
const srcRoot = path.join(appRoot, "src")

/**
 * What the local entry actually pulls in.
 *
 * The local product exists so an unsigned desktop does not ship an identity
 * provider it can never use. A separate entry file was the necessary first step
 * and — measured here — not a sufficient one: `app/entry/local.tsx` imported no
 * auth module directly, yet the identity provider reached its bundle anyway through four other
 * modules. All four are cut; this file now asserts that rather than recording
 * it.
 *
 * It measures twice, and both measurements are load-bearing:
 *
 *  - The shortest chain names the tightest coupling — the one a reader would
 *    have to break next, and the fastest signal when one comes back.
 *  - `LOCAL_AUTH_CLIENT_IMPORTERS` names every module in the local closure that
 *    imports the identity provider's real modules — `browser-auth.ts` (the
 *    port, which also carries real values, not just types) and
 *    `better-auth-browser-auth.ts` (the vendor client). A shortest-path walk
 *    reports one chain and hides the rest, and more than one can exist at
 *    once; cutting the shortest only promotes the next. So the whole-closure
 *    check is what actually holds the line, and the shortest-chain check is
 *    only the diagnostic.
 *
 * A source closure is not an artifact, and this file cannot see the difference.
 * Rollup config can name a chunk for a dependency no module imports, so the
 * emitted-bundle check lives separately — a green result here means the source
 * graph is clean, nothing more.
 */

/** Packages a local build has no way to use. */
const FORBIDDEN = ["better-auth", "better-auth/client"]

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
 * type`, and a type edge to the identity provider does not put it in the
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
 * The local closure's remaining routes to the identity provider, by the module that owns each.
 *
 * Empty: `local.tsx` deliberately binds neither the token source nor the
 * identity provider, so the hosted entry and the desktop renderer bind both
 * ports and the identity provider is simply absent from the local bundle
 * rather than present-but-unused.
 *
 * This list is an invariant, not a recorded baseline: a module appearing here
 * is a new route to the identity provider from local code, and the fix is a
 * port, not an entry in this array. Every such route has the same shape — a
 * module that needs a token importing the thing that mints one — and the same
 * remedy: name the capability and let a composition root bind it.
 *
 * This measures value imports only — `auth-session.ts` still names `useAuth`
 * as an `import type`, which the bundler erases and which therefore correctly
 * does not count.
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
    // Scanned over import specifiers, not the whole file: matching raw source
    // text would trip on this entry's own doc comment, which names the
    // modules it deliberately avoids. A guard that cannot tell an import from
    // a sentence about an import is not measuring the code.
    const source = readFileSync(path.join(appRoot, "src/app/entry/local.tsx"), "utf8")
    const specifiers = importSpecifiers(source)

    for (const forbidden of ["auth-client", "better-auth", "platform/api/api"]) {
      expect(
        specifiers.filter((specifier) => specifier.includes(forbidden)),
        `the local entry must not import ${forbidden}`,
      ).toEqual([])
    }
  })

  test("does not reach the identity provider at all", () => {
    // The local entry must not reach the identity provider through any chain.
    // Every route back to it has the same shape — a module that needs a token
    // importing the thing that mints one — and the same fix: name the
    // capability and let a composition root supply it, never import the
    // minter directly.
    expect(chainTo("app/entry/local.tsx"), "the local entry reached a forbidden package again").toBeNull()
  })

  test("records every remaining route to the identity provider, not just the shortest", () => {
    // Empty, and it must stay empty. A shortest-path walk reports one chain and
    // hides the rest, and more than one route can exist at once; cutting the
    // shortest only promotes the next. So this checks the whole closure — the
    // check above only holds the tightest coupling, not every route.
    //
    // Targets the identity provider's two real modules: `browser-auth.ts`
    // (the port — it also exports real values, `browserAuthUnavailable` and
    // friends, so a value import of it is a genuine route, not just a type
    // edge) and `better-auth-browser-auth.ts` (the vendor client that imports
    // `better-auth/client`). Both resolve to `[]` today, and the walk itself
    // is proven non-trivial by the positive control below, which finds ~80
    // importers of `platform/api/api.ts` from this same entry — so an empty
    // result here is the walk finding nothing, not the walk finding nowhere
    // to look.
    expect(importersOf("app/entry/local.tsx", "platform/auth/browser-auth.ts")).toEqual(LOCAL_AUTH_CLIENT_IMPORTERS)
    expect(importersOf("app/entry/local.tsx", "platform/auth/better-auth-browser-auth.ts")).toEqual(
      LOCAL_AUTH_CLIENT_IMPORTERS,
    )
  })

  test("the importer walk sees the closure it is supposed to be measuring", () => {
    // Positive control for the assertion above. A walk that resolved nothing
    // would report an empty importer list and read as a finished migration.
    // `platform/api/api.ts` is the right probe: it is unquestionably in the
    // local closure (`app/entry/app.tsx` imports it) and it is the module whose
    // auth edge was just cut, so this fails loudly if the edge comes back under
    // some other name.
    expect(importersOf("app/entry/local.tsx", "platform/api/api.ts")).toContain("app/entry/app.tsx")
    expect(importSpecifiers(readFileSync(path.join(srcRoot, "app/entry/main.tsx"), "utf8"))).toContain(
      "#browser-auth-adapter",
    )
  })

  test("the asymmetry that keeps the transport out of the chain is a call site, not a type", () => {
    // Why api.ts dropped off the chain above, and the one way it comes back.
    //
    // `platform/api/api.ts` takes its bearer from
    // `configureApiRuntime({ bearerToken })`. Nothing forces a build to bind
    // one — that is the point, since the local product has no identity
    // provider to bind — so the hosted binding is a call site with no type to
    // protect it. Delete it and `app/entry/main.tsx` still compiles, still
    // renders, and sends every hosted request with no Authorization header.
    // `app-ports-wiring.guard.test.ts` records the same failure shape costing
    // a hosted feature its entire live-sync doorbell with a green suite.
    const hosted = stripComments(readFileSync(path.join(appRoot, "src/app/entry/main.tsx"), "utf8"))

    expect(hosted).toMatch(/bearerToken:\s*browserAuthAdapter\.transport === "bearer"/)
    expect(hosted).toMatch(/browserCredentials:\s*browserAuthAdapter\.transport === "cookie"/)
    expect(importSpecifiers(hosted)).toContain("#browser-auth-adapter")

    // The auth-session port has exactly the same shape and therefore exactly
    // the same hazard, one seam over. `platform/auth/auth-session.ts` now takes
    // its `useAuth` from `configureAuthSession` instead of importing it, which
    // is what removed the shell's provider tree from the local closure. Delete
    // the binding and every signed-in build compiles, renders, and reports
    // anonymous — account menu stuck on "Not signed in", with a green suite.
    expect(hosted).toMatch(/configureAuthSession\s*\(\s*browserAuthAdapter\.useAuth\s*\)/)

    // The desktop is signed through Electron main, not a second renderer auth
    // provider. Its base and optional contribution chunk therefore bind neither
    // browser auth seam and receive no bearer.
    const desktopBase = stripComments(readFileSync(path.join(appRoot, "../claxedo-desktop/src/renderer/local.tsx"), "utf8"))
    const desktopHosted = stripComments(readFileSync(
      path.join(appRoot, "../claxedo-desktop/src/renderer/hosted-contributions.ts"),
      "utf8",
    ))
    for (const desktopRenderer of [desktopBase, desktopHosted]) {
      expect(desktopRenderer).not.toMatch(/^\s*configureAuthSession\s*\(/m)
      expect(desktopRenderer).not.toMatch(/^\s*configureApiRuntime\s*\(/m)
    }

    // And the local entry cannot bind either one even by accident: it imports
    // neither the transport nor the provider (asserted above, over specifiers).
    const local = stripComments(readFileSync(path.join(appRoot, "src/app/entry/local.tsx"), "utf8"))
    expect(local).not.toMatch(/configureApiRuntime\s*\(/)
    expect(local).not.toMatch(/configureAuthSession\s*\(/)
  })

  test("each root binds the machine remote access ITS product can perform", () => {
    // A third seam with the same shape: each root must bind the remote-access
    // implementation its product can actually reach, since a green suite
    // alone cannot tell a hardcoded wrong transport from a bound right one.
    //
    // Three roots, three different correct answers, none of them a default.
    const hosted = stripComments(readFileSync(path.join(appRoot, "src/app/entry/main.tsx"), "utf8"))
    const desktopRenderer = stripComments(readFileSync(
      path.join(appRoot, "../claxedo-desktop/src/renderer/hosted-contributions.ts"),
      "utf8",
    ))
    const local = stripComments(readFileSync(path.join(appRoot, "src/app/entry/local.tsx"), "utf8"))

    // The browser served by the server that mounts those routes.
    expect(hosted).toMatch(/configureHttpMachineRemoteAccess\s*\(/)
    expect(hosted).not.toMatch(/configureDesktopMachineRemoteAccess\s*\(/)

    // Electron, where the connector and the machine key are. Never the HTTP
    // one: its sidecar serves none of those paths, so a fallback would post
    // into a 404 wearing the costume of resilience.
    expect(desktopRenderer).toMatch(/configureDesktopMachineRemoteAccess\s*\(/)
    expect(desktopRenderer).not.toMatch(/configureHttpMachineRemoteAccess\s*\(/)

    // And the local browser product binds nothing: `@claxedo/local-server`
    // serves no remote-access route and there is no main process under it, so
    // the panel reports a capability this build does not have.
    expect(local).not.toMatch(/configure(Http|Desktop)?MachineRemoteAccess\s*\(/)
  })

  test("the hosted entry delegates identity to the mandatory build-time selector", () => {
    const hosted = stripComments(readFileSync(path.join(srcRoot, "app/entry/main.tsx"), "utf8"))
    const selection = stripComments(readFileSync(path.join(appRoot, "vite.browser-auth.ts"), "utf8"))
    expect(importSpecifiers(hosted)).toContain("#browser-auth-adapter")
    expect(selection).toContain("better-auth-browser-auth.ts")
  })

  test("the local vite config builds the local html, not the hosted one", () => {
    // The other way a "local build" silently becomes a hosted one.
    const config = stripComments(readFileSync(path.join(appRoot, "vite.local.config.ts"), "utf8"))

    expect(config).toContain("index.local.html")
    // And writes somewhere else, so one build cannot overwrite the other's
    // output — both are produced by CI.
    expect(config).toContain("dist-local")
  })
})
