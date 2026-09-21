import { describe, expect, test, afterAll, beforeAll } from "bun:test"
import { createRequire } from "node:module"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { runBunBuild } from "../../../script/bun-build"

/**
 * The renderer/daemon boundary against the installed Electron.
 *
 * The policy unit test writes its own `details` objects, so it cannot show that
 * `frame.parent`, `webContentsId` and a `file://` document's `Origin` have the
 * shapes it assumes — and the whole boundary rests on those. This runs the real
 * `grantMainRendererDaemonAccess`, the real caller registry and the real
 * document-trust rule inside Electron, against hidden windows in a temporary
 * `userData` directory, and asserts on what the wire actually carried.
 *
 * There is no skip path. Electron is a declared devDependency of this package,
 * and the two host concessions it needs are provisioned here rather than hoped
 * for: a virtual display on a headless Linux host, and Linux's `--no-sandbox`.
 * If either is unavailable the lane fails naming what is missing.
 */

const HARNESS = path.resolve(import.meta.dir, "electron-boundary/harness.ts")
const MARKER = "CLAXEDO_BOUNDARY_RESULT "

type Seen = { capability: string | null; origin: string | null; method: string }
type ListenerInput = {
  url: string
  hasFrame: boolean
  frameParent: "null" | "undefined" | "frame" | "unreadable"
  webContentsId: number | null
  incomingOrigin: string | null
}
type BoundaryResult = {
  electronVersion: string | null
  chromeVersion: string | null
  platform: string
  chromiumSandbox: boolean
  webPreferences: { sandbox: boolean; webviewTag: boolean }
  capabilityLength: number
  daemonOrigin: string
  trustedDocumentUrl: string
  seen: Record<string, Seen>
  listenerInputs: ListenerInput[]
  externalHits: Array<{ capability: string | null }>
  socketOpened: boolean
  socketFirstMessage: string | null
  capabilityInPageSurfaces: boolean
  pageSurfaceBytes: number
}

function electronBinary(): string {
  const binary: unknown = createRequire(import.meta.url)("electron")
  if (typeof binary !== "string" || !existsSync(binary)) {
    throw new Error("the electron devDependency did not resolve to an executable; run `bun install`")
  }
  return binary
}

/**
 * How this host starts Electron with a window.
 *
 * Two Linux-only concessions, both the ones this package already makes for the
 * same reasons — see `performance-diagnostics-smoke.ts` for the sandbox and the
 * `xvfb-run -a` in `release-gates.yml` for the display:
 *
 *   - `--no-sandbox`, because the Electron npm package cannot ship a
 *     setuid-root `chrome-sandbox`, so Chromium aborts at boot on a runner.
 *     macOS and Windows get no such flag and run fully sandboxed.
 *   - `xvfb-run -a`, because the unit runner is `ubuntu-latest` with no display
 *     and this lane opens real `BrowserWindow`s. A Linux host that already has
 *     one (a developer's desktop) is used as-is.
 *
 * Neither is a fallback: a Linux host with no display and no `xvfb-run` fails
 * here, naming the package, rather than running something weaker.
 */
function electronCommand(harness: string): string[] {
  const electron = [electronBinary(), harness]
  if (process.platform !== "linux") return electron
  const sandboxed = [...electron, "--no-sandbox"]
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return sandboxed
  const xvfb = Bun.spawnSync({ cmd: ["sh", "-c", "command -v xvfb-run"], stdout: "ignore", stderr: "ignore" })
  if (xvfb.exitCode !== 0) {
    throw new Error(
      "this Linux host has no DISPLAY and no xvfb-run: the renderer boundary lane opens real windows. " +
        "Install xvfb (the runners' `xvfb-run -a` provision) or export DISPLAY.",
    )
  }
  return ["xvfb-run", "-a", ...sandboxed]
}

