import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

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
 * The second half pins the LAUNCH WIRING. Desktop resolves its server through
 * three separate paths — the child entry module, `predev`, and `prebuild` — and
 * Unit 5 must retarget all three to `@claxedo/local-server` in one slice. Two
 * out of three leaves a repository where development works and the packaged
 * build boots the old composition, or vice versa.
 */

const packageRoot = path.resolve(import.meta.dir, "..")

function read(rel: string) {
  return readFileSync(path.join(packageRoot, rel), "utf8")
}

/**
 * The module the desktop server child imports, relative to the desktop package.
 *
 * Unit 5 changes this to the `@claxedo/local-server` package entry. Everything
 * that resolves a server must agree with it.
 */
const DESKTOP_SERVER_ENTRY = "../../claxedo-server/src/deployments/local/server"

/** The package directory whose sources feed the bundled desktop server. */
const DESKTOP_SERVER_PACKAGE_DIR = "../claxedo-server"

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
    expect(read("scripts/claxedo-server-entry.ts")).toContain(`from "${DESKTOP_SERVER_ENTRY}"`)
  })

  test("development and production preparation resolve the same server package", () => {
    // Both scripts compute the source directory independently. Unit 5 has to
    // change both; asserting them together is what makes a half-move fail.
    expect(read("scripts/predev.ts")).toContain(`"${DESKTOP_SERVER_PACKAGE_DIR}"`)
    expect(read("scripts/prebuild.ts")).toContain(`"${DESKTOP_SERVER_PACKAGE_DIR}"`)
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
    const renderer = read("src/renderer/index.tsx")
    expect(renderer).toMatch(/from "@claxedo\/app(\/[^"]*)?"/)
    expect(renderer).not.toContain("../../claxedo-app/src")
  })

  test("records that the desktop server edge is undeclared today", () => {
    // The finding this contract exists to hold onto: desktop composes the
    // renderer through the DECLARED `@claxedo/app` package, but reaches the
    // server through a source-relative `../../claxedo-server/src/...` import
    // with no manifest edge at all.
    //
    // That asymmetry is why manifest checking alone cannot prove the split.
    // A source-relative reach-through is invisible to every dependency audit,
    // survives any amount of package.json tidying, and is precisely how hosted
    // code would leak back into an unsigned desktop build. Unit 5 replaces it
    // with a declared `@claxedo/local-server` dependency, and Unit 12's
    // emitted-artifact gate is what keeps it replaced.
    const manifest = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })

    expect(declared).toContain("@claxedo/app")
    expect(declared).not.toContain("@claxedo/server")
    expect(declared).not.toContain("@claxedo/local-server")
    expect(read("scripts/claxedo-server-entry.ts")).toContain("../../claxedo-server/src/")
  })
})
