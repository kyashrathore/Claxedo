import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import {
  importSpecifiers,
  resolveImport,
  stripComments,
} from "../../../claxedo-app/src/architecture/import-graph"
import { MAIN_RENDERER_DOCUMENT } from "../main/navigation-guard"

/**
 * What each desktop renderer entry pulls in. The desktop is a third composition
 * root beside `@claxedo/app`'s `main.tsx` and `local.tsx`, and the app's own
 * closure guard (`src/architecture/local-entry-closure.guard.test.ts`) says
 * nothing about it.
 *
 * Two claims, of different kinds:
 *
 *  - Absolute. No renderer entry this desktop ships — the unsigned entry or the
 *    optional hosted activation (`hosted-contributions.ts`) — reaches
 *    `@claxedo/app/auth` or `better-auth-browser-auth.ts`, the one module that
 *    imports `better-auth/client` and mints a token. A signed account is
 *    Electron main's to hold over its own AccountPort, never the renderer's.
 *
 *  - Relative. Documents, the Relay client, the cloud runtime store and both
 *    account adapters are reachable from `@claxedo/app`'s shared shell
 *    (`app/entry/app.tsx` -> `app/integrations/feature-ports.ts`), so the
 *    desktop cannot exclude them without changing app-owned modules. What it can
 *    hold is that it adds none of its own: the unsigned desktop closure
 *    introduces no such module the local browser product lacks.
 *
 * This is the source-graph measurement; Rollup can name a chunk for a dependency
 * no module imports, and the artifact-level counterpart for the browser product
 * is `claxedo-app/scripts/check-local-bundle-identity.ts`.
 */

const desktopRoot = path.resolve(import.meta.dir, "../..")
const appRoot = path.resolve(desktopRoot, "../claxedo-app")
const appSrc = path.join(appRoot, "src")

/**
 * `@claxedo/app`'s declared subpath exports. `resolveImport` maps
 * `@claxedo/app/<x>` onto `src/<x>` and answers null for a real subpath export
 * whose target lives elsewhere, which would make the walk report a clean
 * closure it never followed. Declared exports resolve from the manifest first;
 * everything else falls through to the in-package import graph.
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
  while ((match = dynamicPattern.exec(stripComments(text)))) found.add(match[1])
  return found
}

const label = (file: string) => path.relative(appSrc, file).split(path.sep).join("/")

/**
 * The transitive VALUE-import closure of one entry file, as edges.
 *
 * Value imports only, matching the app's own walk: the bundler erases
 * `import type`, so a type edge to the identity provider puts nothing in the
 * bundle. Bare package specifiers are recorded but not followed — an identity
 * vendor package is a breach wherever it appears and its internals are not this
 * repo's graph.
 */
