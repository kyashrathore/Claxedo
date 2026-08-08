import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import {
  importSpecifiers,
  resolveImport,
  stripComments,
} from "../../../claxedo-app/src/architecture/import-graph"
import { desktopProductMode, rendererDocument } from "../main/navigation-guard"

/**
 * What each desktop renderer entry actually pulls in.
 *
 * The desktop is a THIRD composition root beside `@claxedo/app`'s `main.tsx`
 * and `local.tsx`, and until this file existed nothing measured it. The app's
 * `src/architecture/local-entry-closure.guard.test.ts` proved the LOCAL BROWSER
 * entry never reaches Clerk and stayed green the entire time the desktop —
 * the product users actually install — imported `@claxedo/app/auth` from its
 * only entry and shipped the identity provider to every unsigned launch.
 *
 * Two properties are measured here, and they are different kinds of claim:
 *
 *  - ABSOLUTE. The unsigned entry's closure reaches no `@claxedo/app/auth`, no
 *    `auth-client.ts`, no Clerk, no Convex. This is what Unit 11 changes, and
 *    the companion assertions prove the signed entry DOES reach all of them —
 *    without that control, a walker that resolved nothing would report a
 *    finished migration.
 *
 *  - RELATIVE. WorkGraph, Documents, the Relay client, the cloud runtime store
 *    and both account adapters are reachable from `@claxedo/app`'s SHARED
 *    shell (`app/entry/app.tsx` -> `app/integrations/feature-ports.ts`), so
 *    `src/app/entry/local.tsx` reaches every one of them too. Desktop cannot
 *    remove them without changing app-owned modules, and pretending otherwise
 *    would be the green-guard failure this file exists to end. What IS desktop's
 *    to hold is that it adds none of its own: the unsigned desktop closure must
 *    introduce no such module that the local browser product does not already
 *    have. That is asserted, and it bites the moment desktop code reaches for
 *    one directly.
 *
 * A source closure is not an artifact. Rollup can name a chunk for a dependency
 * no module imports, so this is the SOURCE-GRAPH measurement; the artifact-level
 * counterpart for the browser product is
 * `claxedo-app/scripts/check-local-bundle-identity.ts`.
 */

const desktopRoot = path.resolve(import.meta.dir, "../..")
const appRoot = path.resolve(desktopRoot, "../claxedo-app")
const appSrc = path.join(appRoot, "src")

/**
 * `@claxedo/app`'s declared subpath exports.
 *
 * Resolved from the manifest rather than left to `resolveImport`, which maps
 * `@claxedo/app/<x>` onto `src/<x>` and therefore answers NULL for
 * `@claxedo/app/auth` — whose real target is `src/app/entry/auth.ts`. That is
 * not a hypothetical gap: it is precisely the specifier by which the desktop
 * renderer reached Clerk, so a walk built on the unpatched resolver reports a
 * clean desktop closure and is wrong.
 */
const appExports = (
  JSON.parse(readFileSync(path.join(appRoot, "package.json"), "utf8")) as { exports?: Record<string, string> }
).exports ?? {}

function resolve(fromFile: string, specifier: string) {
  if (specifier === "@claxedo/app" || specifier.startsWith("@claxedo/app/")) {
    const target = appExports[specifier.replace(/^@claxedo\/app/, ".")]
    if (target) {
      const file = path.resolve(appRoot, target)
      return existsSync(file) ? file : null
    }
  }
  return resolveImport(appRoot, fromFile, specifier)
}

type Edge = { from: string; specifier: string; module: string | null; dynamic: boolean }

const dynamicPattern = /import\s*\(\s*["']([^"']+)["']\s*\)/g

function dynamicSpecifiers(text: string) {
  const found = new Set<string>()
  let match: RegExpExecArray | null
  dynamicPattern.lastIndex = 0
  while ((match = dynamicPattern.exec(stripComments(text)))) found.add(match[1]!)
  return found
}

const label = (file: string) => path.relative(appSrc, file).split(path.sep).join("/")

/**
 * The transitive VALUE-import closure of one entry file, as edges.
 *
 * Value imports only, matching the app's own walk: the bundler erases
 * `import type`, so a type edge to the identity provider puts nothing in the
 * bundle. Bare package specifiers are recorded but not followed — `@clerk/…` is
 * a breach wherever it appears and its internals are not this repo's graph.
 */
