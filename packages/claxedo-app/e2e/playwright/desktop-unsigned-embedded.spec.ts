/**
 * The packaged Electron renderer is a `file://` document, and that one fact is
 * what this lane exists to cover: on `file://` the page's own origin is not a
 * usable API base, `history.pushState` throws, and a WebSocket handshake sends
 * `Origin: file://`, which the server's loopback gate rejects. Every other
 * Playwright lane points a browser at an `http://localhost` dev server, where
 * `window.location.protocol` is `https?:` and that whole class of failure
 * cannot occur.
 *
 * Everything here is what the user runs: the packaged app (asar-packed,
 * `file://` renderer), its own embedded claxedo-server, the real
 * workspace-runtime, a real git worktree. The AI model HTTP endpoint is the
 * only fake permitted in this lane.
 *
 * Coverage sits on server-touching mutations — creating a session, creating a
 * terminal. An assertion like "the shell rendered" stays green through all
 * three failures above.
 */

import { expect, test, type Locator, type Page } from "@playwright/test"
import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { expectNoBootErrors, installBootObserver } from "../helpers/boot-observer"
import { expectServerReachable, launchPackagedApp, type PackagedApp } from "../helpers/electron-app"
import { expectRowGeometry } from "../helpers/geometry-oracle"
import {
  expectRailRowMovesToTop,
  expectRailRowUnique,
  expectRailRowVisible,
  expectRailStatusAbsent,
  expectRailTitleSettled,
  SELECTORS as RAIL_SELECTORS,
} from "../helpers/rail-oracle"
import {
  claudeScriptedEnv,
  startScriptedModelServer,
  type ScriptedModelServer,
} from "../helpers/scripted-model-server"
import { configureScriptedPi } from "../helpers/real-local-server"
import { composeText, selectScriptedModel } from "../helpers/web-signed-relay-harness"
import { expectAssistantReplyVisible as expectAssistantReplyVisibleOracle } from "../helpers/turn-oracle"

const execFileAsync = promisify(execFile)

// The packaged app boots its own embedded server before painting anything, so
// the first window legitimately takes longer than a dev-server page load.
const BOOT_TIMEOUT = 90_000

async function workspacePageDesignSignature(dialog: Locator) {
  return dialog.evaluate(async (element) => {
    // The shared segmented control deliberately animates paint for 120ms. Read
    // its settled design, not an arbitrary interpolation frame after a click.
    await new Promise((resolve) => setTimeout(resolve, 160))
    const read = (selector: string) => {
      const node = element.querySelector<HTMLElement>(selector)
      if (!node) throw new Error(`Missing workspace-page design node: ${selector}`)
      return { node, style: getComputedStyle(node) }
    }
    const probes: HTMLElement[] = []
    if (!element.querySelector(".workspace-data-metric-strip")) {
      const probe = document.createElement("div")
      probe.className = "workspace-data-metric-strip"
      probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none"
      probe.append(document.createElement("div"), document.createElement("div"))
      element.append(probe)
      probes.push(probe)
    }
    if (!element.querySelector(".workspace-data-chart")) {
      const probe = document.createElement("section")
      probe.className = "workspace-data-chart"
      probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none"
      const heading = document.createElement("div")
      heading.className = "workspace-data-heading"
      heading.append(document.createElement("h3"))
      probe.append(heading)
      element.append(probe)
      probes.push(probe)
    }
    const root = getComputedStyle(element)
    const dashboard = read(".workspace-page-dashboard")
    const header = read(".workspace-page-header")
    const title = read(".workspace-page-title h2")
    const segmented = read(".workspace-page-segmented")
    const selected = read('.workspace-page-segmented button:is([aria-pressed="true"], [aria-selected="true"])')
    const refresh = read(".workspace-page-refresh-button")
    const metricStrip = read(".workspace-data-metric-strip")
    const metricCell = read(".workspace-data-metric-strip > div")
    const chart = read(".workspace-data-chart")
    const chartHeading = read(".workspace-data-heading h3")
    const bounds = element.getBoundingClientRect()

    const signature = {
      root: {
        width: bounds.width,
        height: bounds.height,
        background: root.backgroundColor,
        borderRadius: root.borderRadius,
      },
      dashboard: {
        padding: dashboard.style.padding,
        gap: dashboard.style.gap,
        overflow: dashboard.style.overflow,
      },
      header: {
        alignItems: header.style.alignItems,
        justifyContent: header.style.justifyContent,
        gap: header.style.gap,
      },
      title: {
        color: title.style.color,
        fontFamily: title.style.fontFamily,
        fontSize: title.style.fontSize,
        fontWeight: title.style.fontWeight,
        letterSpacing: title.style.letterSpacing,
        lineHeight: title.style.lineHeight,
        margin: title.style.margin,
      },
      segmented: {
        padding: segmented.style.padding,
        border: segmented.style.border,
        borderRadius: segmented.style.borderRadius,
        background: segmented.style.backgroundColor,
      },
      selected: {
        surfaceToken: selected.style.getPropertyValue("--surface-raised-stronger-non-alpha"),
        textToken: selected.style.getPropertyValue("--text-strong"),
        minHeight: selected.style.minHeight,
        padding: selected.style.padding,
        borderRadius: selected.style.borderRadius,
        color: selected.style.color,
        background: selected.style.backgroundColor,
        fontSize: selected.style.fontSize,
        boxShadow: selected.style.boxShadow,
      },
      refresh: {
        minWidth: refresh.style.minWidth,
        minHeight: refresh.style.minHeight,
        padding: refresh.style.padding,
        border: refresh.style.border,
        borderRadius: refresh.style.borderRadius,
        color: refresh.style.color,
      },
      metricStrip: {
        border: metricStrip.style.border,
        borderRadius: metricStrip.style.borderRadius,
        background: metricStrip.style.backgroundColor,
      },
      metricCell: {
        minHeight: metricCell.style.minHeight,
        padding: metricCell.style.padding,
        borderRight: metricCell.style.borderRight,
      },
      chart: {
        padding: chart.style.padding,
        borderWidth: chart.style.borderWidth,
        borderStyle: chart.style.borderStyle,
        background: chart.style.backgroundColor,
      },
      chartHeading: {
        color: chartHeading.style.color,
        fontFamily: chartHeading.style.fontFamily,
        fontSize: chartHeading.style.fontSize,
        fontWeight: chartHeading.style.fontWeight,
        margin: chartHeading.style.margin,
      },
    }
    probes.forEach((probe) => probe.remove())
    return signature
  })
}