function closure(entryFile: string, options: { followDynamic?: boolean } = {}) {
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
        if (!resolved || seen.has(resolved) || (dynamic.has(specifier) && options.followDynamic === false)) continue
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

const BASE = closure(entryFile("local.tsx"), { followDynamic: false })
const RELEASE = closure(entryFile("local.tsx"))
const HOSTED_ACTIVATION = closure(entryFile("hosted-contributions.ts"))
const APP_LOCAL = closure(path.join(appSrc, "app/entry/local.tsx"))

/** The identity provider, by every name it travels under. */
const IDENTITY = {
  "the @claxedo/app/auth subpath": (edge: Edge) => edge.specifier === "@claxedo/app/auth",
  "platform/auth/better-auth-browser-auth.ts": (edge: Edge) =>
    edge.module === "platform/auth/better-auth-browser-auth.ts",
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
    "features/documents/",
    "platform/runtime/cloud/",
    "platform/account/",
    "platform/auth/",
    "app/integrations/documents-content-surfaces",
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
  test("is what the one desktop document loads", () => {
    expect(MAIN_RENDERER_DOCUMENT).toBe("index.local.html")
    expect(read(`src/renderer/${MAIN_RENDERER_DOCUMENT}`)).toContain('src="./local.tsx"')
    expect(existsSync(entryFile("local.tsx"))).toBe(true)
    expect(existsSync(entryFile("index.tsx"))).toBe(false)
    expect(existsSync(entryFile("index.html"))).toBe(false)
  })

  test.each(Object.entries(IDENTITY))("does not reach %s", (_name, isMatch) => {
    expect(BASE.edges.filter(isMatch)).toEqual([])
  })

  test("keeps the optional activation behind one literal dynamic edge", () => {
    expect(RELEASE.edges).toContainEqual({
      from: "../../claxedo-desktop/src/renderer/local.tsx",
      specifier: "./hosted-contributions",
      module: "../../claxedo-desktop/src/renderer/hosted-contributions.ts",
      dynamic: true,
    })
    expect(BASE.modules.has("../../claxedo-desktop/src/renderer/hosted-contributions.ts")).toBe(false)
    expect(RELEASE.modules.has("../../claxedo-desktop/src/renderer/hosted-contributions.ts")).toBe(true)
  })

  test("adds no hosted capability that the local browser product does not already have", () => {
    // Set difference against the app's own local entry: the shared shell reaches
    // these already, and desktop must add none. The assertion tightens by itself
    // if app-side work removes one.
    const introduced = hostedModules(BASE.modules).filter((module) => !APP_LOCAL.modules.has(module))
    expect(introduced).toEqual([])

    // Positive control for the difference: the marker set is non-empty in both
    // closures, so an empty result means "no delta", never "nothing scanned".
    expect(hostedModules(APP_LOCAL.modules).length).toBeGreaterThan(0)
    expect(hostedModules(BASE.modules).length).toBeGreaterThan(0)
  })

  test("binds none of the three ports, and passes the shell no bearer", () => {
    // Call sites, not types. Each of these is a line whose deletion leaves a
    // build that compiles, renders, and silently goes anonymous — so the
    // unsigned entry's correctness is equally a matter of them being ABSENT.
    const entry = stripComments(read("src/renderer/local.tsx"))
    for (const [name, pattern] of Object.entries(BINDINGS)) {
      expect(pattern.test(entry), `the unsigned entry must not bind ${name}`).toBe(false)
    }
    // Hosted loaders stay optional. Agent Plugins is composed inside initClaxedo.
    // None of these is an identity port or carries a bearer.
    expect(entry).toMatch(
      /startDesktopRenderer\(\{\s*loadHostedContributions,\s*serviceContributionLoaders\s*\}\)/,
    )
  })
})

describe("the optional signed activation", () => {
  test.each(Object.entries(IDENTITY))("also reaches no renderer identity surface: %s", (_name, isMatch) => {
    expect(HOSTED_ACTIVATION.edges.filter(isMatch)).toEqual([])
  })

  test("binds machine remote access through Electron without owning optional service renderers", () => {
    const activation = stripComments(read("src/renderer/hosted-contributions.ts"))
    expect(activation).toMatch(/^\s*configureDesktopMachineRemoteAccess\(\)$/m)
    expect(activation).toContain("contentSurfaces: []")
    // The only desktop binding of the cloud startup port; shared composer
    // code calls `workspaceStartup()` on desktop too.
    expect(activation).toMatch(/^\s*configureWorkspaceStartup\(cloudWorkspaceStartup\)$/m)
    expect(activation).not.toContain("hosted-content-surfaces")
    expect(activation).not.toContain("documents-content-surfaces")
    expect(activation).not.toContain("configureHttpMachineRemoteAccess")
    expect(activation).not.toContain("configureApiRuntime")
    expect(activation).not.toContain("configureAuthSession")
    // Exactly the cloud-startup path the binding above needs, and nothing
    // else: no content surfaces, no WorkGraph, no Documents. Measured, so a
    // seventh module here means a new edge to review rather than a number to
    // bump.
    //
    // `preload-bridge.ts` is the sixth, and it is a leaf: `hosted-control-call.ts`
    // (already below) reads `api.account` off the global scope, and that read
    // moved into its own module when the three adapters that shared it stopped
    // each writing their own cast. It brings no capability and no further
    // `platform/` edge — it is the same fact, named once.
    expect(hostedModules(HOSTED_ACTIVATION.modules)).toEqual([
      "platform/account/control-plane-account-fetch.ts",
      "platform/account/hosted-control-call.ts",
      "platform/account/hosted-operations.ts",
      "platform/account/preload-bridge.ts",
      "platform/runtime/agent/workspace-relay-connection.ts",
      "platform/runtime/cloud/workspace-runtime-store.ts",
    ])
  })

  test("keeps Documents in its own catalog-driven module", () => {
    const documents = stripComments(read("src/renderer/documents-contributions.ts"))
    expect(documents).toContain("documents-content-surfaces")
  })
})

