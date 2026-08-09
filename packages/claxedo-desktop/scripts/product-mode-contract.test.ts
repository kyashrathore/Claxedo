import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

import { localServerPackageDir, resolveLocalServerEntry } from "./local-server"

/**
 * Desktop product-mode contract.
 *
 * The split introduces a distinction the desktop has never had to state: where
 * IDENTITY lives versus where COMPUTE runs. Four modes come out of that, and
 * they are easy to conflate in review because three of them look like "the
 * desktop app" from the outside.
 *
 * Recording the matrix is not documentation for its own sake. Unit 6 makes
 * Electron main the sole account-credential owner and Unit 11 rewires the
 * renderer onto it; both units are judged against these rows. A change that
 * makes unsigned launch require an account, or lets an unsigned desktop
 * provision a cloud VM, is a change to this table and has to say so.
 *
 * The second half pins the LAUNCH WIRING. Desktop used to resolve its server
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

/**
 * The module the desktop server child imports, relative to the desktop package.
 *
 * Unit 5 changed this from `../../claxedo-server/src/deployments/local/server`
 * — a source-relative reach into the MIXED composition — to the local
 * product's declared package entry. Everything that resolves a server must
 * agree with it.
 */
const DESKTOP_SERVER_ENTRY = "@claxedo/local-server/self-hosted-execution"

/** The package directory whose sources feed the bundled desktop server. */
const DESKTOP_SERVER_PACKAGE_DIR = "../claxedo-local-server"

type ProductMode = {
  mode: string
  /** Where the account credential lives, or `none`. */
  identity: "none" | "electron-main" | "browser"
  /** Where the agent actually executes. */
  compute: "laptop" | "cloud-vm"
  /** Whether the laptop must stay awake for the workspace to be reachable. */
  requiresLaptop: boolean
  /** Processes beyond Electron + renderer + local-server. */
  extraProcesses: string[]
  reachableFrom: string[]
}

/**
 * The supported product modes after the split.
 *
 * Note what is NOT here: an unsigned desktop that provisions a sandbox VM. That
 * combination is deliberately outside the product contract — Create Cloud
 * Workspace begins sign-in instead — and its absence from this list is the
 * assertion.
 */
const PRODUCT_MODES: ProductMode[] = [
  {
    mode: "unsigned-local",
    identity: "none",
    compute: "laptop",
    requiresLaptop: true,
    extraProcesses: [],
    reachableFrom: ["this-desktop"],
  },
  {
    mode: "signed-local",
    identity: "electron-main",
    compute: "laptop",
    requiresLaptop: true,
    extraProcesses: [],
    reachableFrom: ["this-desktop"],
  },
  {
    mode: "linked-host",
    identity: "electron-main",
    compute: "laptop",
    requiresLaptop: true,
    extraProcesses: ["host-connector"],
    reachableFrom: ["this-desktop", "signed-browser", "signed-mobile", "other-signed-desktop"],
  },
  {
    mode: "signed-cloud",
    identity: "electron-main",
    compute: "cloud-vm",
    requiresLaptop: false,
    extraProcesses: [],
    reachableFrom: ["this-desktop", "signed-browser", "signed-mobile", "other-signed-desktop"],
  },
]

/**
 * NOT A BEHAVIOUR TEST, and marked so it cannot be mistaken for one.
 *
 * `PRODUCT_MODES` is declared in this file and nothing in `src/` reads it, so
 * the assertions below check the table against itself. A review flagged them as
 * self-fulfilling and was right: they can only catch someone editing this
 * fixture inconsistently, never a regression in the product.
 *
 * The table is kept because Units 6 and 11 are judged against these rows and a
 * change to unsigned-launch or cloud-provisioning behaviour has to show up as a
 * change here. It becomes a real test the moment a production module owns the
 * matrix — at which point these should assert against THAT, and this block
 * should be un-skipped.
 *
 * The launch-wiring block below is a genuine test: it reads real files.
 */
