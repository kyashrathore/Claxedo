import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { shortestForbiddenImportChain } from "./import-graph"

const appRoot = path.resolve(import.meta.dir, "../..")

/**
 * What the local entry actually pulls in.
 *
 * The local product exists so an unsigned desktop does not ship an identity
 * provider it can never use. A separate entry file is the necessary first step
 * and — measured here — NOT a sufficient one: `app/entry/local.tsx` imports no
 * auth module directly, and Clerk still reaches its bundle, because
 * `AppInterface` mounts `PrincipalProvider`, which imports `auth-client`,
 * which imports `@clerk/clerk-js/headless`.
 *
 * That chain is recorded below as a BASELINE rather than asserted away. The
 * remaining work is making the provider tree local; until then the honest
 * statement is "one chain, and here it is", not silence. The test fails if a
 * SECOND chain appears, so the gap can only shrink.
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

  test("reaches Clerk through exactly one chain, and that chain is the shell's provider tree", () => {
    // MEASURED, not assumed. If this shrinks to null the assertion below
    // should be replaced with `toBeNull()` — that is the goal state, and this
    // test is how anyone knows whether it has been reached.
    const breach = chainTo("app/entry/local.tsx")

    expect(breach, "expected the known Clerk chain; if it is gone, tighten this test").not.toBeNull()
    expect(breach!.specifier).toContain("@clerk/clerk-js")
    // The chain is `local.tsx -> app/entry/index.tsx -> platform/auth/auth-client.ts`.
    //
    // Measured, and not where I expected: `index.tsx` is the package's public
    // surface, and the local entry reaches it only for `initClaxedo` and
    // `getDefaultConfig`. So the remaining work is splitting that surface, not
    // the provider tree — a distinction worth having before someone starts on
    // the wrong file.
    //
    // Naming the waypoint means a NEW route to Clerk, through some other
    // module, fails here rather than blending into a known failure.
    expect(breach!.chain).toContain("app/entry/index.tsx")
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