describe("the shared desktop shell", () => {
  test("holds no identity surface, so the split cannot be undone from the middle", () => {
    // The base entry imports this module. An identity import or a port binding
    // here would put the provider back in the unsigned bundle while both
    // entries still looked correct in review.
    const shell = stripComments(readFileSync(entryFile("shell.tsx"), "utf8"))
    expect(importSpecifiers(shell).filter((specifier) => specifier.includes("auth"))).toEqual([])
    for (const [name, pattern] of Object.entries(BINDINGS)) {
      expect(pattern.test(shell), `the shared shell must not bind ${name}`).toBe(false)
    }
  })
})

describe("the renderer build keeps one local base document", () => {
  /**
   * Run the real config rather than read it.
   *
   * The rollup input is the property that matters: rollup links whatever an
   * input's graph reaches, so a config listing a second document reintroduces
   * a second renderer composition root. A text assertion cannot tell "names
   * the local document" from "uses it"; this runs the real config under both
   * capability settings.
   *
   * `loadEnv` gives prefixed `process.env` values precedence over `.env` files,
   * which is what lets this drive both products from one process.
   */
  async function configFor(authEnabled: string | undefined) {
    const previous = process.env.VITE_AUTH_ENABLED
    if (authEnabled === undefined) delete process.env.VITE_AUTH_ENABLED
    else process.env.VITE_AUTH_ENABLED = authEnabled
    try {
      const { createElectronRenderer } = await import("../../vite.renderer")
      const config = createElectronRenderer("production")
      const input = config.build?.rollupOptions?.input as Record<string, string>
      return {
        input: Object.fromEntries(Object.entries(input).map(([name, file]) => [name, path.basename(file)])),
        hostedActivation: config.define?.__CLAXEDO_HOSTED_ACTIVATION_ENABLED__,
      }
    } finally {
      if (previous === undefined) delete process.env.VITE_AUTH_ENABLED
      else process.env.VITE_AUTH_ENABLED = previous
    }
  }

  test("an unsigned build's only entry document is the local one", async () => {
    // Explicit values only. `loadEnv` also reads `claxedo-app/.env.local`, so
    // "unset" resolves to whatever that developer's file says, so use an
    // explicit false to prove the unsigned build.
    expect(await configFor("false")).toEqual({
      input: { main: "index.local.html", loading: "loading.html" },
      hostedActivation: "false",
    })
  })

  test("a signed-capable build keeps the same local base document", async () => {
    expect(await configFor("true")).toEqual({
      input: { main: "index.local.html", loading: "loading.html" },
      hostedActivation: "true",
    })
  })

  test("only an explicit CLAXEDO_BUILD_TASKS=0 bakes Tasks out of the renderer", async () => {
    const previous = process.env.CLAXEDO_BUILD_TASKS
    const tasksDefine = async (selection: string | undefined) => {
      if (selection === undefined) delete process.env.CLAXEDO_BUILD_TASKS
      else process.env.CLAXEDO_BUILD_TASKS = selection
      const { createElectronRenderer } = await import("../../vite.renderer")
      return createElectronRenderer("production").define?.__CLAXEDO_TASKS_ENABLED__
    }
    try {
      // Unset must stay ON: a packaging run that never heard of the variable
      // has to ship the feature rather than silently drop it.
      expect(await tasksDefine(undefined)).toBe("true")
      expect(await tasksDefine("1")).toBe("true")
      expect(await tasksDefine("0")).toBe("false")
    } finally {
      if (previous === undefined) delete process.env.CLAXEDO_BUILD_TASKS
      else process.env.CLAXEDO_BUILD_TASKS = previous
    }
  })
})

