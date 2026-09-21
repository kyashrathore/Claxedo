import { describe, expect, test } from "bun:test"
import fs, { readFileSync } from "node:fs"
import path from "node:path"

import { localServerPackageDir, resolveLocalServerEntry } from "./local-server"
import { publishedPackageNames } from "./published-packages"

/**
 * Desktop product-mode contract: where identity lives versus where compute
 * runs, and the launch wiring that composes the server the desktop boots.
 *
 * The server is resolved by one owner, `scripts/local-server.ts`, for the
 * child entry module, `predev`, `prebuild` and the boot smoke; a second
 * resolver leaves a repository where development works and the packaged build
 * boots the other composition, or vice versa. `local-server.test.ts` asserts
 * the resolved values; what is here is the composition contract those callers
 * sit inside.
 */

const packageRoot = path.resolve(import.meta.dir, "..")

function read(rel: string) {
  return readFileSync(path.join(packageRoot, rel), "utf8")
}

/** The module the desktop server child imports; everything that resolves a server must agree with it. */
const DESKTOP_SERVER_ENTRY = "@claxedo/local-server/self-hosted-execution"

/** The package directory whose sources feed the bundled desktop server. */
const DESKTOP_SERVER_PACKAGE_DIR = "../claxedo-local-server"

describe("desktop server launch wiring", () => {
  test("the server child imports the declared server entry", () => {
    // Anchored to an `import` statement: a bare-substring check is satisfied by
    // prose that names the package.
    expect(read("scripts/claxedo-server-entry.ts")).toMatch(
      new RegExp(`^import [^\\n]* from "${DESKTOP_SERVER_ENTRY}"$`, "m"),
    )
  })

  test("development and production preparation resolve the same server package", () => {
    // Both scripts import one resolver, and the assertion is about the resolved
    // value — what the bundler consumes — not a path string a dead `const` could
    // satisfy.
    for (const script of ["scripts/predev.ts", "scripts/prebuild.ts"]) {
      // Comments dropped: both scripts name `@claxedo/local-server` in prose.
      const code = read(script)
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
        .join("\n")
      expect(code, script).toContain(`from "./local-server"`)
      // Each script gates on the resolution, not merely imports the module.
      expect(code, script).toContain("resolveLocalServerEntry(PACKAGE_DIR)")
    }
    expect(localServerPackageDir(packageRoot)).toBe(path.resolve(packageRoot, DESKTOP_SERVER_PACKAGE_DIR))
    expect(resolveLocalServerEntry(packageRoot).startsWith(localServerPackageDir(packageRoot) + path.sep)).toBe(
      true,
    )
  })

  test("both preparation paths bundle through the one bundler helper", () => {
    for (const script of ["scripts/predev.ts", "scripts/prebuild.ts"]) {
      expect(read(script), script).toContain('from "./bundle-claxedo-server"')
      expect(read(script), script).toContain("claxedo-server-entry.ts")
    }
  })

  test("both preparation paths build every published sibling the bundle consumes", () => {
    for (const script of ["scripts/predev.ts", "scripts/prebuild.ts"]) {
      expect(read(script), script).toContain("buildPublishedPackages(")
    }
    const published = publishedPackageNames(path.resolve(packageRoot, "../.."))
    expect(published).toContain("@claxedo/agent-sdk-runtime")
    expect(published).toContain("@claxedo/workspace-runtime")
  })

  // `buildPublishedPackages` hands the whole set to `turbo build`, whose
  // `^build` edge orders them by the manifests rather than by the order a
  // script happens to list them in. Workspace-runtime consumes the SDK
  // runtime's dist, so that edge has to be declared to exist at all.
  test("turbo can order the SDK runtime before workspace-runtime", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(packageRoot, "../workspace-runtime/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> }
    expect(manifest.dependencies?.["@claxedo/agent-sdk-runtime"]).toBeDefined()
  })

  test("the renderer boots through the app package entry, not a source-relative path", () => {
    // A package specifier is what lets the boundary guards see the edge.
    const renderer = read("src/renderer/shell.tsx")
    expect(renderer).toMatch(/from "@claxedo\/app(\/[^"]*)?"/)
    expect(renderer).not.toContain("../../claxedo-app/src")
  })

  test("the renderer never receives an account bearer", () => {
    // Signed desktop calls cross the closed Electron AccountPort operation map.
    // Neither the base entry nor its optional activation may recreate a browser
    // auth session or hand a raw bearer to shared fetch.
    for (const renderer of [read("src/renderer/local.tsx"), read("src/renderer/hosted-contributions.ts")]) {
      expect(renderer).not.toMatch(/^import[^\n]*@claxedo\/app\/auth/m)
      expect(renderer).not.toMatch(/^configureApiRuntime\(/m)
    }
  })

  test("binds machine remote access to the Host Connector, with no HTTP fallback", () => {
    // `@claxedo/local-server` serves no `/api/claxedo/remote-access/*` path;
    // without this binding "Enable remote access" posts into a 404.
    const renderer = read("src/renderer/hosted-contributions.ts")

    expect(renderer).toMatch(/^\s*configureDesktopMachineRemoteAccess\(\)$/m)
    // Never the HTTP one: the desktop binding refuses when the preload exposes
    // no bridge, and an HTTP fallback would hide that.
    expect(renderer).not.toContain("configureHttpMachineRemoteAccess")
  })

  test("presents the daemon capability under the header the daemon reads it from", () => {
    // The desktop's main composition is forbidden from importing
    // `@claxedo/local-server` (see the product-boundary policy), so the two
    // halves of this protocol are two literals in two packages. They are the
    // whole authority boundary: a mismatch leaves the daemon refusing its own
    // application, which is a startup that looks like a hung renderer.
    const presenter = read("src/main/daemon-request.ts")
    const verifier = fs.readFileSync(
      path.join(localServerPackageDir(packageRoot), "src/app/daemon-admission.ts"),
      "utf8",
    )
    const header = (source: string, name: string) =>
      new RegExp(`export const ${name} = "([^"]+)"`).exec(source)?.[1]

    expect(header(presenter, "CLAXEDO_DAEMON_CAPABILITY_HEADER")).toBe("x-claxedo-daemon-capability")
    expect(header(verifier, "DAEMON_CAPABILITY_HEADER"))
      .toBe(header(presenter, "CLAXEDO_DAEMON_CAPABILITY_HEADER"))
  })

  test("declares its server dependency, rather than reaching into a source tree", () => {
    // A source-relative reach into a sibling package has no manifest edge, so
    // no dependency check can see it; both edges must be declared.
    const manifest = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>
    }
    const deps = manifest.dependencies ?? {}

    expect(Object.keys(deps)).toContain("@claxedo/local-server")
    expect(Object.keys(deps)).toContain("@claxedo/app")
    expect(read("scripts/claxedo-server-entry.ts")).not.toContain("../../claxedo-server/src")
  })
})