// `@core` is REQUIRED, not decorative: `playwright.config.ts`'s suite registry
// maps `core` to /@core/, and a spec carrying no lane tag executes in NO lane
// and nobody notices — the registry's own comment records `a11y-sweep.spec.ts`
// sitting silently unexecuted for exactly that reason. `@tier-real` then carves
// this out of the sharded PR lane via `test:e2e:core:base`'s `--grep-invert`,
// the same way `real-harness-local.spec.ts` is carved out, so the desktop build
// cost lands in its own job. `@surface-desktop` selects the surface.
test.describe("desktop unsigned embedded @core @tier-real @surface-desktop", () => {
  let packaged: PackagedApp | undefined
  let scripted: ScriptedModelServer | undefined
  let claudeConfigDir: string | undefined

  test.afterEach(async () => {
    await packaged?.close()
    packaged = undefined
    await scripted?.close()
    scripted = undefined
    if (claudeConfigDir) await fs.rm(claudeConfigDir, { recursive: true, force: true })
    claudeConfigDir = undefined
  })

  /**
   * A premise guard, not a feature test: a lane that has silently degraded to
   * an http renderer fails here instead of reporting green from every scenario
   * below while testing an application nobody ships. `launchPackagedApp`
   * asserts the protocol internally too; naming it as its own scenario keeps
   * the failure legible in CI output rather than buried in a helper.
   */
  test("the launched app is the packaged one: renderer origin is file://", async () => {
    packaged = await launchPackagedApp({ timeoutMs: BOOT_TIMEOUT })
    const { protocol, isPackaged } = await packaged.page.evaluate(() => ({
      protocol: window.location.protocol,
      isPackaged: !window.location.origin.startsWith("http"),
    }))
    expect(protocol).toBe("file:")
    expect(isPackaged).toBe(true)
  })

  /**
   * A1 — the transport tripwire, DELIBERATELY a diagnostic (see the doctrine
   * note in the file header). Real coverage for defect 1 is B1 in the sibling
   * scenarios; this only fails earlier and names the cause.
   */
  test("A1 (diagnostic): the renderer reaches its server over http(s), not the document origin", async () => {
    packaged = await launchPackagedApp({ timeoutMs: BOOT_TIMEOUT })
    const url = await expectServerReachable(packaged, 45_000)
    expect(url).toMatch(/^https?:\/\//)
  })

  /**
   * The local daemon's lifetime is the packaged PROCESS's, not the window's.
   * `holdClaxedoDaemonLease` (claxedo-desktop's
   * `src/main/server-daemon-lease.ts`) takes one lease during `initialize()`
   * and renews it until the app exits, and the exit paths — quit, restart,
   * update — are what release or hand it off (`daemon-exit-lifecycle.ts`).
   * Backgrounding is none of those, so it must leave the daemon alone.
   *
   * NON-VACUITY — "the daemon is still reachable" is exactly the shape of
   * assertion that passes while the mechanism is dead, so this reads the
   * daemon's OWN lifecycle snapshot (`GET /api/claxedo/daemon/state`, keyed by
   * the discovery token the daemon publishes) alongside it:
   *
   *   - the shortened grace really reached the daemon (1200ms here, 180s in
   *     production), so a background that outlives it several times over is a
   *     real test of the grace rather than of an unarmed timer;
   *   - a lease is still held while backgrounded, i.e. the daemon is up
   *     BECAUSE the main process pins it, not because nothing is watching;
   *   - the pid and generation never change, so a reachable health endpoint
   *     cannot be a replacement daemon that quietly took over.
   *
   * THE STIMULUS IS MINIMIZE, NOT BLUR. A Playwright-launched Electron app is
   * never the frontmost macOS application — measured 2026-09-03 on this
   * packaged binary, `BrowserWindow.getFocusedWindow()` stays `null` and
   * `isFocused()` stays false through `win.focus()`, `win.show()`,
   * `win.moveTop()`, `app.dock.show()` and `app.focus({steal: true})`, in that
   * order. `blur()` on a window that was never focused changes nothing, so a
   * blur-driven version of this test backgrounds nothing and proves nothing.
   * Minimize is a real window-state transition the same environment DOES
   * perform (`isMinimized` true, `isVisible` false, both read back below), and
   * it is the same class of user gesture: the window leaves the foreground
   * without any of the exit paths that own the lease.
   */
  test("the local daemon's lifetime follows the packaged process, not window state", async () => {
    test.setTimeout(90_000)
    packaged = await launchPackagedApp({
      timeoutMs: BOOT_TIMEOUT,
      env: {
        // Production remains 180 seconds. This real-process lane shortens only
        // the daemon-owned grace so a background can outlive it in seconds.
        CLAXEDO_DAEMON_IDLE_GRACE_MS: "1200",
        CLAXEDO_DAEMON_POLL_INTERVAL_MS: "50",
      },
    })
    const serverOrigin = new URL(await expectServerReachable(packaged, 45_000)).origin
    const mainBrowserWindow = await packaged.app.browserWindow(packaged.page)
    const health = () => fetch(new URL("/api/claxedo/health", serverOrigin))
      .then((response) => response.ok)
      .catch(() => false)

    // `electron-app.ts` roots `CLAXEDO_DATA_DIR` at `<userDataDir>/server-data`,
    // and the daemon publishes its port, token, pid and generation there
    // (`claxedo-desktop`'s `server-daemon-discovery.ts`).
    const discoveryFile = path.join(packaged.userDataDir, "server-data", "local-daemon.json")
    type DaemonDiscovery = { token: string; port: number; pid: number; generation: string }
    // The daemon child publishes this file itself, after its listener is up —
    // reachable and published are two different instants in two processes.
    const readDiscovery = async (): Promise<DaemonDiscovery> => {
      const deadline = Date.now() + 15_000
      for (;;) {
        const record = await fs
          .readFile(discoveryFile, "utf8")
          .then((text) => JSON.parse(text) as DaemonDiscovery)
          .catch(() => undefined)
        if (record) return record
        if (Date.now() >= deadline) throw new Error(`the daemon never published ${discoveryFile}`)
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }
    const booted = await readDiscovery()
    const daemonState = async () => {
      const response = await fetch(`http://127.0.0.1:${String(booted.port)}/api/claxedo/daemon/state`, {
        headers: { authorization: `Bearer ${booted.token}` },
      })
      expect(response.ok, "the daemon's own state endpoint refused its published discovery token").toBe(true)
      return await response.json() as { state: string; leases: number; idleGraceMs: number; residencyPins: number }
    }

    const windowState = () => mainBrowserWindow.evaluate((browserWindow) => ({
      visible: browserWindow.isVisible(),
      minimized: browserWindow.isMinimized(),
    }))
    await expect
      .poll(windowState, { message: "the packaged app never showed its window, so nothing can be backgrounded" })
      .toEqual({ visible: true, minimized: false })
    expect(
      (await daemonState()).idleGraceMs,
      "the shortened idle grace never reached the daemon, so a surviving daemon would prove nothing",
    ).toBe(1_200)

    // Background the window for several times the grace.
    await mainBrowserWindow.evaluate((browserWindow) => browserWindow.minimize())
    await expect
      .poll(windowState, { message: "minimize never took, so the app was never backgrounded" })
      .toEqual({ visible: false, minimized: true })
    await packaged.page.waitForTimeout(5_000)
    expect(await health(), "backgrounding the packaged app took its local daemon down").toBe(true)
    const backgrounded = await daemonState()
    expect(
      backgrounded.leases,
      "the Electron main process released its daemon lease while the window was backgrounded",
    ).toBeGreaterThan(0)
    expect(backgrounded.state).toBe("running")

    await mainBrowserWindow.evaluate((browserWindow) => browserWindow.restore())
    await expect
      .poll(windowState, { message: "the window never came back, so the return leg tests nothing" })
      .toEqual({ visible: true, minimized: false })
    await packaged.page.waitForTimeout(2_000)
    expect(await health()).toBe(true)
    expect((await daemonState()).leases).toBeGreaterThan(0)
    const settled = await readDiscovery()
    expect(
      { pid: settled.pid, generation: settled.generation },
      "the daemon was replaced across the background/focus cycle instead of surviving it",
    ).toEqual({ pid: booted.pid, generation: booted.generation })

    await expect.poll(() => packaged!.page.evaluate(async () => {
      const desktopApi = (window as typeof window & {
        api: { awaitInitialization: (onStep: () => void) => Promise<{ url: string }> }
      }).api
      const ready = await desktopApi.awaitInitialization(() => {})
      return fetch(new URL("/api/claxedo/health", ready.url))
        .then((response) => response.ok)
        .catch(() => false)
    }), {
      timeout: 45_000,
      message: "the packaged renderer lost its connection to the daemon across the background/focus cycle",
    }).toBe(true)
  })

  test("Usage opens on the Codex page canvas and every top-level view remains reachable", async () => {
    const dir = await makeScratchWorkspace("usage")
    packaged = await launchPackagedApp({ timeoutMs: BOOT_TIMEOUT })
    const serverBase = new URL(await expectServerReachable(packaged, 45_000)).origin
    const workspaceId = await registerWorkspace(serverBase, dir)
    await openWorkspaceProject(packaged, dir, workspaceId)

    const trigger = packaged.page.getByTestId("rail-account-trigger")
    await expect(trigger).toBeVisible()
    await trigger.click()
    await packaged.page.getByRole("menuitem", { name: "Usage", exact: true }).click()

    const dialog = packaged.page.getByRole("dialog", { name: "Usage" })
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    await expect(dialog).toHaveClass(/workspace-page-dialog/)
    await expect(dialog).toHaveClass(/workspace-page-dialog-shell/)
    const canvas = await dialog.evaluate((element) => {
      const probe = document.createElement("div")
      probe.style.background = "var(--background-base)"
      element.append(probe)
      const expected = getComputedStyle(probe).backgroundColor
      probe.remove()
      const actual = getComputedStyle(element).backgroundColor
      return { actual, expected }
    })
    expect(canvas.actual).toBe(canvas.expected)

    for (const name of ["Usage limits", "Usage through Claxedo", "Total local usage"]) {
      await expect(dialog.getByRole("button", { name })).toBeVisible()
    }
    await dialog.getByRole("button", { name: "Usage limits" }).click()
    await expect(dialog.getByRole("button", { name: "Usage limits" })).toHaveAttribute("aria-pressed", "true")
    await dialog.getByRole("button", { name: "Total local usage" }).click()
    await expect(dialog.getByRole("button", { name: "Total local usage" })).toHaveAttribute("aria-pressed", "true")
    await expect(dialog.getByRole("heading", { name: "By provider" })).toBeVisible({ timeout: 45_000 })
    await dialog.getByRole("button", { name: "Usage through Claxedo" }).click()
    await expect(dialog.getByRole("button", { name: "Usage through Claxedo" })).toHaveAttribute("aria-pressed", "true")
    const usageDesign = await workspacePageDesignSignature(dialog)

    await packaged.page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()

    await trigger.click()
    await packaged.page.getByRole("menuitem", { name: "Diagnostics", exact: true }).click()
    const diagnostics = packaged.page.getByRole("dialog", { name: "This device diagnostics" })
    await expect(diagnostics).toBeVisible({ timeout: 30_000 })
    await expect(diagnostics).toHaveClass(/workspace-page-dialog-shell/)
    await expect(diagnostics.getByRole("button", { name: "Activity" })).toHaveAttribute("aria-pressed", "true")
    await diagnostics.getByRole("button", { name: "Session memory", exact: true }).click()
    await expect(diagnostics.getByRole("button", { name: "Session memory", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    await diagnostics.getByRole("button", { name: "Activity" }).click()
    await expect(diagnostics.locator(".workspace-data-metric-strip")).toBeVisible()
    await expect(diagnostics.locator(".workspace-data-chart")).toBeVisible()
    const diagnosticsTabs = await diagnostics.locator(".claxedo-diagnostics-tabs button").evaluateAll((buttons) =>
      buttons.map((button) => {
        const element = button as HTMLElement
        const bounds = element.getBoundingClientRect()
        return {
          left: bounds.left,
          right: bounds.right,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
        }
      }),
    )
    expect(diagnosticsTabs.every((button) => button.scrollWidth <= button.clientWidth + 1)).toBe(true)
    expect(diagnosticsTabs.slice(1).every((button, index) => diagnosticsTabs[index].right <= button.left)).toBe(true)
    const diagnosticsDesign = await workspacePageDesignSignature(diagnostics)
    expect(diagnosticsDesign).toEqual(usageDesign)

    await packaged.page.keyboard.press("Escape")
    await expect(diagnostics).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })

  /**
   * The "Failed to load sessions for opencode / 404 / 503" toast pair renders
   * and auto-dismisses during boot, which is why nothing else in this file can
   * see it: the other scenarios assert on success-path end state, and a toast
   * that dismisses itself leaves no trace in final DOM state for either a
   * sampled screenshot or an end-state DOM query. `boot-observer.ts` exists
   * for that reason.
   *
   * This fails on the user-observable symptom itself — an error toast actually
   * appearing, or a real non-2xx response — rather than on the absence of a
   * successful signal, so unlike A1 it is coverage and not a diagnostic. It
   * does not replace B1/D1, which cover the create-a-session and
   * create-a-terminal mutations.
   */
  test("boot produces no error-shaped toast and no non-2xx server response", async () => {
    const model = await startScriptedModelServer()
    scripted = model
    packaged = await launchPackagedApp({
      timeoutMs: BOOT_TIMEOUT,
      env: {
        ...model.piEnv,
      },
      // The BrowserContext branch — see boot-observer.ts's doc on why a
      // Page-level install cannot see this app's real boot sequence at all.
      beforeShellWindow: async (context) => {
        await installBootObserver(context)
      },
    })

    // Let boot actually finish before reading the accumulated state: the
    // shell repainting is not the same as the async project-list/session
    // fetches settling, and it's exactly THAT settling window
    // (`bootstrap-orchestrator.ts`'s `fetchQuery` rejection path) that
    // produces the toast this test exists to catch.
    await expect(packaged.page.locator("[data-claxedo]"), "shell never painted during boot").toBeVisible({
      timeout: 30_000,
    })
    await expectServerReachable(packaged, 45_000)
    await packaged.page.waitForTimeout(5_000)

    await expectNoBootErrors(packaged.page)
  })

  // Everything below drives the REAL UI: a real scratch git worktree, a real
  // `POST /api/workspace/resolve`, a real composer send, a real PTY. The
  // scripted model server (scripted-model-server.ts) is the one permitted fake,
  // standing where api.anthropic.com would.
  //
  // These helpers exist instead of `page.goto()` because the packaged renderer
  // runs on Solid Router's `MemoryRouter`: `urlRoutingEnabled()`
  // (`src/lib/runtime-mode.ts`) is false for any `file://` document, so there
  // is nothing for `page.goto()` to navigate TO on this surface. The only real
  // way onto a workspace is the rail's own "recent projects" list, seeded
  // through the app's real persistence bridge (`window.api.storeSet` in
  // `preload/index.ts`, contextBridge-exposed into the SAME main-world context
  // `page.evaluate` runs in) — desktop persists through electron-store via this
  // IPC call, never through `window.localStorage` the way the web lane's
  // `seedOneProject` (`real-harness-local.spec.ts`) can (`persist.ts`'s
  // `isDesktop` branch).
  //
  // A fresh profile boots with ONE project already open: this repository's own
  // checkout, independent of both `--user-data-dir` and the spawn `cwd`.
  // Reusing it would run every session and terminal this file creates against
  // the same working tree other concurrent agents are editing, so every helper
  // below points the app at its own scratch `git init` worktree instead.

  /**
   * A scratch git worktree, isolated per scenario. `-b main` is not
   * decoration: the project header's "New session in <branch>" affordance
   * (`rail-sidebar.tsx`'s `HeaderActions`, `aria-label={New session in ${input.label}}`)
   * embeds the CURRENT branch name, which without an explicit `-b` is
   * whatever `init.defaultBranch` resolves to on the machine running the
   * suite. Pinning it keeps that aria-label — and therefore every selector
   * below that targets it — deterministic across machines/CI images.
   */
  async function makeScratchWorkspace(label: string): Promise<string> {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `claxedo-e2e-desktop-${label}-`)))
    await execFileAsync("git", ["init", "-b", "main"], { cwd: dir })
    await fs.writeFile(path.join(dir, "README.md"), `desktop-unsigned-embedded fixture: ${label}\n`)
    await execFileAsync("git", ["-c", "user.email=e2e@test.com", "-c", "user.name=e2e", "add", "-A"], { cwd: dir })
    await execFileAsync("git", ["-c", "user.email=e2e@test.com", "-c", "user.name=e2e", "commit", "-m", "init"], {
      cwd: dir,
    })
    return dir
  }

  /**
   * Registers `dir` as a real local workspace via the same
   * `GET /api/claxedo/workspace/resolve?directory=...&create=true` the app's own boot
   * fires on first navigation (`real-harness-local.spec.ts`'s
   * `registerWorkspace` uses the identical endpoint for the identical reason):
   * until this resolves, a project seeded into the rail below 404s on every
   * session/terminal action. A real endpoint call against the embedded server
   * this test itself booted, not a mock. Returns the workspaceId the rail's
   * `[data-testid="project-group"][data-project-id]` is keyed by.
   */
  async function registerWorkspace(serverBase: string, dir: string): Promise<string> {
    const url = `${serverBase}/api/claxedo/workspace/resolve?directory=${encodeURIComponent(dir)}&create=true`
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(
        `GATING: failed to register workspace ${dir} via ${url} (${res.status}) — ` +
          (await res.text().catch(() => "<no body>")),
      )
    }
    const json = (await res.json()) as { workspaceId: string }
    return json.workspaceId
  }

  async function installClaudeFixtureCredential(serverBase: string) {
    const response = await fetch(`${serverBase}/api/claxedo/credentials`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider_id: "anthropic",
        kind: "oauth_token",
        source: "managed",
        secret: JSON.stringify({ CLAUDE_CODE_OAUTH_TOKEN: "test-key" }),
        scope: "local",
      }),
    })
    expect(response.status, `failed to install the Claude fixture credential: ${await response.text()}`).toBe(200)
  }

  async function installClaudeNetworkGuard(configDir: string, expectedBaseUrl: string) {
    const discoveredClaude =
      process.platform === "win32"
        ? ((await execFileAsync("where.exe", ["claude.cmd"])).stdout.split(/\r?\n/).find(Boolean)?.trim() ?? "")
        : (await execFileAsync("which", ["claude"])).stdout.trim()
    const realClaude =
      process.platform === "win32"
        ? path.join(path.dirname(discoveredClaude), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
        : discoveredClaude
    expect(realClaude, "the real Claude CLI is required for the native-harness E2E").toBeTruthy()
    await expect(
      fs
        .stat(realClaude)
        .then((stat) => stat.isFile())
        .catch(() => false),
      `the real Claude CLI entry point does not exist at ${realClaude}`,
    ).resolves.toBe(true)
    const capture = path.join(configDir, "spawn-env.jsonl")
    // The SDK recognizes .js as a Node entry point and launches it through
    // process.execPath. It treats .cjs as a native executable; that happens to
    // work via a shebang on POSIX, but fails before execution on Windows.
    const wrapper = path.join(configDir, "claude-e2e-guard.js")
    await fs.writeFile(
      wrapper,
      `#!/usr/bin/env node
const fs = require("node:fs")
const { spawn } = require("node:child_process")
const capture = ${JSON.stringify(capture)}
const expectedBaseUrl = ${JSON.stringify(expectedBaseUrl)}
const snapshot = {
  baseUrl: process.env.ANTHROPIC_BASE_URL,
  apiBaseUrl: process.env.CLAUDE_CODE_API_BASE_URL,
  apiKeyFixture: process.env.ANTHROPIC_API_KEY === "test-key",
  authTokenFixture: process.env.ANTHROPIC_AUTH_TOKEN === "test-key",
  oauthTokenFixture: process.env.CLAUDE_CODE_OAUTH_TOKEN === "test-key",
  adminEnvUnionDisabled: process.env.CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION === "1",
  configDir: process.env.CLAUDE_CONFIG_DIR,
}
fs.appendFileSync(capture, JSON.stringify(snapshot) + "\\n")
if (snapshot.baseUrl !== expectedBaseUrl || snapshot.apiBaseUrl !== expectedBaseUrl || !snapshot.apiKeyFixture || !snapshot.authTokenFixture || !snapshot.oauthTokenFixture || !snapshot.adminEnvUnionDisabled) {
  console.error("GATING: refusing to start Claude with non-fixture endpoint or credentials: " + JSON.stringify(snapshot))
  process.exit(86)
}
const child = spawn(${JSON.stringify(realClaude)}, process.argv.slice(2), { env: process.env, stdio: "inherit" })
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal))
child.on("error", (error) => { console.error(error); process.exit(1) })
child.on("exit", (code, signal) => signal ? process.kill(process.pid, signal) : process.exit(code ?? 1))
`,
      { mode: 0o755 },
    )
    return { wrapper, capture }
  }

  /**
   * Points the rail at `dir` (see the harness-level doc above for why this,
   * not `page.goto`) and returns the project group locator once it renders.
   *
   * MUST reload after seeding: `storeSet` is real IPC and really persists, but
   * the renderer's Solid store already hydrated once at boot, before this
   * call — a reload is the only way the rail re-reads the new blob. That
   * reload is itself exercising real product behaviour (defect 3's fix), not
   * routing around it.
   */
  async function openWorkspaceProject(app: PackagedApp, dir: string, workspaceId: string): Promise<Locator> {
    await app.page.evaluate(async (worktree) => {
      await (window as unknown as { api: { storeSet(n: string, k: string, v: string): Promise<void> } }).api.storeSet(
        "claxedo.global.dat",
        "server",
        JSON.stringify({
          list: [],
          projects: { local: [{ worktree, expanded: true }] },
          lastProject: {},
          workspaceServer: {},
          closedProjects: {},
        }),
      )
    }, dir)
    await app.page.reload()
    await app.page.waitForLoadState("domcontentloaded")
    await expect(
      app.page.locator("[data-claxedo]"),
      "shell did not repaint after the reload that hands the rail its scratch project",
    ).toBeVisible({ timeout: 30_000 })

    const projectGroup = app.page.locator(`[data-testid="project-group"][data-project-id="${workspaceId}"]`)
    await expect(
      projectGroup,
      `project group for workspace "${workspaceId}" (registered via /api/claxedo/workspace/resolve) never rendered in the rail`,
    ).toBeVisible({ timeout: 20_000 })
    return projectGroup
  }

  /**
   * The composer's contenteditable, scoped to `:visible` — same duplicate-DOM
   * hazard as `visibleSubmit` (see its doc): the workbench's stashed off-screen
   * pane carries its OWN `[role="textbox"]` matching this same aria-label, and
   * a plain `getByRole(...).last()` intermittently resolved to it instead of
   * the active one (measured 2026-08-06: `composeText` hung its full 30s retry
   * budget on iteration >0 of a multi-session scenario, clicking a textbox
   * DOM order happened to put last but that was invisible).
   */
  function composerInput(page: Page): Locator {
    return page.locator('[role="textbox"][aria-label*="Ask anything"]:visible').last()
  }

  /**
   * Clicks the project header's "New session in main" affordance and returns
   * the draft composer.
   *
   * The hover is required, not defensive: the header's action cluster
   * (`rail-sidebar.tsx`'s `HeaderActions`) mounts on engagement — hover, focus
   * or an explicit hold, see `rail-hover-engagement.ts` — so the button is
   * absent from the DOM until the pointer reaches the header. Engaging it is
   * the move a real user makes, and the one the web lane's rail specs make
   * (`core-sidebar-tree.spec.ts`, `core-claude-native-sdk-rail.spec.ts`).
   */
  async function openNewDraft(app: PackagedApp, projectGroup: Locator): Promise<Locator> {
    const header = projectGroup.locator('[data-testid="project-header"]')
    await expect(header, "the project header never rendered in the rail").toBeVisible({ timeout: 15_000 })
    await header.hover()
    const newSessionBtn = projectGroup.locator('[aria-label="New session in main"]')
    await expect(
      newSessionBtn,
      'the project header\'s "New session in main" affordance never mounted on hover (rail-sidebar.tsx HeaderActions)',
    ).toBeVisible({ timeout: 15_000 })
    await newSessionBtn.click()
    const input = composerInput(app.page)
    await expect(input, 'draft composer never appeared after "New session in main"').toBeVisible({ timeout: 20_000 })
    return input
  }

  async function selectNativeClaudeHarness(page: Page) {
    const control = page.locator('[data-action="prompt-harness-model"]:visible').last()
    await expect(control).toBeEnabled({ timeout: 20_000 })
    await control.click()
    const picker = page.locator('[data-component="harness-model-picker"]')
    await picker.locator('[data-slot="harness-picker-section"]').first().click()
    // Exactly one picker row is named "Claude": the ACP group lists
    // operator-configured connections, not first-party rows.
    const nativeClaude = picker.getByRole("button", { name: /^Claude$/ }).first()
    await nativeClaude.click()
    // Harness switching is asynchronous, and a stale OpenCode model lingers in
    // the trigger long enough to satisfy the model-ready assertion below — this
    // test can end up on an OpenCode Sonnet while believing it selected native
    // Claude. Reopening Harness and requiring the Native SDK row itself to own
    // selection closes that window.
    await picker.locator('[data-slot="harness-picker-section"]').first().click()
    await expect(nativeClaude, "native Claude never became the selected harness").toHaveAttribute(
      "aria-current",
      "true",
      {
        timeout: 45_000,
      },
    )
    await picker.locator('[data-slot="harness-picker-section"]').nth(1).click()
    await expect(control, "native Claude model catalog never resolved").not.toContainText(
      /Loading models|Select model|^$/,
      { timeout: 45_000 },
    )
    const search = page.getByRole("textbox", { name: /Search models/i }).last()
    await expect(search).toBeVisible({ timeout: 10_000 })
    await search.fill("Sonnet")
    // Match the row's NAME slot, not the row's whole text. A real catalog row
    // renders its harness-supplied description under the name
    // ("Sonnet" + "Sonnet 5 · Efficient for routine tasks"), so a `^Sonnet$`
    // filter over the row text matches nothing here while still matching the
    // Tier M rows — which is why only this lane saw it.
    const model = page
      .locator('[data-component="harness-model-picker"]')
      .locator('[data-slot="list-item"]')
      .filter({ has: page.locator('[data-slot="list-item-name"]', { hasText: /^Sonnet$/ }) })
      .first()
    await expect(model, "the real Claude catalog did not expose an explicit Sonnet model").toBeVisible({
      timeout: 15_000,
    })
    await model.click()
    await expect(control).toContainText(/Sonnet/i, { timeout: 10_000 })
  }

  /**
   * The workbench keeps a STASHED, off-screen content pane mounted for fast
   * tab switching, and that stashed pane carries its OWN
   * `[data-action="prompt-submit"]` — verified 2026-08-06 by enumerating every
   * match: two buttons exist simultaneously, one visible, one
   * `isVisible() === false`. `.last()` (the pattern every other real lane in
   * this repo uses, e.g. `real-harness-local.spec.ts`) resolved to the HIDDEN
   * one here and hung every click for the full retry budget — `:visible` is
   * the fix, not a stylistic preference.
   */
  function visibleSubmit(page: Page): Locator {
    return page.locator('[data-action="prompt-submit"]:visible').last()
  }

  async function submitDraft(page: Page) {
    const submit = visibleSubmit(page)
    await expect(submit, "no visible submit control").toBeVisible({ timeout: 10_000 })
    await expect(submit, "submit stayed disabled — composer never accepted the composed text").toBeEnabled({
      timeout: 10_000,
    })
    await submit.click()
  }

  async function currentSessionIds(page: Page): Promise<string[]> {
    const ids = await page
      .locator(RAIL_SELECTORS.allSessionRows)
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-session-id")))
    return ids.filter((id): id is string => !!id)
  }

  /**
   * B1's row-appears-live assertion needs the session id the app just minted,
   * and there is no other way to learn it on this surface: no URL (see the
   * `MemoryRouter` note above) and no response-body correlation the composer
   * exposes to the DOM. Diffing the rail's own `data-session-id` attributes
   * before/after mirrors the technique `core-terminal.spec.ts`'s
   * `launchFromCreator` uses for PTY ids, adapted to a REAL backend where
   * there is no request-log fixture to poll instead.
   */
  async function waitForNewSessionId(page: Page, before: string[], timeoutMs = 20_000): Promise<string> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const ids = await currentSessionIds(page)
      const found = ids.find((id) => !before.includes(id))
      if (found) return found
      if (Date.now() > deadline) {
        const inventory = await page
          .evaluate(async () => {
            const serverUrl = performance
              .getEntriesByType("resource")
              .map((entry) => entry.name)
              .find((url) => /^https?:/.test(url) && /\/api\/claxedo\//.test(url))
            if (!serverUrl) return { error: "no local-server resource URL was observed" }
            const response = await fetch(new URL("/api/claxedo/session", serverUrl))
            return {
              url: response.url,
              status: response.status,
              body: await response.text(),
            }
          })
          .catch((error) => ({ error: String(error) }))
        throw new Error(
          `GATING: no new rail session row appeared within ${timeoutMs}ms (defects 1/2/7: file:// API base, ` +
            `dropped invalidation, or no event stream). Rows seen: ${JSON.stringify(ids)}. ` +
            `Local inventory: ${JSON.stringify(inventory)}`,
        )
      }
      await page.waitForTimeout(200)
    }
  }

  /**
   * A freshly created terminal's row carries a CLIENT-MINTED
   * `pending-<timestamp>-<rand>` id before the server's real `pty_...` id
   * lands (`terminal-content.tsx`'s doc: "queues a create request ... then
   * replaces the pending id with the real PTY id"). Excluding only the bare
   * `"new"` placeholder (this file's first cut, matching `core-terminal.spec
   * .ts`'s mocked-PTY-API fixture) caught that pending id instead — measured
   * 2026-08-06: `[data-testid="terminal-pane"][data-terminal-id="pending-..."]`
   * never mounts, because the pane is keyed by the REAL id. Both placeholder
   * shapes must be excluded for this to resolve to something a pane locator
   * can ever match.
   */
  /**
   * `scope` MUST be the caller's own `[data-testid="project-group"]`, never
   * the whole page. The app's baked-in default project (this repo's own
   * checkout — see the harness-level doc above) carries its own real,
   * already-connected terminal rows, and a page-wide query returns THEM
   * mixed in with this test's own — measured 2026-08-06: `waitForTerminalId`
   * "found" `pty_a510e0...`, a ghost id from that default project's rail
   * section that simply hadn't rendered into the "before" snapshot yet, and
   * `[data-testid="terminal-pane"][data-terminal-id="pty_a510e0..."]`
   * (that ghost project's own, already-mounted-elsewhere pane) never matched
   * this test's freshly opened one.
   */
  async function waitForNewTerminalId(scope: Locator, before: string[], timeoutMs = 20_000): Promise<string> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const ids = await scope
        .locator('[data-testid="rail-sidebar-terminal-row"]')
        .evaluateAll((els) => els.map((el) => el.getAttribute("data-terminal-id")))
      const found = ids.find(
        (id): id is string => !!id && id !== "new" && !id.startsWith("pending-") && !before.includes(id),
      )
      if (found) return found
      if (Date.now() > deadline) {
        throw new Error(`GATING: no new terminal row appeared within ${timeoutMs}ms. Rows seen: ${JSON.stringify(ids)}`)
      }
      await scope.page().waitForTimeout(200)
    }
  }

  async function launchScriptedApp(
    extraEnv: Record<string, string> = {},
  ): Promise<{ app: PackagedApp; model: ScriptedModelServer }> {
    const model = await startScriptedModelServer()
    const app = await launchPackagedApp({
      timeoutMs: BOOT_TIMEOUT,
      env: {
        ...model.piEnv,
        ...extraEnv,
      },
    })
    await configureScriptedPi(new URL(await expectServerReachable(app, 45_000)).origin)
    return { app, model }
  }

  /**
   * `expectAssistantReplyVisible`'s geometric-truth layer retries
   * `boundingBox()` against re-renders (its own doc: "a live timeline can
   * re-render the row ... a boundingBox taken in that instant is null"), but
   * NOT the `scrollIntoViewIfNeeded()` call immediately before it — measured
   * live 2026-08-06, three separate times, always on a REAL (non-scripted-
   * shortcut) harness turn: `Element is not attached to the DOM`. A real ACP
   * subprocess reply streams in more part-updates than the scripted-only
   * opencode path, so it hits the same DOM-truth-resolved-then-detached race
   * turn-oracle.ts already documents, just more often. This file cannot add
   * retry inside that oracle (not owned here), so every call in this spec
   * goes through this one-retry wrapper instead of the raw import.
   */
  async function expectAssistantReplyVisible(
    page: Parameters<typeof expectAssistantReplyVisibleOracle>[0],
    text: Parameters<typeof expectAssistantReplyVisibleOracle>[1],
    evidence?: Parameters<typeof expectAssistantReplyVisibleOracle>[2],
  ) {
    try {
      return await expectAssistantReplyVisibleOracle(page, text, evidence)
    } catch (err) {
      if (!(err instanceof Error) || !/not attached to the DOM/.test(err.message)) throw err
      return await expectAssistantReplyVisibleOracle(page, text, evidence)
    }
  }

  test.setTimeout(120_000)

  test("B1/B2/B3/B4: a new session's row appears live, completes a turn, auto-titles, and accepts a second message", async () => {
    const dir = await makeScratchWorkspace("b1-b4")
    const started = await launchScriptedApp()
    packaged = started.app
    scripted = started.model

    const serverBase = new URL(await expectServerReachable(packaged, 45_000)).origin
    const workspaceId = await registerWorkspace(serverBase, dir)
    const projectGroup = await openWorkspaceProject(packaged, dir, workspaceId)
    const input = await openNewDraft(packaged, projectGroup)
    await selectScriptedModel(packaged.page)

    const before = await currentSessionIds(packaged.page)
    const marker1 = "B1B2_MARKER"
    await composeText(packaged.page, input, `Reply with exactly this one token, nothing else: ${marker1}`)

    // Registered BEFORE the click so the 201 response cannot race the listener.
    const sessionPostSeen = packaged.page.waitForResponse(
      (res) =>
        res.request().method() === "POST" && new URL(res.url()).pathname.endsWith("/session") && res.status() === 201,
      { timeout: 20_000 },
    )
    await submitDraft(packaged.page)
    await sessionPostSeen.catch((err) => {
      throw new Error(
        `GATING (B1 wire diagnostic, defect 1): never observed a 201 POST .../session on the wire — ${String(err)}`,
      )
    })

    const sessionId = await waitForNewSessionId(packaged.page, before)
    await expectRailRowVisible({ page: packaged.page, sessionId, index: 0 })

    await expectAssistantReplyVisible(packaged.page, marker1, {
      spec: "desktop-unsigned-embedded",
      scenario: "b2-first-turn",
    })

    // B3: the rail title leaves the create-time placeholder with no reload
    // (defect 8: session.updated dropped at the runtime bridge).
    const settledTitle = await expectRailTitleSettled({ page: packaged.page, sessionId })
    expect(settledTitle.length, "settled rail title is empty").toBeGreaterThan(0)

    // B4: a SECOND message in the SAME session (defect 9 / open issue #16:
    // config.model wiped by a wholesale cache replace refused the second send
    // with "Select an agent and model").
    await expect(
      packaged.page.locator('[data-action="prompt-harness-model"]:visible').last(),
      "the existing session can continue but its harness/model label fell back to Select model",
    ).not.toContainText(/Loading models|Select model|^$/, { timeout: 5_000 })
    const marker2 = "B4_MARKER"
    await composeText(
      packaged.page,
      composerInput(packaged.page),
      `Reply with exactly this one token, nothing else: ${marker2}`,
    )
    await expect(
      visibleSubmit(packaged.page),
      'defect 9 / open issue #16: the second send is refused ("Select an agent and model")',
    ).not.toHaveAttribute("aria-label", /select an agent/i)
    await visibleSubmit(packaged.page).click()
    await expectAssistantReplyVisible(packaged.page, marker2, {
      spec: "desktop-unsigned-embedded",
      scenario: "b4-second-turn",
    })

    expect(
      scripted.counts().responses,
      "each rendered turn must correspond to one real Responses request",
    ).toBe(2)
  })

  test("B5/B6: re-prompting an older row bumps it to the top, and its row stays unique", async () => {
    test.setTimeout(150_000)
    const dir = await makeScratchWorkspace("b5-b6")
    const started = await launchScriptedApp()
    packaged = started.app
    scripted = started.model

    const serverBase = new URL(await expectServerReachable(packaged, 45_000)).origin
    const workspaceId = await registerWorkspace(serverBase, dir)
    const projectGroup = await openWorkspaceProject(packaged, dir, workspaceId)

    const sessionIds: string[] = []
    for (let i = 0; i < 4; i++) {
      const before = await currentSessionIds(packaged.page)
      const input = await openNewDraft(packaged, projectGroup)
      await selectScriptedModel(packaged.page)
      const marker = `B5_SEED_${i}`
      await composeText(packaged.page, input, `Reply with exactly this one token, nothing else: ${marker}`)
      await submitDraft(packaged.page)
      const sessionId = await waitForNewSessionId(packaged.page, before)
      await expectAssistantReplyVisible(packaged.page, marker, {
        spec: "desktop-unsigned-embedded",
        scenario: `b5-seed-${i}`,
      })
      sessionIds.push(sessionId)
    }

    // sessionIds[0] is the OLDEST of the four, so the three newer rows outrank
    // it and it now sits at index 3.
    const target = sessionIds[0]
    await expectRailRowVisible({ page: packaged.page, sessionId: target, index: 3 })

    // Re-prompt it: focus its row, then send another message. Switching to an
    // OLDER, already-existing session's pane (as opposed to opening a brand
    // new draft) loads its persisted transcript, which measurably takes
    // longer to settle than a blank draft — a bare click-then-compose here
    // left the composer "not visible" for the FULL 30s actionability retry
    // (measured 2026-08-06), because the workbench was still mid pane-switch.
    // Waiting for THIS row's own seed reply (a marker only its pane can show)
    // is a real, content-addressed proof the switch landed, not a fixed sleep.
    await packaged.page.locator(RAIL_SELECTORS.sessionRow(target)).click()
    await expectAssistantReplyVisible(packaged.page, "B5_SEED_0", {
      spec: "desktop-unsigned-embedded",
      scenario: "b5-reprompt-pane-settled",
    })
    await composeText(
      packaged.page,
      composerInput(packaged.page),
      "Reply with exactly this one token, nothing else: B5_REPROMPT",
    )
    await visibleSubmit(packaged.page).click()

    await expectRailRowMovesToTop({ page: packaged.page, sessionId: target })

    // B6 (open issue #14): exactly one row renders for it, not a second copy
    // under a workspace-scoped section.
    await expectRailRowUnique({ page: packaged.page, sessionId: target })

    await expectAssistantReplyVisible(packaged.page, "B5_REPROMPT", {
      spec: "desktop-unsigned-embedded",
      scenario: "b5-repromt-reply",
    })
  })

  test("B8: reload preserves rail title, order, and status", async () => {
    const dir = await makeScratchWorkspace("b8")
    const started = await launchScriptedApp()
    packaged = started.app
    scripted = started.model

    const serverBase = new URL(await expectServerReachable(packaged, 45_000)).origin
    const workspaceId = await registerWorkspace(serverBase, dir)
    const projectGroup = await openWorkspaceProject(packaged, dir, workspaceId)

    const before = await currentSessionIds(packaged.page)
    const input = await openNewDraft(packaged, projectGroup)
    await selectScriptedModel(packaged.page)
    await composeText(packaged.page, input, "Reply with exactly this one token, nothing else: B8_MARK")
    await submitDraft(packaged.page)
    const sessionId = await waitForNewSessionId(packaged.page, before)
    await expectAssistantReplyVisible(packaged.page, "B8_MARK", {
      spec: "desktop-unsigned-embedded",
      scenario: "b8-seed",
    })
    const titleBefore = await expectRailTitleSettled({ page: packaged.page, sessionId })

    await packaged.page.reload()
    await packaged.page.waitForLoadState("domcontentloaded")
    await expect(packaged.page.locator("[data-claxedo]"), "shell never repainted after reload").toBeVisible({
      timeout: 30_000,
    })

    await expectRailRowVisible({ page: packaged.page, sessionId, index: 0 })
    const titleAfter = await expectRailTitleSettled({ page: packaged.page, sessionId })
    expect(titleAfter, "rail title changed across a reload with no new activity").toBe(titleBefore)
    await expectRailStatusAbsent({ page: packaged.page, sessionId })
  })

  test("C1: a new draft resolves harness/model within 5s with no reload needed", async () => {
    const dir = await makeScratchWorkspace("c1")
    const started = await launchScriptedApp()
    packaged = started.app
    scripted = started.model

    const serverBase = new URL(await expectServerReachable(packaged, 45_000)).origin
    const workspaceId = await registerWorkspace(serverBase, dir)
    const projectGroup = await openWorkspaceProject(packaged, dir, workspaceId)

    const input = await openNewDraft(packaged, projectGroup)
    const control = packaged.page.locator('[data-action="prompt-harness-model"]:visible').last()
    // Open issue #15: draft hangs on "Loading models" until a reload. The
    // 5s budget IS the assertion — `expect(...).not.toContainText` retries
    // for the full timeout, so this fails exactly when the control is still
    // stuck past 5s.
    await expect(
      control,
      "open issue #15: draft never resolved a concrete model past 5s with no reload",
    ).not.toContainText(/Loading models|Select model|^$/, { timeout: 5_000 })

    await composeText(packaged.page, input, "Reply with exactly this one token, nothing else: C1_MARK")
    await expect(
      visibleSubmit(packaged.page),
      "submit never enabled after composing text, with no reload performed",
    ).toBeEnabled({ timeout: 5_000 })
  })

  test("C2/C4: the real Claude native harness keeps its model through a busy first turn, reload, and second turn", async () => {
    const dir = await makeScratchWorkspace("c2-real-claude")
    scripted = await startScriptedModelServer()
    claudeConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-e2e-claude-config-"))
    const guardedClaude = await installClaudeNetworkGuard(claudeConfigDir, scripted.url)
    packaged = await launchPackagedApp({
      timeoutMs: BOOT_TIMEOUT,
      env: {
        ...scripted.piEnv,
        ...claudeScriptedEnv(scripted.url, claudeConfigDir),
        // A safety fuse, not the redirect mechanism. Localhost bypasses the
        // proxy; if a future Claude build ignores ANTHROPIC_BASE_URL, external
        // HTTPS fails closed instead of touching the developer's real account.
        HTTPS_PROXY: "http://127.0.0.1:9",
        HTTP_PROXY: "http://127.0.0.1:9",
        NO_PROXY: "127.0.0.1,localhost",
        CLAUDE_CODE_EXECUTABLE: guardedClaude.wrapper,
      },
    })

    const serverBase = new URL(await expectServerReachable(packaged, 45_000)).origin
    await installClaudeFixtureCredential(serverBase)
    const workspaceId = await registerWorkspace(serverBase, dir)
    const projectGroup = await openWorkspaceProject(packaged, dir, workspaceId)
    const input = await openNewDraft(packaged, projectGroup)
    await selectNativeClaudeHarness(packaged.page)
    const expectGuardedClaudeTraffic = async (message: string) => {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        if (scripted!.counts().messages > 0) return
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      const captured = await fs.readFile(guardedClaude.capture, "utf8").catch(() => "<no guarded Claude spawn>")
      throw new Error(
        `${message}. Scripted counts: ${JSON.stringify(scripted!.counts())}. ` +
          `Guarded spawn environments: ${captured.trim()}. ` +
          `App log tail: ${packaged!.appLog.join("").split("\n").slice(-20).join("\n")}`,
      )
    }
    const control = packaged.page.locator('[data-action="prompt-harness-model"]:visible').last()
    const model = control.locator('[data-slot="composer-control-label"]')
    const modelLabel = (await model.textContent())?.trim()
    expect(modelLabel).toMatch(/Sonnet/i)
    const modelLabelPattern = new RegExp(modelLabel!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")

    scripted.resetCounts()
    scripted.setReplyDelayMs(8_000)
    const before = await currentSessionIds(packaged.page)
    await composeText(packaged.page, input, "Reply with exactly this one token, nothing else: C2_CLAUDE_BUSY")
    await submitDraft(packaged.page)
    const sessionId = await waitForNewSessionId(packaged.page, before)
    const config = await fetch(
      `${serverBase}/session/${encodeURIComponent(sessionId)}/config?${new URLSearchParams({ directory: dir, workspaceId })}`,
    )
    expect(config.status).toBe(200)
    expect(await config.json()).toMatchObject({
      harness: { id: "claude", access: "native" },
      model: { providerID: "claude" },
    })
    await expectGuardedClaudeTraffic(
      "real Claude native harness never reached the redirected Anthropic Messages endpoint",
    )
    const spawnEnvironments = (await fs.readFile(guardedClaude.capture, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(spawnEnvironments.length).toBeGreaterThan(0)
    expect(spawnEnvironments).toEqual(
      spawnEnvironments.map(() => ({
        baseUrl: scripted!.url,
        apiBaseUrl: scripted!.url,
        apiKeyFixture: true,
        authTokenFixture: true,
        oauthTokenFixture: true,
        adminEnvUnionDisabled: true,
        configDir: claudeConfigDir,
      })),
    )
    expect(scripted.counts().chat).toBe(0)
    expect(scripted.counts().responses).toBe(0)
    await expect(packaged.page.locator('[data-action="prompt-submit"]:visible').last()).toHaveAttribute(
      "aria-label",
      /stop/i,
      { timeout: 10_000 },
    )

    await expect(model, "busy draft-to-session handoff cleared the real Claude model").toHaveText(modelLabelPattern, {
      timeout: 1_000,
    })
    await expect(control).not.toContainText(/Loading models|Select model|^$/)
    await expectAssistantReplyVisible(packaged.page, "C2_CLAUDE_BUSY", {
      spec: "desktop-unsigned-embedded",
      scenario: "c2-real-claude",
    })

    scripted.resetCounts()
    scripted.setReplyDelayMs(0)
    await packaged.page.reload()
    await packaged.page.waitForLoadState("domcontentloaded")
    await expectRailRowVisible({ page: packaged.page, sessionId })
    await packaged.page.locator(RAIL_SELECTORS.sessionRow(sessionId)).click()
    await expect(model, "reload replaced the persisted real Claude model").toHaveText(modelLabelPattern, {
      timeout: 10_000,
    })
    await expect(control).not.toContainText(/Loading models|Select model|^$/)
    await control.click()
    const picker = packaged.page.locator('[data-component="harness-model-picker"]')
    await expect(
      picker.locator('[data-slot="harness-picker-section"]').first(),
      "reload replaced the real native Claude harness",
    ).toContainText(/Harness\s*Claude/i)
    await packaged.page.keyboard.press("Escape")

    await composeText(
      packaged.page,
      composerInput(packaged.page),
      "Reply with exactly this one token, nothing else: C4_CLAUDE_RELOAD",
    )
    await submitDraft(packaged.page)
    await expectGuardedClaudeTraffic(
      "the real Claude native harness did not reach the scripted Messages endpoint after reload",
    )
    expect(scripted.counts().chat).toBe(0)
    expect(scripted.counts().responses).toBe(0)
    await expectAssistantReplyVisible(packaged.page, "C4_CLAUDE_RELOAD", {
      spec: "desktop-unsigned-embedded",
      scenario: "c4-real-claude-reload",
    })
  })

  test("D1/D3: a real terminal streams a live prompt and its row aligns with session rows", async () => {
    const dir = await makeScratchWorkspace("d1-d3")
    // Deliberately NOT the default 3001: `main/index.ts`'s `startClaxedoServer`
    // tries `CLAXEDO_SERVER_PORT ?? 3001` first via `getFreePort`, so on a
    // machine where 3001 is free (the common case) the embedded server binds
    // 3001 anyway — which would make the port-fix assertion below pass by
    // COINCIDENCE (a buggy hardcoded-3001 fallback and the real port landing
    // on 3001 look identical) rather than by actually proving the terminal's
    // env reflects the real port. Forcing a distinctive, obviously-non-
    // default port here is what makes that assertion decisive.
    const started = await launchScriptedApp({ CLAXEDO_SERVER_PORT: "58217" })
    packaged = started.app
    scripted = started.model

    const serverBase = new URL(await expectServerReachable(packaged, 45_000)).origin
    const workspaceId = await registerWorkspace(serverBase, dir)

    // Force xterm's DOM renderer BEFORE opening any terminal. The default is
    // a WebGL/canvas renderer (`renderer.ts`'s `loadRenderer`), whose painted
    // pixels `page.locator` cannot read as text at all — a canvas-only lane
    // could never assert "never matches /Reconnecting.../" against real
    // rendered content, only screenshot pixel-diffing, which the plan reserves
    // for E2/nightly. `claxedo.terminal.renderer` is a REAL, shipped escape
    // hatch (`renderer.ts`: "Allow an escape hatch for debugging /
    // problematic GPUs"), read via plain `window.localStorage` — NOT the
    // electron-store-backed `Persist` system (`rendererPreference()` in
    // `renderer.ts` calls `localStorage` directly) — so this is a real
    // user-facing setting, not a test seam. Verified live 2026-08-06: with it
    // set, `.xterm-rows` renders the shell's real prompt text
    // (`<cwd> main ❯ ... <clock>`), readable via Playwright locators.
    await packaged.page.evaluate(() => localStorage.setItem("claxedo.terminal.renderer", "dom"))
    const projectGroup = await openWorkspaceProject(packaged, dir, workspaceId)

    // Navigate INTO the project before touching the terminal toolbar.
    // `rail-sidebar.tsx` gates the whole `[data-testid="project-
    // group"]` row list (terminals AND sessions alike) behind a `<Show
    // when={open()}>`, and `open()` only flips true reactively once
    // `projectMatches(section.project)` does (a `createEffect`, not a
    // `createMemo` off the initial expanded flag) — measured live 2026-08-06:
    // clicking the TOOLBAR "New Terminal" button without ever visiting this
    // project first left `projectGroup.locator('[data-testid="rail-sidebar-
    // terminal-row"]')` returning ZERO rows even after a real PTY was
    // created, because the toolbar's own directory fallback
    // (`sidebarDir() ?? focusedPaneWorkspaceDir()`, this file's header doc)
    // resolved to whichever project WAS active — the app's baked-in default,
    // never this scratch one. `openNewDraft` is what real sessions already
    // use to become "the" active project; it is reused here purely for that
    // side effect, its own draft left uncommitted.
    await openNewDraft(packaged, projectGroup)

    const beforeIds = await projectGroup
      .locator('[data-testid="rail-sidebar-terminal-row"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-terminal-id")).filter((id): id is string => !!id))
    const newTermBtn = packaged.page.locator('[data-testid="workspace-scope-new-terminal"]:visible')
    await expect(newTermBtn, 'the toolbar\'s "New Terminal" affordance never appeared').toBeVisible({ timeout: 15_000 })
    await newTermBtn.first().click()
    const launchers = packaged.page.locator('[data-component="terminal-new-launchers"]:visible')
    await expect(launchers, "the terminal creator's launcher grid never opened").toBeVisible({ timeout: 15_000 })
    const shellTile = launchers.locator('[data-slot="terminal-launcher"][data-launcher-id="shell"]')
    await expect(shellTile, 'the creator\'s "Shell" tile never appeared').toBeVisible({ timeout: 10_000 })
    await shellTile.click()

    const terminalId = await waitForNewTerminalId(projectGroup, beforeIds, 20_000)

    const pane = packaged.page.locator(`[data-testid="terminal-pane"][data-terminal-id="${terminalId}"]`)
    await expect(pane, "terminal pane never mounted").toBeVisible({ timeout: 10_000 })
    const xtermRows = pane.locator(".xterm-rows").first()
    await expect(
      xtermRows,
      "no DOM-rendered terminal content within 10s — see defects 4/5/6/7 (file:// Origin rejection, workspaceId-as-a-path, CLAXEDO_PORT=80, no event stream) / open issue #17 (terminal creation hangs)",
    ).toHaveText(/\S/, { timeout: 10_000 })

    // The never-Reconnecting half is checked over the SAME 10s window, polled
    // repeatedly rather than sampled once — a single late sample could miss a
    // reconnect banner that had already scrolled/painted-over by the time it
    // ran.
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const text = (await xtermRows.innerText().catch(() => "")) ?? ""
      expect(
        text,
        "defect 4: terminal buffer shows a Reconnecting banner — the WebSocket Origin (file://) was rejected by the loopback gate",
      ).not.toMatch(/Reconnecting\.\.\. \d\/6/)
      await packaged.page.waitForTimeout(500)
    }

    // Direct proof the terminal's own `CLAXEDO_PORT` mirrors the app's REAL
    // embedded-server port rather than a hardcoded fallback: `provider.tsx`'s
    // `claxedoPort` derives the port from the actual `claxedoServerUrl` instead
    // of ever guessing a constant. `CLAXEDO_DESKTOP_URL` is NOT the ground truth
    // to compare against — it is an unrelated local MCP-tool bridge
    // (`packages/claxedo-desktop/src/main/browser/setup.ts`) on its own
    // independent port. `serverBase` above is the SAME url
    // `expectServerReachable` already proved live, and its `.port` is what the
    // terminal's own env has to match. Read via a real typed shell command and
    // the DOM-rendered buffer, not a mocked env snapshot.
    const expectedPort = new URL(serverBase).port
    await pane.click()
    const portEchoCommand =
      process.platform === "win32"
        ? "echo CLAXEDO_PORT_CHECK=%CLAXEDO_PORT%"
        : 'echo "CLAXEDO_PORT_CHECK=$CLAXEDO_PORT"'
    await packaged.page.keyboard.type(portEchoCommand, { delay: 15 })
    // The shell must have taken the WHOLE command before it is submitted.
    // Anything already reading this PTY when the keystrokes arrive (a shell rc
    // prompt, a pager) consumes the leading characters, and the truncated
    // command then fails the port assertion below while never having asked for
    // the port at all — see `electron-app.ts`'s ZDOTDIR root for the case that
    // produced this.
    await expect(
      xtermRows,
      "the shell never echoed the typed command back, so the port assertion below would test nothing",
    ).toContainText(portEchoCommand, { timeout: 10_000 })
    await packaged.page.keyboard.press("Enter")
    await expect(
      xtermRows,
      `terminal's own $CLAXEDO_PORT never echoed the real embedded-server port (${expectedPort}) — see this file's ` +
        `defect-6 note and D2's history`,
    ).toContainText(`CLAXEDO_PORT_CHECK=${expectedPort}`, { timeout: 10_000 })

    // D3: terminal row layout matches session rows (defect 11: terminal
    // titles at x=65 vs session titles at x=41; dot orphaned at x=11).
    const beforeSession = await currentSessionIds(packaged.page)
    const input = await openNewDraft(packaged, projectGroup)
    await selectScriptedModel(packaged.page)
    await composeText(packaged.page, input, "Reply with exactly this one token, nothing else: D3_MARK")
    await submitDraft(packaged.page)
    await waitForNewSessionId(packaged.page, beforeSession)
    // `expectRowGeometry` (geometry-oracle.ts, not owned by this file) sweeps
    // EVERY `[data-testid="rail-sidebar-terminal-row"]`/session-title on the
    // PAGE, not scoped to this project — and the app's own baked-in default
    // project (this repo's own checkout; see the harness-level doc above)
    // carries its own "New Terminal" row whose title span can sit in a
    // `<Show>`-collapsed, `display:none` section while the row's OUTER
    // element still matches the selector. Measured live 2026-08-06: the
    // oracle's `boundingBox()` on that ghost row's title returned null and
    // failed with "detached or display:none" — a real fixture-pollution
    // hazard, not a geometry defect. Collapsing every OTHER project's header
    // first removes its rows from the DOM entirely (`rail-sidebar.tsx`'s own
    // `<Show when={open()}>` gate), which is what actually fixes it: a CSS-
    // visibility skip could not, because the oracle deliberately does not do
    // CSS-visibility filtering (that is its whole point, per its own doc).
    // The collapse toggle is `[data-icon-interaction="binary"]` on the
    // project header (`rail-sidebar.tsx`: `aria-label={open() ? "Collapse
    // project" : "Expand project"} aria-expanded={open()}`), not the header
    // row itself — clicking the header row navigates/selects the project
    // instead of collapsing it.
    for (const toggle of await packaged.page
      .locator(
        `[data-testid="project-group"]:not([data-project-id="${workspaceId}"]) [data-icon-interaction="binary"][aria-expanded="true"]`,
      )
      .all()) {
      await toggle.click()
    }
    await expectRowGeometry({ page: packaged.page })
  })

  test("A2: reload mid-session still renders the transcript and completes a further turn", async () => {
    const dir = await makeScratchWorkspace("a2")
    const started = await launchScriptedApp()
    packaged = started.app
    scripted = started.model

    const serverBase = new URL(await expectServerReachable(packaged, 45_000)).origin
    const workspaceId = await registerWorkspace(serverBase, dir)
    const projectGroup = await openWorkspaceProject(packaged, dir, workspaceId)

    const before = await currentSessionIds(packaged.page)
    const input = await openNewDraft(packaged, projectGroup)
    await selectScriptedModel(packaged.page)
    const marker1 = "A2_TURN1"
    await composeText(packaged.page, input, `Reply with exactly this one token, nothing else: ${marker1}`)
    await submitDraft(packaged.page)
    await waitForNewSessionId(packaged.page, before)
    await expectAssistantReplyVisible(packaged.page, marker1, {
      spec: "desktop-unsigned-embedded",
      scenario: "a2-before-reload",
    })

    // Defect 3: `history.pushState` threw on a `file://` document and broke
    // the packaged app outright on reload. A plain page reload (not a route
    // write) is the real user action; this is the load-bearing proof it
    // survives.
    await packaged.page.reload()
    await packaged.page.waitForLoadState("domcontentloaded")
    await expect(packaged.page.locator("[data-claxedo]"), "shell never repainted after reload (defect 3)").toBeVisible({
      timeout: 30_000,
    })

    await expectAssistantReplyVisible(packaged.page, marker1, {
      spec: "desktop-unsigned-embedded",
      scenario: "a2-after-reload-transcript",
    })

    // A reload that merely repaints the OLD transcript is not enough: creating
    // a session is where the packaged-app breakage was actually observable, so
    // the mutation has to keep working post-reload too.
    const marker2 = "A2_TURN2"
    await composeText(
      packaged.page,
      composerInput(packaged.page),
      `Reply with exactly this one token, nothing else: ${marker2}`,
    )
    await visibleSubmit(packaged.page).click()
    await expectAssistantReplyVisible(packaged.page, marker2, {
      spec: "desktop-unsigned-embedded",
      scenario: "a2-after-reload-turn2",
    })
  })
})