describe("the local base document reaches main and the renderer build", () => {
  test("main and the renderer build import one canonical document constant", () => {
    const main = stripComments(read("src/main/windows.ts"))
    expect(main).toContain("const RENDERER_DOCUMENT = MAIN_RENDERER_DOCUMENT")
    expect(stripComments(read("vite.renderer.ts"))).toContain("MAIN_RENDERER_DOCUMENT")
    expect(stripComments(read("electron.vite.config.ts"))).not.toContain("CLAXEDO_PRODUCT_MODE")

    // And NO literal document name survives in main. Importing the constant is
    // not the property that matters — USING it is, at both sites: the window
    // load and the navigation guard's trusted-URL comparison.
    expect(main.match(/["'`][\w.]*\.html["'`]/g) ?? []).toEqual(["\"loading.html\""])
    expect(main).toContain("loadWindow(win, RENDERER_DOCUMENT)")
    expect(main).toContain("isTrustedRendererDocumentUrl(input, {")
    expect(main).toContain("devServerUrl: process.env.ELECTRON_RENDERER_URL")
    expect(main).toContain("packagedIndexUrl: pathToFileURL(join(root, `../renderer/${RENDERER_DOCUMENT}`)).href")
  })
})

/**
 * `remoteAccessAppOrigin()` reads `import.meta.env.VITE_CLAXEDO_APP_ORIGIN` and
 * falls back to the production origin. The renderer's Vite `root` is the
 * renderer directory, so the app's env files are not applied by Vite itself; a
 * value not forwarded through `define` is absent at runtime, and a staging
 * desktop silently hands phones a production QR. Asserted through the real
 * config because the file can name the variable without the value reaching it.
 */
describe("renderer build carries the hosted app origin", () => {
  async function defineFor(origin: string | undefined) {
    const previous = process.env.VITE_CLAXEDO_APP_ORIGIN
    if (origin === undefined) delete process.env.VITE_CLAXEDO_APP_ORIGIN
    else process.env.VITE_CLAXEDO_APP_ORIGIN = origin
    try {
      const { createElectronRenderer } = await import("../../vite.renderer")
      return createElectronRenderer("production").define ?? {}
    } finally {
      if (previous === undefined) delete process.env.VITE_CLAXEDO_APP_ORIGIN
      else process.env.VITE_CLAXEDO_APP_ORIGIN = previous
    }
  }

  test("forwards a configured app origin into the bundle", async () => {
    const define = await defineFor("https://app-acc-stg-example.claxedo.dev")
    expect(define["import.meta.env.VITE_CLAXEDO_APP_ORIGIN"]).toBe(
      JSON.stringify("https://app-acc-stg-example.claxedo.dev"),
    )
  })

  /**
   * Empty, NOT the string "undefined". `remoteAccessAppOrigin()` treats a falsy
   * value as "not baked" and falls back; the literal text "undefined" is
   * truthy and would be handed to a phone as if it were a URL.
   */
  test("bakes an empty value when unset, so the resolver can fall back", async () => {
    const define = await defineFor("")
    expect(define["import.meta.env.VITE_CLAXEDO_APP_ORIGIN"]).toBe(JSON.stringify(""))
  })
})