function closure(entryFile: string) {
  const edges: Edge[] = []
  const seen = new Set([entryFile])
  let frontier = [entryFile]

  while (frontier.length) {
    const next: string[] = []
    for (const file of frontier) {
      if (!existsSync(file)) continue
      const text = readFileSync(file, "utf8")
      const dynamic = dynamicSpecifiers(text)
      for (const specifier of importSpecifiers(text)) {
        const resolved = resolve(file, specifier)
        edges.push({
          from: label(file),
          specifier,
          module: resolved ? label(resolved) : null,
          dynamic: dynamic.has(specifier),
        })
        if (!resolved || seen.has(resolved)) continue
        seen.add(resolved)
        next.push(resolved)
      }
    }
    frontier = next
  }

  return { edges, modules: new Set([...seen].map(label)) }
}

const entryFile = (name: string) => path.join(desktopRoot, "src/renderer", name)
const read = (rel: string) => readFileSync(path.join(desktopRoot, rel), "utf8")

const UNSIGNED = closure(entryFile("local.tsx"))
const SIGNED = closure(entryFile("index.tsx"))
const APP_LOCAL = closure(path.join(appSrc, "app/entry/local.tsx"))

/** The identity provider, by every name it travels under. */
const IDENTITY = {
  "the @claxedo/app/auth subpath": (edge: Edge) => edge.specifier === "@claxedo/app/auth",
  "platform/auth/auth-client.ts": (edge: Edge) => edge.module === "platform/auth/auth-client.ts",
  "@clerk/*": (edge: Edge) => edge.specifier === "@clerk/clerk-js" || edge.specifier.startsWith("@clerk/"),
  "convex": (edge: Edge) => edge.specifier === "convex" || edge.specifier.startsWith("convex/"),
} satisfies Record<string, (edge: Edge) => boolean>

/**
 * Modules that belong to a hosted capability, by module path.
 *
 * Used for the RELATIVE claim only — see the header. Every one of these is
 * reachable from `@claxedo/app`'s shared shell today, so the assertion is
 * "desktop adds none", not "none are present".
 */
function hostedModules(modules: Set<string>) {
  const prefixes = [
    "features/workgraph/",
    "features/documents/",
    "platform/runtime/cloud/",
    "platform/account/",
    "platform/auth/",
    "app/integrations/hosted-content-surfaces",
  ]
  const exact = ["platform/runtime/agent/workspace-relay-connection.ts"]
  return [...modules]
    .filter((module) => prefixes.some((prefix) => module.startsWith(prefix)) || exact.includes(module))
    .toSorted()
}

