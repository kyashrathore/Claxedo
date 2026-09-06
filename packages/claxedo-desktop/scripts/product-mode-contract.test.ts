import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

import { localServerPackageDir, resolveLocalServerEntry } from "./local-server"

/**
 * Desktop product-mode contract: where identity lives versus where compute
 * runs, and the launch wiring that composes the server the desktop boots.
 *
 * This pins the LAUNCH WIRING. Desktop used to resolve its server
 * in four independent places — the child entry module, `predev`, `prebuild`,
 * and the boot smoke — and three out of four leaves a repository where
 * development works and the packaged build boots the other composition, or
 * vice versa. Unit 11 gave that answer one owner, `scripts/local-server.ts`;
 * `local-server.test.ts` asserts the resolved values, and what remains here is
 * the composition contract those callers sit inside.
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

  test("both preparation paths build agent-sdk-runtime before workspace-runtime", () => {
    for (const script of ["scripts/predev.ts", "scripts/prebuild.ts"]) {
      const code = read(script)
      const agentBuild = code.indexOf("bun run build`.cwd(AGENT_RUNTIME_DIR)")
      const workspaceBuild = code.indexOf("bun run build`.cwd(WS_RUNTIME_DIR)")
      expect(agentBuild, `${script} builds agent-sdk-runtime`).toBeGreaterThan(-1)
      expect(workspaceBuild, `${script} builds workspace-runtime`).toBeGreaterThan(-1)
      expect(agentBuild, `${script} dependency order`).toBeLessThan(workspaceBuild)
    }
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

  test("declares its server dependency, rather than reaching into a source tree", () => {
    // A source-relative reach into a sibling package has no manifest edge, so
    // no dependency check can see it; both edges must be declared.
    const manifest = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>
    }
    const deps = manifest.dependencies ?? {}

    expect(Object.keys(deps)).toContain("@claxedo/local-server")
    expect(Object.keys(deps)).toContain("@claxedo/app")
    // And the reach-through is gone from the entry.
    expect(read("scripts/claxedo-server-entry.ts")).not.toContain("../../claxedo-server/src")
  })
})