let result: BoundaryResult
/** One directory for everything the run writes, removed after the child exits. */
let root: string

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "claxedo-boundary-"))
  const outdir = path.join(root, "build")
  // Electron runs JavaScript; the harness and the main-process modules it
  // exercises are TypeScript, so they are bundled exactly as the product's own
  // child entries are, with `electron` left to the runtime.
  await runBunBuild("the Electron boundary harness failed to bundle", {
    entrypoints: [HARNESS],
    outdir,
    naming: "harness.js",
    target: "node",
    format: "cjs",
    external: ["electron"],
    sourcemap: "none",
  })

  const spawned = Bun.spawnSync({
    cmd: electronCommand(path.join(outdir, "harness.js")),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...Bun.env,
      CLAXEDO_BOUNDARY_ROOT: root,
      ELECTRON_ENABLE_LOGGING: "0",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    },
    timeout: 120_000,
  })

  const stdout = spawned.stdout.toString()
  const stderr = spawned.stderr.toString()
  const detail = `exit ${String(spawned.exitCode)}\nstdout:\n${stdout.slice(-4000)}\nstderr:\n${stderr.slice(-4000)}`
  // Checked before the marker and independently of it: a harness that printed
  // its result and then crashed on the way out has not measured a clean run,
  // and reading the line anyway would let that pass.
  if (spawned.exitCode !== 0) throw new Error(`the Electron boundary harness exited nonzero (${detail})`)
  const line = stdout.split("\n").find((entry) => entry.startsWith(MARKER))
  if (!line) throw new Error(`the Electron boundary harness reported nothing (${detail})`)
  result = JSON.parse(line.slice(MARKER.length)) as BoundaryResult
}, 300_000)

afterAll(() => {
  // The child is gone by now, so nothing here is still holding `userData` open.
  if (root) rmSync(root, { recursive: true, force: true })
})

describe("the trusted main renderer, in Electron", () => {
  // Only a real Electron main process reports these, so the recorded run cannot
  // be mistaken for a fixture someone wrote.
  test("was produced by the installed Electron, not a fixture", () => {
    expect(result.electronVersion).toMatch(/^\d+\./)
    expect(result.chromeVersion).toMatch(/^\d+\./)
    expect(result.trustedDocumentUrl).toMatch(/^file:\/\/\/.*index\.local\.html$/)
  })

  /**
   * The Chromium sandbox is a different control from what this lane measures —
   * the capability is added by the browser process after the renderer handed the
   * request off, so no page can read it back whether or not its process is
   * sandboxed, and the trust decision reads browser-process state a page cannot
   * set. It is still recorded and required wherever it can be kept, so the flag
   * can never quietly widen from a Linux concession to the default.
   */
  test("kept the Chromium sandbox everywhere it can be kept", () => {
    expect(result.platform).toBe(process.platform)
    expect(result.chromiumSandbox).toBe(process.platform !== "linux")
  })

  /**
   * `webPreferences.sandbox` is the other thing named "sandbox", and it IS part
   * of the claim: a window opened with different preferences is not the window
   * this product opens. Held against `windows.ts` directly so the two cannot
   * drift.
   */
  test("opened windows with the main window's own webPreferences", () => {
    const windows = readFileSync(path.resolve(import.meta.dir, "../src/main/windows.ts"), "utf8")
    const mainWindow = windows.slice(windows.indexOf("webPreferences: {", windows.indexOf("export function createMainWindow")))

    expect(result.webPreferences).toEqual({ sandbox: false, webviewTag: true })
    expect(mainWindow).toContain(`sandbox: ${String(result.webPreferences.sandbox)},`)
    expect(mainWindow).toContain("webviewTag: isBrowserTabEnabled(),")
  })

  test("carries the capability on a real file:// document's HTTP request", () => {
    expect(result.seen.trusted?.capability).toHaveLength(result.capabilityLength)
  })

  test("carries it on a real WebSocket handshake, which opens", () => {
    expect(result.seen["ws:trusted"]?.capability).toHaveLength(result.capabilityLength)
    expect(result.socketOpened).toBe(true)
    // The socket's first frame is the daemon's own view of that handshake.
    expect(JSON.parse(result.socketFirstMessage ?? "null")).toMatchObject({ capability: true })
  })

  /**
   * The reason the repair exists. Chromium has sent both the literal `file://`
   * and the spec-serialized `null` for opaque origins across versions, so what
   * arrives is recorded rather than assumed; what must hold is that nothing
   * opaque reaches the daemon's loopback gate, which parses the value and needs
   * a loopback hostname.
   */
  test("never presents an opaque origin to the daemon", () => {
    // Measured, both halves of the same request: what the handshake arrived
    // with, and what reached the listener socket after the policy ran.
    const handshake = result.listenerInputs.find((entry) => entry.url.startsWith("ws://"))
    expect(["file://", "null"]).toContain(handshake?.incomingOrigin)
    expect(result.seen["ws:trusted"]?.origin).toBe(result.daemonOrigin)

    for (const [label, record] of Object.entries(result.seen)) {
      if (record.origin === null) continue
      expect(`${label} sent ${record.origin}`).not.toMatch(/ (file:\/\/|null)$/)
    }
  })

  test("never exposes the capability to page script", () => {
    expect(result.pageSurfaceBytes).toBeGreaterThan(100)
    expect(result.capabilityInPageSurfaces).toBe(false)
  })
})