describe.skip("desktop product modes (fixture, not behaviour — see note above)", () => {
  test("every mode has a distinct name", () => {
    const names = PRODUCT_MODES.map((mode) => mode.mode)
    expect(names).toEqual([...new Set(names)])
  })

  test("only the unsigned mode runs without an account credential", () => {
    expect(PRODUCT_MODES.filter((mode) => mode.identity === "none").map((mode) => mode.mode)).toEqual([
      "unsigned-local",
    ])
  })

  test("no supported mode places the account credential in the desktop renderer", () => {
    // K6. `browser` identity belongs to cloud-app, never to a desktop mode; a
    // renderer-owned session is exactly the design Unit 6 replaces.
    expect(PRODUCT_MODES.filter((mode) => mode.identity === "browser")).toEqual([])
  })

  test("cloud compute requires identity, and unsigned never provisions a VM", () => {
    for (const mode of PRODUCT_MODES) {
      if (mode.compute !== "cloud-vm") continue
      expect(mode.identity, `${mode.mode} runs on a cloud VM`).not.toBe("none")
    }
    expect(PRODUCT_MODES.some((mode) => mode.identity === "none" && mode.compute === "cloud-vm")).toBe(false)
  })

  test("only laptop compute depends on the laptop staying awake", () => {
    for (const mode of PRODUCT_MODES) {
      expect(mode.requiresLaptop, `${mode.mode}`).toBe(mode.compute === "laptop")
    }
  })

  test("only the linked-host mode starts Host Connector", () => {
    expect(
      PRODUCT_MODES.filter((mode) => mode.extraProcesses.includes("host-connector")).map((mode) => mode.mode),
    ).toEqual(["linked-host"])
  })

  test("remote clients reach a workspace only in linked-host or cloud mode", () => {
    for (const mode of PRODUCT_MODES) {
      const remote = mode.reachableFrom.filter((client) => client !== "this-desktop")
      const expectRemote = mode.mode === "linked-host" || mode.mode === "signed-cloud"
      expect(remote.length > 0, `${mode.mode}`).toBe(expectRemote)
    }
  })
})

describe("desktop server launch wiring", () => {
  test("the server child imports the declared server entry", () => {
    // Anchored to an `import` statement, not a bare substring: this file's own
    // doc comment names the package, and a guard that a comment can satisfy is
    // how several checks on this branch stayed green through a real move.
    expect(read("scripts/claxedo-server-entry.ts")).toMatch(
      new RegExp(`^import [^\\n]* from "${DESKTOP_SERVER_ENTRY}"$`, "m"),
    )
  })

  test("development and production preparation resolve the same server package", () => {
    // This used to check that each script CONTAINED the string
    // "../claxedo-local-server". Both did — and in `prebuild.ts` the only thing
    // that did was a `const` nothing read, left behind when the bundle helper
    // took over the path. The assertion was green against dead code.
    //
    // Now both scripts import one resolver and the assertion is about the
    // resolved value, which is what the bundler actually consumes.
    for (const script of ["scripts/predev.ts", "scripts/prebuild.ts"]) {
      // Comments dropped line-wise: both scripts talk about
      // `@claxedo/local-server` in prose, and a guard a comment can satisfy is
      // precisely what let the dead `const` above survive.
      const code = read(script)
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
        .join("\n")
      expect(code, script).toContain(`from "./local-server"`)
      // Each one GATES on the resolution, rather than merely importing the
      // module for a path constant.
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

  test("the renderer boots through the app package entry, not a source-relative path", () => {
    // Unit 11 swaps this for the local app entry. Keeping it a package
    // specifier is what lets the boundary guards see the edge at all.
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
    // Another call site, not a type, and the one that already shipped broken.
    // `/api/claxedo/remote-access/*` moved from the sidecar to the Host
    // Connector; `@claxedo/local-server` serves none of those paths, so without
    // this line "Enable remote access" posts into a 404 and every suite stays
    // green because nothing was watching the transport.
    const renderer = read("src/renderer/hosted-contributions.ts")

    expect(renderer).toMatch(/^\s*configureDesktopMachineRemoteAccess\(\)$/m)
    // And never the browser one. The desktop binding refuses rather than falls
    // back when the preload exposes no bridge; a root that also bound the HTTP
    // implementation would reintroduce the bug in the shape of resilience.
    expect(renderer).not.toContain("configureHttpMachineRemoteAccess")
  })

  test("declares its server dependency, rather than reaching into a source tree", () => {
    // The asymmetry this contract was written to hold onto, now resolved.
    //
    // Desktop used to compose the renderer through the DECLARED `@claxedo/app`
    // package but reach the server through a source-relative
    // `../../claxedo-server/src/...` import with no manifest edge at all. That
    // is invisible to every dependency audit, survives any amount of
    // package.json tidying, and is exactly how hosted code leaks back into an
    // unsigned desktop build.
    //
    // Both edges are declared now. Unit 12's emitted-artifact gate is what
    // keeps them that way.
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
