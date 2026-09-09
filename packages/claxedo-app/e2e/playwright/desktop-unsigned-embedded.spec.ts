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
import { shutdownPackagedTestDaemon } from "../helpers/desktop-daemon"
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

// `@core` is required: `playwright.config.ts` maps the `core` suite to /@core/,
// and an untagged spec runs in no lane. `@tier-real` carves this out of the
// sharded PR lane via `test:e2e:core:base`'s `--grep-invert` so the desktop
// build cost lands in its own job. `@surface-desktop` selects the surface.
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

  test("Agent Plugins: Marketplace installs real Composio for Claude and Codex", async () => {
    const dir = await makeScratchWorkspace("plugin-marketplace")
    const codexHome = path.join(dir, ".codex-test")
    packaged = await launchPackagedApp({ timeoutMs: BOOT_TIMEOUT, env: { CODEX_HOME: codexHome } })
    const serverBase = new URL(await expectServerReachable(packaged, 45_000)).origin
    const workspaceId = await registerWorkspace(serverBase, dir)
    await openWorkspaceProject(packaged, dir, workspaceId)
    await packaged.page.getByText("Marketplace", { exact: true }).click()
    const search = packaged.page.getByRole("searchbox", { name: "Search plugins" })
    await expect(search).toBeVisible({ timeout: 30_000 })
    await search.fill("composio")
    const card = packaged.page.locator("[data-agent-plugin-card]").filter({ hasText: /composio/i })
    await expect(card).toHaveCount(1, { timeout: 45_000 })
    await card.locator("[data-directory-card-open]").click()
    const detail = packaged.page.locator('[data-component="agent-plugin-detail"]')
    await expect(detail).toContainText(/composio/i)
    await expect(detail).toContainText(/MCP/i)
    const catalogResponse = await fetch(`${serverBase}/api/claxedo/plugins`)
    expect(catalogResponse.ok).toBe(true)
    type Candidate = { pluginInstanceId: string; manifest: { name: string } | null; mcpServers: unknown[]; retainedDigest: string | null; harnesses: Record<string, { effective: { effective: boolean } }> }
    const catalog = await catalogResponse.json() as { candidates: Candidate[] }
    const composio = catalog.candidates.find((candidate) => candidate.manifest?.name.toLowerCase() === "composio")
    expect(composio?.mcpServers.length).toBeGreaterThan(0)
    await packaged.page.screenshot({ path: test.info().outputPath("composio-marketplace.png") })
    await expect(detail).toContainText("Authentication is handled by the selected harness")
    await detail.getByRole("button", { name: "Add", exact: true }).click()
    const install = packaged.page.getByRole("dialog")
    for (const harness of ["opencode", "cursor"]) await install.getByRole("checkbox", { name: harness, exact: true }).uncheck()
    for (const harness of ["claude", "codex"]) await expect(install.getByRole("checkbox", { name: harness, exact: true })).toBeChecked()
    await install.getByRole("button", { name: "Add plugin", exact: true }).click()
    await expect(install).not.toBeVisible()
    const read = async () => {
      const response = await fetch(`${serverBase}/api/claxedo/plugins`)
      expect(response.ok).toBe(true)
      return (await response.json() as { candidates: Candidate[] }).candidates.find((candidate) => candidate.pluginInstanceId === composio!.pluginInstanceId)!
    }
    await expect.poll(async () => {
      const plugin = await read()
      return [plugin.harnesses.claude!.effective.effective, plugin.harnesses.codex!.effective.effective,
        plugin.harnesses.cursor!.effective.effective, plugin.harnesses.opencode!.effective.effective]
    }).toEqual([true, true, false, false])
    expect((await read()).retainedDigest).toBeTruthy()
    await expect(fs.readFile(path.join(codexHome, "config.toml"), "utf8")).resolves.toContain("composio")
    await packaged.page.reload()
    // Marketplace is deliberately transient; reopen it to verify durable installation.
    await packaged.page.getByText("Marketplace", { exact: true }).click()
    await search.fill("composio")
    await card.locator("[data-directory-card-open]").click()
    await test.info().attach("composio-after-reload", { body: JSON.stringify(await read(), null, 2), contentType: "application/json" })
    await expect(detail.getByRole("button", { name: "Disable", exact: true })).toBeVisible()
    await packaged.page.screenshot({ path: test.info().outputPath("composio-installed-after-reload.png") })
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

  // Diagnostic only: B1's wire check below is the real coverage of the API
  // base; this fails earlier and names the cause.
  test("A1 (diagnostic): the renderer reaches its server over http(s), not the document origin", async () => {
    packaged = await launchPackagedApp({ timeoutMs: BOOT_TIMEOUT })
    const url = await expectServerReachable(packaged, 45_000)
    expect(url).toMatch(/^https?:\/\//)
  })

  /**
   * `holdClaxedoDaemonLease` (claxedo-desktop's `src/main/server-daemon-lease.ts`)
   * holds the lease for the packaged process's lifetime; only quit, restart and
   * update release it (`daemon-exit-lifecycle.ts`), so backgrounding the window
   * must leave the daemon alone.
   *
   * "Still reachable" could be a replacement daemon or an unarmed grace timer,
   * so the daemon's own state endpoint is read alongside: the shortened grace
   * reached it, a lease is still held, and pid/generation never change.
   *
   * The stimulus is minimize, not blur: a Playwright-launched Electron window
   * is never focused on macOS (`isFocused()` stays false through `focus()`,
   * `show()`, `moveTop()` and `app.focus({steal: true})`), so `blur()` changes
   * nothing. Minimize is a window-state transition this environment does
   * perform, and it is the same class of gesture: leaving the foreground
   * without any exit path.
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
   * `-b main` pins the branch name the project header's "New session in
   * <branch>" aria-label embeds; without it `init.defaultBranch` decides and
   * the selectors below drift across machines.
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
   * Registers `dir` with the same resolve endpoint the app's boot fires; until
   * it resolves, a project seeded into the rail 404s on every session/terminal
   * action. Returns the workspaceId the rail's project group is keyed by.
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
   * Seeds the rail with `dir` and reloads: `storeSet` persists, but the Solid
   * store hydrated once at boot, so only a reload makes the rail re-read it.
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

  // `:visible` is required: the workbench's stashed off-screen pane carries its
  // own textbox with the same aria-label, and `.last()` alone can resolve to it.
  function composerInput(page: Page): Locator {
    return page.locator('[role="textbox"][aria-label*="Ask anything"]:visible').last()
  }

  /**
   * The hover is required: the header's action cluster (`rail-sidebar.tsx`'s
   * `HeaderActions`) mounts on engagement (`rail-hover-engagement.ts`), so the
   * button is absent from the DOM until the pointer reaches the header.
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
    // Match the name slot, not the whole row: a real catalog row renders its
    // description under the name, so `^Sonnet$` over the row text matches nothing.
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

  // The workbench keeps a stashed off-screen pane mounted with its own
  // `[data-action="prompt-submit"]`; `.last()` alone can resolve to the hidden
  // one, so `:visible` is required.
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

  // No URL (MemoryRouter) and no DOM-exposed response id on this surface, so
  // the new session id is learned by diffing the rail's `data-session-id`s.
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
          `GATING: no new rail session row appeared within ${timeoutMs}ms (file:// API base, ` +
            `dropped invalidation, or no event stream). Rows seen: ${JSON.stringify(ids)}. ` +
            `Local inventory: ${JSON.stringify(inventory)}`,
        )
      }
      await page.waitForTimeout(200)
    }
  }

  /**
   * A new terminal's row carries a client-minted `pending-<timestamp>-<rand>`
   * id before the server's `pty_...` id lands, and the pane is keyed by the
   * real id, so both placeholder shapes are excluded. `scope` must be the
   * caller's project group: the default project carries its own connected
   * terminal rows, and a page-wide query returns those too.
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

  // The oracle's `scrollIntoViewIfNeeded()` is not retried against re-renders,
  // and a real harness turn streams enough part-updates to hit "Element is not
  // attached to the DOM", so every call here goes through this one-retry wrapper.
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
        `GATING: no 201 POST .../session reached the wire — ${String(err)}`,
      )
    })

    const sessionId = await waitForNewSessionId(packaged.page, before)
    await expectRailRowVisible({ page: packaged.page, sessionId, index: 0 })

    await expectAssistantReplyVisible(packaged.page, marker1, {
      spec: "desktop-unsigned-embedded",
      scenario: "b2-first-turn",
    })

    // B3: the rail title leaves the create-time placeholder with no reload; a
    // `session.updated` dropped at the runtime bridge leaves it at "New Session".
    const settledTitle = await expectRailTitleSettled({ page: packaged.page, sessionId })
    expect(settledTitle.length, "settled rail title is empty").toBeGreaterThan(0)

    // B4: a second message in the same session; a cache replace that wipes
    // `config.model` gets it refused with "Select an agent and model".
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
      'the second send is refused ("Select an agent and model")',
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

    // Switching to an existing session's pane loads its persisted transcript,
    // which settles slower than a blank draft; this row's own seed reply proves
    // the switch landed without a fixed sleep.
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

    // B6: one row, not a second copy under a workspace-scoped section (a frame
    // carrying `workspaceID` can duplicate it).
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
    // The 5s budget is the assertion: `not.toContainText` retries for the full
    // timeout, so this fails when the control is still on "Loading models".
    await expect(
      control,
      "draft never resolved a concrete model within 5s and no reload was performed",
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
    const env = {
      ...scripted.piEnv,
      ...claudeScriptedEnv(scripted.url, claudeConfigDir),
      // A safety fuse, not the redirect mechanism. Localhost bypasses the
      // proxy; if a future Claude build ignores ANTHROPIC_BASE_URL, external
      // HTTPS fails closed instead of touching the developer's real account.
      HTTPS_PROXY: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost",
      CLAUDE_CODE_EXECUTABLE: guardedClaude.wrapper,
    }
    const launch = (userDataDir?: string) => launchPackagedApp({ timeoutMs: BOOT_TIMEOUT, userDataDir, env })
    packaged = await launch()

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

    const profile = packaged.userDataDir
    await packaged.app.close()
    await shutdownPackagedTestDaemon(profile)
    packaged = await launch(profile)
    expect(new URL(await expectServerReachable(packaged, 45_000)).origin).toBe(serverBase)
    const failureMarker = "C4_CLAUDE_PROVIDER_ERROR"
    const explanation = `Request blocked for ${failureMarker}. Start a new session or choose another model.`
    const releaseError = scripted.scriptError({ marker: failureMarker, status: 400, message: explanation })
    await composeText(packaged.page, composerInput(packaged.page), `Reply with exactly this one token: ${failureMarker}`)
    await submitDraft(packaged.page)
    await expect(packaged.page.getByText(explanation, { exact: false }).first()).toBeVisible({ timeout: 30_000 })
    await packaged.page.reload()
    await expect(packaged.page.getByText(explanation, { exact: false }).first()).toBeVisible()
    releaseError()
    await composeText(packaged.page, composerInput(packaged.page), "Reply with exactly this one token: C4_CLAUDE_RECOVERED")
    await submitDraft(packaged.page)
    await expectAssistantReplyVisible(packaged.page, "C4_CLAUDE_RECOVERED")
    await packaged.page.reload()
    await expectAssistantReplyVisible(packaged.page, "C4_CLAUDE_RECOVERED")

    const originalModel = scripted.requests.filter((request) => request.dialect === "messages" && request.prompt.includes("C4_CLAUDE_RECOVERED")).at(-1)!.model
    const recoveryMarker = "C4_CLAUDE_MODEL_CHANGED"
    const recoveryPrompt = `Preserve this context: café — नमस्ते.\n\nReply with exactly this one token: ${recoveryMarker}`
    const releaseModelError = scripted.scriptError({ marker: recoveryMarker, status: 400, model: originalModel, message: `Model unavailable for ${recoveryMarker}. Choose another model.` })
    try {
      await composeText(packaged.page, composerInput(packaged.page), recoveryPrompt)
      await submitDraft(packaged.page)
      const recovery = packaged.page.getByRole("status").filter({ hasText: `Model unavailable for ${recoveryMarker}` })
      await expect(recovery).toBeVisible({ timeout: 30_000 })
      await packaged.page.reload()
      await recovery.getByRole("button", { name: "Switch model and resend", exact: true }).click()
      const picker = packaged.page.getByRole("dialog")
      await expect(picker).toBeVisible()
      await packaged.page.keyboard.press("Escape")
      await expect(picker).not.toBeVisible()
      expect(scripted.requests.filter((request) => request.prompt.includes(recoveryMarker) && request.reply.kind === "text")).toHaveLength(0)
      await recovery.getByRole("button", { name: "Switch model and resend", exact: true }).click()
      const choice = picker.locator('[data-slot="list-item"]').filter({ hasText: /Haiku/i }).first()
      await expect(choice).toBeVisible()
      await choice.click()
      await expectAssistantReplyVisible(packaged.page, recoveryMarker)
      const successes = scripted.requests.filter((request) => request.dialect === "messages" && request.prompt.includes(recoveryMarker) && request.reply.kind === "text")
      expect(successes.length).toBeGreaterThan(0)
      expect(successes.every((request) => request.model !== originalModel)).toBe(true)
      const history = await fetch(`${serverBase}/session/${sessionId}/message?${new URLSearchParams({ directory: dir, workspaceId })}`)
      expect(history.ok).toBe(true)
      const rows = await history.json() as Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }>
      const prompts = rows.filter((row) => row.info.role === "user").map((row) => row.parts.filter((part) => part.type === "text").map((part) => part.text).join(""))
      expect(prompts.filter((prompt) => prompt === recoveryPrompt)).toEqual([recoveryPrompt, recoveryPrompt])
      await packaged.page.reload()
      await expectAssistantReplyVisible(packaged.page, recoveryMarker)
    } finally { releaseModelError() }
  })

  test("D1/D3: a real terminal streams a live prompt and its row aligns with session rows", async () => {
    const dir = await makeScratchWorkspace("d1-d3")
    // Not the default 3001: `startClaxedoServer` tries `CLAXEDO_SERVER_PORT ??
    // 3001` first, so where 3001 is free a hardcoded-3001 fallback and the real
    // port look identical. A distinctive port makes the `CLAXEDO_PORT`
    // assertion below decisive.
    const started = await launchScriptedApp({ CLAXEDO_SERVER_PORT: "58217" })
    packaged = started.app
    scripted = started.model

    const serverBase = new URL(await expectServerReachable(packaged, 45_000)).origin
    const workspaceId = await registerWorkspace(serverBase, dir)

    // Force xterm's DOM renderer before any terminal opens: the default
    // WebGL/canvas renderer paints pixels `page.locator` cannot read, and the
    // buffer assertions below need `.xterm-rows` text. `claxedo.terminal.renderer`
    // is the shipped escape hatch (`renderer.ts`'s `rendererPreference()`), read
    // from plain `localStorage`, not the electron-store `Persist` system.
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
      "no DOM-rendered terminal content within 10s (file:// Origin rejection, workspaceId used as a path, wrong CLAXEDO_PORT, or no event stream)",
    ).toHaveText(/\S/, { timeout: 10_000 })

    // Polled over the same 10s window rather than sampled once: a reconnect
    // banner can be painted over before a single late sample.
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const text = (await xtermRows.innerText().catch(() => "")) ?? ""
      expect(
        text,
        "terminal buffer shows a Reconnecting banner: the WebSocket Origin (file://) was rejected by the loopback gate",
      ).not.toMatch(/Reconnecting\.\.\. \d\/6/)
      await packaged.page.waitForTimeout(500)
    }

    // Direct proof the terminal's own `CLAXEDO_PORT` mirrors the app's REAL
    // embedded-server port rather than a hardcoded fallback: `provider.tsx`'s
    // `claxedoPort` derives the port from the actual `claxedoServerUrl` instead
    // of ever guessing a constant. `serverBase` above is the SAME url
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
    // The shell must have taken the whole command before Enter: anything already
    // reading the PTY (an rc prompt, a pager) eats the leading characters, and a
    // truncated command fails the port assertion without having asked for the port.
    await expect(
      xtermRows,
      "the shell never echoed the typed command back, so the port assertion below would test nothing",
    ).toContainText(portEchoCommand, { timeout: 10_000 })
    await packaged.page.keyboard.press("Enter")
    await expect(
      xtermRows,
      `terminal's own $CLAXEDO_PORT never echoed the real embedded-server port (${expectedPort})`,
    ).toContainText(`CLAXEDO_PORT_CHECK=${expectedPort}`, { timeout: 10_000 })

    // D3: terminal row geometry matches session rows.
    const beforeSession = await currentSessionIds(packaged.page)
    const input = await openNewDraft(packaged, projectGroup)
    await selectScriptedModel(packaged.page)
    await composeText(packaged.page, input, "Reply with exactly this one token, nothing else: D3_MARK")
    await submitDraft(packaged.page)
    await waitForNewSessionId(packaged.page, beforeSession)
    // `expectRowGeometry` sweeps every terminal/session title on the page with
    // no CSS-visibility filtering, and the default project's collapsed section
    // keeps a `display:none` title whose `boundingBox()` is null. Collapsing
    // every other project's header removes those rows from the DOM (`<Show
    // when={open()}>`). The toggle is `[data-icon-interaction="binary"]`;
    // clicking the header row itself selects the project instead.
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

    // A plain page reload, not a route write, is the user action a `file://`
    // document has to survive.
    await packaged.page.reload()
    await packaged.page.waitForLoadState("domcontentloaded")
    await expect(packaged.page.locator("[data-claxedo]"), "shell never repainted after reload").toBeVisible({
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