describe("callers that are not the main renderer, in Electron", () => {
  test.each([
    ["a subframe of the trusted window", "trusted-iframe"],
    ["a <webview> guest of the trusted window", "trusted-guest"],
    ["an unregistered webContents showing the trusted document", "unregistered"],
    ["the trusted window once it navigated elsewhere", "navigated"],
  ])("%s reaches the daemon with no capability", (_name, key) => {
    expect(result.seen[key]).toBeDefined()
    expect(result.seen[key]?.capability).toBeNull()
  })

  test("an external redirect destination receives none either", () => {
    expect(result.externalHits.length).toBeGreaterThan(0)
    for (const hit of result.externalHits) expect(hit.capability).toBeNull()
  })

  /**
   * Why that holds. Chromium replays the redirected hop through this same
   * listener, still attributed to the trusted frame, so the strip is what
   * removes the capability — a filter scoped to the daemon's own origin would
   * never see the hop and the header would travel on.
   */
  test("the redirected hop re-enters the listener, attributed to the trusted frame", () => {
    const hop = result.listenerInputs.find((entry) => entry.url.includes("/collect"))

    expect(hop).toBeDefined()
    expect(hop?.frameParent).toBe("null")
    expect(result.seen["redirect:trusted"]?.capability).toHaveLength(result.capabilityLength)
  })
})

/**
 * The shapes the policy reads. A change in Electron that renamed or emptied any
 * of these would leave the policy refusing its own renderer, and the unit test
 * could not notice.
 */
describe("what Electron hands the listener", () => {
  test("populates a frame and a webContents id for a file:// document's request", () => {
    const trusted = result.listenerInputs.find((entry) => entry.url.includes("w=trusted"))

    expect(trusted?.hasFrame).toBe(true)
    expect(typeof trusted?.webContentsId).toBe("number")
  })

  test("reports a top frame's parent as absent and a subframe's as a frame", () => {
    const top = result.listenerInputs.find((entry) => entry.url.includes("w=trusted&") || entry.url.endsWith("w=trusted"))
    const sub = result.listenerInputs.find((entry) => entry.url.includes("w=trusted-iframe"))

    // Either spelling of "no parent" satisfies the policy, which reads `!= null`.
    expect(["null", "undefined"]).toContain(top?.frameParent)
    expect(sub?.frameParent).toBe("frame")
  })

  /**
   * A guest is a top frame of a webContents of its own, so neither the frame
   * check nor the document check refuses it — the caller registry is the only
   * control that does. That is worth pinning: weaken the registry and the guest
   * becomes the machine's application.
   */
  test("gives a webview guest its own webContents, as a top frame", () => {
    const guest = result.listenerInputs.find((entry) => entry.url.includes("w=trusted-guest") && entry.url.includes("/probe"))
    const host = result.listenerInputs.find((entry) => entry.url.includes("w=trusted-iframe"))

    expect(guest?.frameParent).toBe("null")
    expect(typeof guest?.webContentsId).toBe("number")
    expect(guest?.webContentsId).not.toBe(host?.webContentsId)
  })
})