/** The three unprotected port bindings, as CALL sites rather than imports. */
const BINDINGS = {
  bearer: /configureApiRuntime\(\{\s*bearerToken:/,
  authSession: /configureAuthSession\s*\(\s*useAuth\s*\)/,
  remoteAccess: /configureDesktopMachineRemoteAccess\s*\(/,
} satisfies Record<string, RegExp>

describe("the unsigned desktop renderer entry", () => {
  test("is what the local product document loads, and the local product is the default build", () => {
    // The entry is only meaningful if a build actually points at it. Both
    // halves matter: `desktopProductMode` decides which document is emitted and
    // which one `src/main/windows.ts` loads, and the document decides which
    // entry module rollup links.
    expect(desktopProductMode({})).toBe("local")
    expect(desktopProductMode({ VITE_AUTH_ENABLED: "false" })).toBe("local")
    expect(desktopProductMode({ VITE_AUTH_ENABLED: "true" })).toBe("signed")

    const document = rendererDocument("local")
    expect(document).toBe("index.local.html")
    expect(read(`src/renderer/${document}`)).toContain('src="./local.tsx"')
    expect(existsSync(entryFile("local.tsx"))).toBe(true)
  })

  test.each(Object.entries(IDENTITY))("does not reach %s", (_name, isMatch) => {
    expect(UNSIGNED.edges.filter(isMatch)).toEqual([])
  })

  test("the signed entry reaches every one of them, so the walk is not measuring nothing", () => {
    // Positive control. A resolver that answered null everywhere — which is
    // exactly what the shared `resolveImport` does for `@claxedo/app/auth`, and
    // why this file resolves subpaths through the manifest — would report the
    // unsigned closure clean and look like a finished migration.
    for (const [name, isMatch] of Object.entries(IDENTITY)) {
      if (name === "convex") continue // no product reaches Convex from the renderer
      expect(SIGNED.edges.filter(isMatch).length, `the signed entry should reach ${name}`).toBeGreaterThan(0)
    }
    // And the chain is the real one, hop by hop, not a bare package name
    // appearing somewhere in the graph.
    expect(SIGNED.edges).toContainEqual({
      from: "../../claxedo-desktop/src/renderer/index.tsx",
      specifier: "@claxedo/app/auth",
      module: "app/entry/auth.ts",
      dynamic: false,
    })
    expect(SIGNED.edges).toContainEqual({
      from: "app/entry/auth.ts",
      specifier: "@/platform/auth/auth-client",
      module: "platform/auth/auth-client.ts",
      dynamic: false,
    })
  })

  test("adds no hosted capability that the local browser product does not already have", () => {
    // The RELATIVE claim. WorkGraph, Documents, the Relay client, the cloud
    // runtime store and both account adapters arrive through
    // `app/entry/app.tsx -> app/integrations/feature-ports.ts`, which BOTH local
    // products mount; removing them is app-owned work, not Unit 11's, and
    // asserting their absence here would simply be false.
    //
    // What is desktop's to hold is that its own entry and shell reach for none
    // of them directly. Set difference, so the day app-side work removes one the
    // assertion tightens by itself instead of going stale.
    const introduced = hostedModules(UNSIGNED.modules).filter((module) => !APP_LOCAL.modules.has(module))
    expect(introduced).toEqual([])

    // Positive control for the difference: the marker set is non-empty in both
    // closures, so an empty result means "no delta", never "nothing scanned".
    expect(hostedModules(APP_LOCAL.modules).length).toBeGreaterThan(0)
    expect(hostedModules(UNSIGNED.modules).length).toBeGreaterThan(0)
  })

  test("binds none of the three ports, and passes the shell no bearer", () => {
    // Call sites, not types. Each of these is a line whose deletion leaves a
    // build that compiles, renders, and silently goes anonymous — so the
    // unsigned entry's correctness is equally a matter of them being ABSENT.
    const entry = stripComments(read("src/renderer/local.tsx"))
    for (const [name, pattern] of Object.entries(BINDINGS)) {
      expect(pattern.test(entry), `the unsigned entry must not bind ${name}`).toBe(false)
    }
    // `startDesktopRenderer()` with no argument is what makes the platform
    // descriptor omit `getAuthToken` and `authEnabled` resolve false; an
    // argument here would compose hosted contributions in a build with no
    // provider to sign into.
    expect(entry).toMatch(/startDesktopRenderer\(\s*\)/)
  })
})

describe("the signed desktop renderer entry", () => {
  test("is what the signed product document loads", () => {
    const document = rendererDocument("signed")
    expect(document).toBe("index.html")
    expect(read(`src/renderer/${document}`)).toContain('src="./index.tsx"')
  })

  test("binds all three ports at module scope, and supplies the bearer", () => {
    // The mirror of the assertion above, and the reason the split is a split
    // rather than a deletion: a signed desktop legitimately wants these.
    const entry = stripComments(read("src/renderer/index.tsx"))
    expect(entry).toMatch(/^configureApiRuntime\(\{ bearerToken: getAuthToken \}\)$/m)
    expect(entry).toMatch(/^configureAuthSession\(useAuth\)$/m)
    expect(entry).toMatch(/^configureDesktopMachineRemoteAccess\(\)$/m)
    expect(entry).toMatch(/startDesktopRenderer\(\{ getAuthToken \}\)/)
    // Never the browser implementation: the desktop sidecar serves none of
    // `/api/claxedo/remote-access/*`, so an HTTP fallback would post into a 404
    // wearing the costume of resilience.
    expect(entry).not.toContain("configureHttpMachineRemoteAccess")
  })
})

describe("the shared desktop shell", () => {
  test("holds no identity surface, so the split cannot be undone from the middle", () => {
    // Both entries import this module. An identity import or a port binding
    // here would put the provider back in the unsigned bundle while both
    // entries still looked correct in review.
    const shell = stripComments(readFileSync(entryFile("shell.tsx"), "utf8"))
    expect(importSpecifiers(shell).filter((specifier) => specifier.includes("auth"))).toEqual([])
    for (const [name, pattern] of Object.entries(BINDINGS)) {
      expect(pattern.test(shell), `the shared shell must not bind ${name}`).toBe(false)
    }
  })
})

describe("the renderer build emits one document per product", () => {
  /**
   * Run the real config rather than read it.
   *
   * The rollup INPUT is the property that matters: rollup links whatever an
   * input's graph reaches, so a config listing both documents would put
   * `index.tsx` — and through it Clerk — into the local artifact no matter which
   * document main then loaded. A text assertion cannot tell "computes the
   * document" from "uses the document"; an earlier version of this test did
   * exactly that and stayed green while the input was reverted to a hard-coded
   * `index.html`.
   *
   * `loadEnv` gives prefixed `process.env` values precedence over `.env` files,
   * which is what lets this drive both products from one process.
   */
  async function inputFor(authEnabled: string | undefined) {
    const previous = process.env.VITE_AUTH_ENABLED
    if (authEnabled === undefined) delete process.env.VITE_AUTH_ENABLED
    else process.env.VITE_AUTH_ENABLED = authEnabled
    try {
      const { createElectronRenderer } = await import("../../vite.renderer")
      const config = createElectronRenderer("production")
      const input = config.build?.rollupOptions?.input as Record<string, string>
      return Object.fromEntries(Object.entries(input).map(([name, file]) => [name, path.basename(file)]))
    } finally {
      if (previous === undefined) delete process.env.VITE_AUTH_ENABLED
      else process.env.VITE_AUTH_ENABLED = previous
    }
  }

  test("an unsigned build's only entry document is the local one", async () => {
    // Explicit values only. `loadEnv` also reads `claxedo-app/.env.local`, so
    // "unset" resolves to whatever that developer's file says — the unset rule
    // is `desktopProductMode({})`'s to state, and it is asserted there as a pure
    // function rather than against a machine's dotfiles.
    expect(await inputFor("false")).toEqual({ main: "index.local.html", loading: "loading.html" })
  })

  test("a signed build's only entry document is the hosted one", async () => {
    expect(await inputFor("true")).toEqual({ main: "index.html", loading: "loading.html" })
  })
})

describe("the product mode reaches the main process", () => {
  test("the build defines exactly the key windows.ts reads", () => {
    // `src/main/windows.ts` picks the document from a BAKED value, because the
    // user's machine has no VITE_AUTH_ENABLED. If the define were dropped, main
    // would resolve `local` and a signed build would load a document it never
    // emitted — a blank window, past a green suite. Key matched to key, both
    // read out of the code rather than asserted as literals in two places.
    const main = stripComments(read("src/main/windows.ts"))
    const key = main.match(/import\.meta\.env\.(CLAXEDO_[A-Z_]+)/)?.[1]
    expect(key).toBe("CLAXEDO_PRODUCT_MODE")

    const config = stripComments(read("electron.vite.config.ts"))
    expect(config).toContain(`"import.meta.env.${key}"`)
    expect(config).toContain("desktopProductModeForBuild(mode)")
  })

  test("main and the renderer build resolve the document through one function", () => {
    // Two string literals that agree until they don't is exactly how a shipped
    // renderer ends up unloadable, so both callers go through
    // `rendererDocument`.
    const main = stripComments(read("src/main/windows.ts"))
    expect(main).toContain("rendererDocument(PRODUCT_MODE)")
    expect(stripComments(read("vite.renderer.ts"))).toContain("rendererDocument(desktopProductMode(env))")

    // And NO literal document name survives in main. Computing the constant is
    // not the property that matters — USING it is, at both sites: the window
    // load and the navigation guard's trusted-URL comparison. A first version of
    // this test asserted only the line above and stayed green while
    // `loadMainWindow` was reverted to a hard-coded `"index.html"`, which is the
    // exact regression it exists to catch.
    expect(main.match(/["'`][\w.]*\.html["'`]/g) ?? []).toEqual(["\"loading.html\""])
    expect(main).toContain("loadWindow(win, RENDERER_DOCUMENT)")
    expect(main).toContain("new URL(RENDERER_DOCUMENT, process.env.ELECTRON_RENDERER_URL)")
    expect(main).toContain("../renderer/${RENDERER_DOCUMENT}")
  })
})
