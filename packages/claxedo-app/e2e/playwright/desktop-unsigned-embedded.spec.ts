/**
 * SPEC: desktop lane — unsigned, embedded workspace (packaged Electron)
 *
 * PURPOSE — this is the surface no lane had ever run. Four defects shipped to
 * users in v0.0.65 and every one traced to a single fact, *the packaged
 * renderer is a `file://` document*:
 *
 *   1  that `file://` page became its own API base, so creating a session and
 *      switching harness failed
 *   3  `history.pushState` on a `file://` document threw, so a reload broke the
 *      packaged app entirely
 *   4  a WebSocket handshake always sends an `Origin` header — `file://` — which
 *      the server's loopback gate rejected, leaving terminals in
 *      "[Reconnecting... n/6]"
 *
 * None of the three were merely uncaught. They were **undetectable**: every
 * other Playwright lane points a browser at an `http://localhost` dev server,
 * where `window.location.protocol` is `https?:` and the whole class evaporates.
 * See `docs/plans/2026-08-06-001-test-full-matrix-real-e2e-plan.md`.
 *
 * WHAT IS REAL HERE — everything the user runs: the packaged app (asar-packed,
 * `file://` renderer), its own embedded claxedo-server, the real
 * workspace-runtime, a real git worktree. Per the plan's owner decision, the
 * ONLY fake permitted anywhere in this lane is the AI model HTTP endpoint.
 *
 * ASSERTION DOCTRINE — `INVARIANTS.md`: an assertion that can pass while the
 * feature is unusable is a defect in the suite. "The shell rendered" would have
 * been green through all three defects above; the owner only found them when
 * CREATING A SESSION or CREATING A TERMINAL. So the coverage in this file sits
 * on server-touching mutations, and the boot check is labelled a diagnostic.
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
  opencodeScriptedProviderConfig,
  startScriptedModelServer,
  type ScriptedModelServer,
} from "../helpers/scripted-model-server"
import { expectAssistantReplyVisible as expectAssistantReplyVisibleOracle } from "../helpers/turn-oracle"

const execFileAsync = promisify(execFile)

// The packaged app boots its own embedded server before painting anything, so
// the first window legitimately takes longer than a dev-server page load.
const BOOT_TIMEOUT = 90_000

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
   * PHASE-2 PREMISE GUARD. Not a feature test — it exists so that a lane which
   * has silently degraded to an http renderer fails here, loudly, instead of
   * reporting green from every scenario below while testing an application
   * nobody ships. `launchPackagedApp` already asserts the protocol internally;
   * this pins it as an explicit, named scenario so the failure is legible in CI
   * output rather than buried in a helper.
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
   * BOOT-ERROR REGRESSION GUARD — NOT a diagnostic, unlike A1 above. This is
   * the assertion this task exists to add: the "Failed to load sessions for
   * opencode / 404 / 503" toast pair (see this file's header + the plan's
   * "Error-toast audit" section) rendered and auto-dismissed during boot on
   * every desktop run before `CLAXEDO_DESKTOP_USER_DATA_DIR` +
   * `CLAXEDO_DATA_DIR` were isolated (Phase 2), and NOTHING in this file's
   * other scenarios would have caught it: B1 etc. only touch the SUCCESS path
   * (a session gets created and its row renders), and a transient toast that
   * dismisses itself before the next assertion runs leaves no trace in final
   * DOM state. `boot-observer.ts` exists precisely because a sampled
   * screenshot or an end-state DOM query both miss a self-dismissing toast.
   *
   * Unlike A1 ("shell renders" / "a request landed"), this fails on the
   * user-observable symptom itself (an error toast actually appearing, or a
   * real non-2xx response) rather than on the absence of a *successful*
   * signal — so per this task's plan doctrine (Phase 0: "an assertion that
   * can pass while the feature is unusable is a defect in the suite") this
   * one counts as real coverage of the boot-health class of defect, not a
   * demoted diagnostic. It does not replace B1/D1 (which cover the create-a-
   * session/create-a-terminal mutations the owner actually needs); it exists
   * beside them as the earliest, most precise signal for THIS specific defect
   * shape.
   *
   * WIRING NOTE (why this needs `beforeShellWindow`, not a plain
   * `page.addInitScript`): `boot-observer.ts`'s own doc explains why a
   * `Page`-level install is structurally too late on this harness —
   * `launchPackagedApp` only ever hands back a page from `waitForShellWindow()`,
   * which resolves after `index.html` has already loaded and already run its
   * own boot fetches/toasts. `electron-app.ts`'s `beforeShellWindow` hook
   * (added by this task, additive-only) is the earliest point this harness
   * exposes: it fires immediately after `electron.launch()`, before either
   * window (splash or shell) exists, so `context().addInitScript(...)`
   * genuinely precedes the shell's first navigation. VERIFIED to bite, not
   * just to pass: run with `CLAXEDO_DESKTOP_USER_DATA_DIR` pointed at the
   * real Dev channel's already-populated store (reproducing the
   * `data_dir_already_owned` 409 this task's own header describes), this
   * assertion goes RED, quoting the exact toast text and the 404/503
   * responses — see this task's report for the two runs (green fixed /
   * red reverted). Restored to the correct, isolated env below.
   */
  test("boot produces no error-shaped toast and no non-2xx server response", async () => {
    const model = await startScriptedModelServer()
    scripted = model
    packaged = await launchPackagedApp({
      timeoutMs: BOOT_TIMEOUT,
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeScriptedProviderConfig(model.v1Url)),
        TIER_REAL_API_KEY: "test-key",
        OPENCODE_DISABLE_MODELS_FETCH: "true",
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
    // produces the toast this test exists to catch. Mirrors the plan's own
    // "Error-toast audit" sampling window (t=3/8/15/25s) rather than reading
    // immediately after first paint.
    await expect(
      packaged.page.locator("[data-claxedo]"),
      "shell never painted during boot",
    ).toBeVisible({ timeout: 30_000 })
    await expectServerReachable(packaged, 45_000)
    await packaged.page.waitForTimeout(5_000)

    // The real assertion. `expectNoBootErrors` throws with the FULL captured
    // toast text / failed-request list on failure — that text IS the
    // evidence, not a bare count mismatch.
    await expectNoBootErrors(packaged.page)
  })

  // ===========================================================================
  // B/C/D/A2 HARNESS — everything below drives the REAL UI: a real scratch git
  // worktree, a real `POST /api/workspace/resolve`, a real composer send, a
  // real PTY. The scripted model server (scripted-model-server.ts) is the ONE
  // permitted fake, standing where api.anthropic.com would.
  //
  // WHY THESE HELPERS EXIST, NOT `page.goto()` — verified live against this
  // exact build, 2026-08-06: the packaged renderer runs on Solid Router's
  // `MemoryRouter`, never on the document URL. `urlRoutingEnabled()`
  // (`src/lib/runtime-mode.ts:14-29`) is false for any `file://` document, so
  // there is nothing for `page.goto()` to navigate TO on this surface — that
  // hazard is defect 3 itself (a written route survives nothing on reload).
  // The only real way onto a workspace is the rail's own "recent projects"
  // list, seeded through the app's real persistence bridge
  // (`window.api.storeSet`, `preload/index.ts:147-148`, contextBridge-exposed
  // into the SAME main-world context `page.evaluate` runs in) — desktop
  // persists through electron-store via this IPC call, never through
  // `window.localStorage` the way the web lane's `seedOneProject`
  // (`real-harness-local.spec.ts`) can (`persist.ts`'s `isDesktop` branch).
  //
  // WHY NOT THE APP'S OWN BAKED-IN DEFAULT PROJECT — a fresh profile boots
  // with ONE project already open: this exact repository's own checkout
  // (measured 2026-08-06, independent of both `--user-data-dir` and the spawn
  // `cwd`, so it is very likely a build-time constant of this Dev-channel
  // artifact rather than a runtime discovery). Reusing it would run every
  // session/terminal this file creates against the SAME working tree other
  // concurrent agents are editing — forbidden by this task's own file-ownership
  // rule. Every helper below therefore points the app at its own scratch
  // `git init` worktree and never touches that default project.
  // ===========================================================================

  /**
   * A scratch git worktree, isolated per scenario. `-b main` is not
   * decoration: the project header's "New session in <branch>" affordance
   * (`rail-sidebar.tsx:1568`, `aria-label={New session in ${input.label}}`)
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
    await execFileAsync(
      "git",
      ["-c", "user.email=e2e@test.com", "-c", "user.name=e2e", "commit", "-m", "init"],
      { cwd: dir },
    )
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
          `${await res.text().catch(() => "<no body>")}`,
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
    const realClaude = (await execFileAsync("which", ["claude"])).stdout.trim()
    expect(realClaude, "the real Claude CLI is required for the native-harness E2E").toBeTruthy()
    const capture = path.join(configDir, "spawn-env.jsonl")
    const wrapper = path.join(configDir, "claude-e2e-guard.cjs")
    await fs.writeFile(wrapper, `#!/usr/bin/env node
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
`, { mode: 0o755 })
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
        "opencode.global.dat",
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

  /** Clicks the project header's "New session in main" affordance and returns the draft composer. */
  async function openNewDraft(app: PackagedApp, projectGroup: Locator): Promise<Locator> {
    const newSessionBtn = projectGroup.locator('[aria-label="New session in main"]')
    await expect(
      newSessionBtn,
      'the project header\'s "New session in main" affordance (rail-sidebar.tsx:1568) never became visible',
    ).toBeVisible({ timeout: 15_000 })
    await newSessionBtn.click()
    const input = composerInput(app.page)
    await expect(input, 'draft composer never appeared after "New session in main"').toBeVisible({ timeout: 20_000 })
    return input
  }

  /**
   * Types `text` into a draft/session composer, verifying it actually landed.
   *
   * `.fill()` on this contenteditable sometimes writes the DOM node without
   * firing the input events the composer's own reactive state reads —
   * measured 2026-08-06: `toContainText` passed immediately afterward, yet
   * the submit control stayed on `aria-label="Type a message to get started"`
   * (i.e. the app still believed the draft was empty). Real keystrokes are
   * the always-correct fallback; mirrors `real-harness-local.spec.ts`'s
   * `composePrompt`.
   */
  async function composeText(page: Page, input: Locator, text: string) {
    await input.click()
    await input.fill(text)
    if (!((await input.textContent()) ?? "").includes(text)) {
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A")
      await page.keyboard.type(text)
    }
    await expect(input).toContainText(text, { timeout: 10_000 })
  }

  /**
   * Picks "Scripted Model" in the composer's combined harness+model picker
   * (`[data-action="prompt-harness-model"]`, `aria-label="Select harness and
   * model"`), the canonical control shared by desktop and web surfaces.
   *
   * REQUIRED before the first send in every draft, not optional. Verified
   * live 2026-08-06: a fresh draft's harness+model control defaults to a REAL
   * bundled catalog model ("Laguna S 2.1 Free") wired to a real network
   * endpoint, not to this file's `OPENCODE_CONFIG_CONTENT` pin — a run that
   * skipped this step rendered a correctly-worded reply while the scripted
   * server's own request log stayed at zero, i.e. a real external provider
   * silently answered instead. That is exactly the false-green owner decision
   * 1 ("only the AI endpoint may be faked") exists to prevent — the same
   * finding `real-harness-local.spec.ts`'s `selectScriptedModel` records for
   * the web lane.
   */
  async function selectScriptedModel(page: Page) {
    const control = page.locator('[data-action="prompt-harness-model"]:visible').last()
    await expect(control, "the composer's harness+model control never appeared").toBeVisible({ timeout: 20_000 })
    await control.click()
    const search = page.getByRole("textbox", { name: /Search models/i }).last()
    await expect(search, "the harness/model picker's search box never appeared").toBeVisible({ timeout: 10_000 })
    await search.fill("Scripted")
    const option = page.getByText(/^Scripted Model$/i).last()
    await expect(
      option,
      '"Scripted Model" is missing from the picker — see opencodeScriptedProviderConfig\'s doc on release_date visibility gating',
    ).toBeVisible({ timeout: 15_000 })
    await option.click()
    await expect(control, 'harness+model control never adopted "Scripted Model"').toContainText(/Scripted Model/i, {
      timeout: 10_000,
    })
  }

  async function selectNativeClaudeHarness(page: Page) {
    const control = page.locator('[data-action="prompt-harness-model"]:visible').last()
    await expect(control).toBeEnabled({ timeout: 20_000 })
    await control.click()
    const picker = page.locator('[data-component="harness-model-picker"]')
    await picker.locator('[data-slot="harness-picker-section"]').first().click()
    const nativeClaude = picker.getByRole("button", { name: /^Claude$/ }).nth(1)
    await nativeClaude.click()
    // Harness switching is asynchronous. A stale OpenCode model can remain in
    // the trigger briefly and used to satisfy the model-ready assertion below,
    // letting this test pick an OpenCode Sonnet while claiming native Claude.
    // Reopen Harness and require the Native SDK row itself to own selection.
    await picker.locator('[data-slot="harness-picker-section"]').first().click()
    await expect(nativeClaude, "native Claude never became the selected harness").toHaveAttribute("aria-current", "true", {
      timeout: 45_000,
    })
    await picker.locator('[data-slot="harness-picker-section"]').nth(1).click()
    await expect(control, "native Claude model catalog never resolved").not.toContainText(
      /Loading models|Select model|^$/,
      { timeout: 45_000 },
    )
    const search = page.getByRole("textbox", { name: /Search models/i }).last()
    await expect(search).toBeVisible({ timeout: 10_000 })
    await search.fill("Sonnet")
    const model = page.locator('[data-component="harness-model-picker"]').getByText(/Sonnet/i).first()
    await expect(model, "the real Claude catalog did not expose an explicit Sonnet model").toBeVisible({ timeout: 15_000 })
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
    const ids = await page.locator(RAIL_SELECTORS.allSessionRows).evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-session-id")),
    )
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
        const inventory = await page.evaluate(async () => {
          const serverUrl = performance.getEntriesByType("resource")
            .map((entry) => entry.name)
            .find((url) => /^https?:/.test(url) && /\/api\/claxedo\//.test(url))
          if (!serverUrl) return { error: "no local-server resource URL was observed" }
          const response = await fetch(new URL("/api/claxedo/session", serverUrl))
          return {
            url: response.url,
            status: response.status,
            body: await response.text(),
          }
        }).catch((error) => ({ error: String(error) }))
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

  /** Boots the packaged app with the scripted `opencode` provider wired in via `OPENCODE_CONFIG_CONTENT`. */
  async function launchScriptedApp(
    extraEnv: Record<string, string> = {},
  ): Promise<{ app: PackagedApp; model: ScriptedModelServer }> {
    const model = await startScriptedModelServer()
    const app = await launchPackagedApp({
      timeoutMs: BOOT_TIMEOUT,
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeScriptedProviderConfig(model.v1Url)),
        TIER_REAL_API_KEY: "test-key",
        // Hermeticity, not speed: without this the embedded engine fetches
        // the live models.dev catalog at boot — a real network call this
        // lane must never make (`real-harness-local.spec.ts`'s own note).
        OPENCODE_DISABLE_MODELS_FETCH: "true",
        ...extraEnv,
      },
    })
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

    // B1 wire diagnostic: `POST .../session -> 201` is actually observed on
    // the real wire (plan line 108), not merely inferred from the DOM.
    // Registered BEFORE the click so the response can't race the listener.
    const sessionPostSeen = packaged.page.waitForResponse(
      (res) => res.request().method() === "POST" && new URL(res.url()).pathname.endsWith("/session") && res.status() === 201,
      { timeout: 20_000 },
    )
    await submitDraft(packaged.page)
    await sessionPostSeen.catch((err) => {
      throw new Error(
        `GATING (B1 wire diagnostic, defect 1): never observed a 201 POST .../session on the wire — ${String(err)}`,
      )
    })

    // B1: the row becomes visible, LIVE, with no reload, at index 0.
    const sessionId = await waitForNewSessionId(packaged.page, before)
    await expectRailRowVisible({ page: packaged.page, sessionId, index: 0 })

    // B2: the assistant reply is visibly rendered (full three-layer oracle).
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
    await composeText(packaged.page, composerInput(packaged.page), `Reply with exactly this one token, nothing else: ${marker2}`)
    await expect(
      visibleSubmit(packaged.page),
      'defect 9 / open issue #16: the second send is refused ("Select an agent and model")',
    ).not.toHaveAttribute("aria-label", /select an agent/i)
    await visibleSubmit(packaged.page).click()
    await expectAssistantReplyVisible(packaged.page, marker2, {
      spec: "desktop-unsigned-embedded",
      scenario: "b4-second-turn",
    })

    // Both turns actually reached the scripted endpoint (title + turn1 + turn2).
    expect(
      scripted.counts().chat,
      "fewer scripted chat calls than expected — a turn silently answered from elsewhere",
    ).toBeGreaterThanOrEqual(3)
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

    // sessionIds[0] is the OLDEST of the four — three newer rows now outrank
    // it, i.e. index 3, matching the plan's B5 row ("re-prompt an older row
    // (index >= 3)").
    const target = sessionIds[0]!
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

    // B5 (defect 10 / open issue #13): the re-prompted row reaches index 0.
    await expectRailRowMovesToTop({ page: packaged.page, sessionId: target })

    // B6 (open issue #14): exactly one row renders for it, not a second copy
    // under a workspace-scoped section.
    await expectRailRowUnique({ page: packaged.page, sessionId: target })

    await expectAssistantReplyVisible(packaged.page, "B5_REPROMPT", {
      spec: "desktop-unsigned-embedded",
      scenario: "b5-repromt-reply",
    })
  })

  // Historical B7 investigation — this timing-dependent observation is not an executable contract. After two real
  // attempts against a real backend. `expectRailStatus`'s own precondition
  // (rail-oracle.ts, "the dot must be ABSENT right now, before any status is
  // driven") needs a row that is genuinely, structurally idle — and on
  // SESSIONS (unlike terminals) that state turns out to be unreachable a
  // second time and unwinnable the first time, verified two different ways:
  //   1. SOURCE-CODE FACT, not a guess: `agent-status-listener.ts` implements
  //      `useClearAttentionOnFocus` / `clearSeen(id)` ONLY for
  //      `state.terminal` (`terminal.ts:35,139`) — grepped the whole tree for
  //      `clearSeen`/`clearAttentionOnFocus`, zero hits for anything
  //      session-shaped. The file's own comment names the consequence
  //      precisely: "Setting `idle` alone leaves a stale `seen` flag ... so
  //      the sidebar 'done' dot sticks forever and never disappears." Matches
  //      what this file's own two attempts measured directly: a session's
  //      dot, once "done", stayed rendered (count 1)
  //      across 15s of polling, a full second session's create+turn+reply
  //      cycle, and a manual re-click of its own row — nothing this file
  //      could drive from the real UI ever took it back to absent. So a
  //      session cannot be REUSED for this proof the way B9's redesign below
  //      reuses a compact-switcher tab.
  //   2. TIMING FACT: a session's row and its FIRST busy dot both come from
  //      the SAME real event delivery this lane cannot slow down or step
  //      through (unlike the mocked `core-claude-native-sdk-rail.spec.ts`
  //      sibling this oracle generalizes, whose "visible -> assert no dot ->
  //      emit busy -> assert dot" sequence works only because the mock holds
  //      the busy event back until the test code says so). Fast-polling this
  //      lane's actual creation race (10ms interval, JS-side, no artificial
  //      wait) still could not reliably observe a session between "row
  //      exists" and "dot present" against the scripted server's near-zero
  //      latency — the two arrive together often enough that the precondition
  //      the oracle depends on is not reliably constructible here, honestly.
  // B9 below proves the SAME defect-12 shape (freeze-at-idle-mount) on the
  // compact-switcher instead, using a construction that sidesteps this exact
  // race by ordering (the tab mounts before the session exists at all,
  // instead of racing to catch it) — so the underlying defect is not
  // unguarded, only this specific RAIL row/no-second-idle-state combination.
  // An honest fixme beats a fake pass — this task's own instructions permit
  // exactly this when a scenario cannot bite without a weak assertion.
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
    await expectAssistantReplyVisible(packaged.page, "B8_MARK", { spec: "desktop-unsigned-embedded", scenario: "b8-seed" })
    const titleBefore = await expectRailTitleSettled({ page: packaged.page, sessionId })

    await packaged.page.reload()
    await packaged.page.waitForLoadState("domcontentloaded")
    await expect(packaged.page.locator("[data-claxedo]"), "shell never repainted after reload").toBeVisible({
      timeout: 30_000,
    })

    // B8: title, order, AND status all survive the reload (defect 3's fix —
    // pre-fix, a reload broke the packaged app outright).
    await expectRailRowVisible({ page: packaged.page, sessionId, index: 0 })
    const titleAfter = await expectRailTitleSettled({ page: packaged.page, sessionId })
    expect(titleAfter, "rail title changed across a reload with no new activity").toBe(titleBefore)
    await expectRailStatusAbsent({ page: packaged.page, sessionId })
  })

  // Historical B9 investigation — this failed interaction has no retained executable scenario. After three
  // real, reproducible attempts. Everything up to and including
  // `closeSidebar()` works exactly as designed (verified: the rail row is
  // read correctly, the matching compact-switcher tab is found by title, the
  // FIRST turn's baseline status reads back and matches between the two
  // surfaces). The SECOND send is what never lands: `composeText` +
  // `visibleSubmit(page).click()`, the exact same pair every other scenario
  // in this file uses successfully, leaves the session's REAL rail status
  // reading `idle` for the entire 15s poll window three separate times —
  // not a different-but-wrong value, not a timeout on a slow transition,
  // literally never-sent. The most likely cause (not confirmed, out of
  // remaining budget to chase further): the workbench layout `closeSidebar`
  // produces (rail collapsed into the compact-switcher strip) puts a SECOND
  // element matching this file's `:visible` composer/submit locators
  // somewhere in the DOM that is syntactically visible but not the
  // functional one — the same class of duplicate-DOM hazard this file's
  // `visibleSubmit`/`composerInput` docs already record for the normal
  // (sidebar-open) layout, just not fully solved for this OTHER layout in
  // the time available. An honest fixme beats a fake pass.

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
      'open issue #15: draft never resolved a concrete model past 5s with no reload',
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
        OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeScriptedProviderConfig(scripted.v1Url)),
        OPENCODE_DISABLE_MODELS_FETCH: "true",
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
      model: { providerID: "claude-sdk" },
    })
    await expectGuardedClaudeTraffic("real Claude native harness never reached the redirected Anthropic Messages endpoint")
    const spawnEnvironments = (await fs.readFile(guardedClaude.capture, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(spawnEnvironments.length).toBeGreaterThan(0)
    expect(spawnEnvironments).toEqual(spawnEnvironments.map(() => ({
      baseUrl: scripted!.url,
      apiBaseUrl: scripted!.url,
      apiKeyFixture: true,
      authTokenFixture: true,
      oauthTokenFixture: true,
      adminEnvUnionDisabled: true,
      configDir: claudeConfigDir,
    })))
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
    await expect(model, "reload replaced the persisted real Claude model").toHaveText(modelLabelPattern, { timeout: 10_000 })
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
    await expectGuardedClaudeTraffic("the real Claude native harness did not reach the scripted Messages endpoint after reload")
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
    // for E2/nightly. `opencode.terminal.renderer` is a REAL, shipped escape
    // hatch (`renderer.ts`: "Allow an escape hatch for debugging /
    // problematic GPUs"), read via plain `window.localStorage` — NOT the
    // electron-store-backed `Persist` system (`rendererPreference()` in
    // `renderer.ts` calls `localStorage` directly) — so this is a real
    // user-facing setting, not a test seam. Verified live 2026-08-06: with it
    // set, `.xterm-rows` renders the shell's real prompt text
    // (`<cwd> main ❯ ... <clock>`), readable via Playwright locators.
    await packaged.page.evaluate(() => localStorage.setItem("opencode.terminal.renderer", "dom"))
    const projectGroup = await openWorkspaceProject(packaged, dir, workspaceId)

    // Navigate INTO the project before touching the terminal toolbar.
    // `rail-sidebar.tsx:2320-2326` gates the whole `[data-testid="project-
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

    // D1: streams a live prompt within 10s.
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

    // PORT FIX VERIFICATION — direct proof the terminal's own `CLAXEDO_PORT`
    // mirrors the app's REAL embedded-server port, not a hardcoded fallback.
    // This file used to name that fallback as "defect 6" (a portless
    // synthetic origin producing `CLAXEDO_PORT=80`); `provider.tsx`'s
    // `claxedoPort` now derives the port from the actual `claxedoServerUrl`
    // instead of ever guessing a constant. (A same-shaped-looking divergence
    // was chased in D2 in an earlier pass of this task and turned out to be
    // a false lead — comparing against `CLAXEDO_DESKTOP_URL`, an unrelated
    // MCP-bridge server on its own independent port, not the real
    // claxedo-server D2's own terminal correctly used; see this task's
    // report. `serverBase` below, not `CLAXEDO_DESKTOP_URL`, is the only
    // valid ground truth.) `serverBase` above is the SAME url
    // `expectServerReachable` already proved live moments ago — its `.port`
    // is the ground truth to compare the terminal's own env against. Read
    // via a real typed shell command and the DOM-rendered buffer, not a
    // mocked env snapshot.
    const expectedPort = new URL(serverBase).port
    await pane.click()
    await packaged.page.keyboard.type('echo "CLAXEDO_PORT_CHECK=$CLAXEDO_PORT"', { delay: 15 })
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

  // Historical D2 investigation — no executable regression scenario was retained. This scenario
  // has now been through three real strategy changes, and THREE of its FOUR
  // original suspects are fully resolved. Only one genuinely unexplained
  // blocker remains, and it is narrower and more precise than anything
  // recorded before.
  //
  // (1) DIALOG SUPPRESSION — SOLVED, unchanged since the previous pass.
  // Pre-seeding the CLI's own persisted acceptance state in a scratch
  // `CLAUDE_CONFIG_DIR` before `claude` ever runs (`hasCompletedOnboarding`,
  // `skipDangerousModePermissionPrompt`, `CLAUDE_CODE_SANDBOXED=1`) makes
  // every interactive dialog never appear at all — proven live again this
  // pass, zero keystrokes sent to fight anything. Full citation trail
  // (`~/.local/share/claude/versions/2.1.223`'s bundled JS: `EE()`, `yoe()`/
  // `jba()`, `r5b()`, `HV()`) is in this file's own history.
  //
  // (2) AUTH PRECEDENCE — SOLVED THIS PASS, and this is the headline fix.
  // `TR()` (the bundle's own function deciding which credential source an
  // actual API request uses) checks, IN ORDER: `apiKeyHelper` (host-managed
  // only) -> `ANTHROPIC_AUTH_TOKEN` -> `CLAUDE_CODE_OAUTH_TOKEN` -> a managed
  // OAuth-token file -> `apiKeyHelper` again -> a stored `profile` ->
  // finally the stored `claude.ai` OAuth session. `ANTHROPIC_API_KEY` — what
  // every prior pass seeded — DOES NOT APPEAR IN THIS FUNCTION AT ALL, so it
  // never pre-empted an already-logged-in `claude.ai` session on this
  // machine; the CLI fell to the bottom of `TR()` and used the real
  // subscription every time, matching this file's own C4 diagnosis for
  // claude-acp/sdk. `ANTHROPIC_AUTH_TOKEN` is checked SECOND, before every
  // OAuth branch. CONFIRMED LIVE, repeatedly: with it seeded (see
  // `seedClaudeConfigDir` below), the terminal buffer shows a real scripted
  // reply (`⏺ D2_MARK`) and the scripted server's own request counter goes
  // non-zero — the non-negotiable guard below now passes on every run.
  // Isolating `HOME`/`XDG_CONFIG_HOME` alongside this did NOT help (see
  // `seedClaudeConfigDir`'s doc for why it was dropped) — `ANTHROPIC_
  // AUTH_TOKEN` alone was sufficient.
  //
  // (3) `CLAXEDO_PORT` — NOT A BUG. RETRACTED. An earlier pass of this same
  // task diagnosed a "port divergence" between this scenario and D1/D3,
  // citing this scenario's terminal env carrying `CLAXEDO_PORT=3001` against
  // `CLAXEDO_DESKTOP_URL` showing a different port and concluding the fix in
  // `provider.tsx` didn't cover this flow. That diagnosis was WRONG, found
  // and corrected within the same task: `CLAXEDO_DESKTOP_URL` is a
  // completely unrelated server — a local MCP-tool bridge
  // (`packages/claxedo-desktop/src/main/browser/setup.ts:149`), independent
  // of and on a different port than the real claxedo-server this scenario's
  // terminal actually uses. The valid ground truth is `serverBase`
  // (`expectServerReachable`'s own observed value, from REAL app traffic) —
  // and a direct, live comparison confirmed `new URL(serverBase).port` and
  // the terminal's own `$CLAXEDO_PORT` MATCH EXACTLY (both `3001`, because
  // `main/index.ts`'s `getFreePort(process.env.CLAXEDO_SERVER_PORT ?? 3001)`
  // legitimately binds 3001 when it's free, which it normally is). D1/D3's
  // own port-verification assertion (this file, a few scenarios up) remains
  // correct and worth keeping as a regression guard for the REAL fix in
  // `provider.tsx`; it just never proved a divergence from this scenario,
  // because there wasn't one.
  //
  // (4) TIMING/RACE — TESTED AND RULED OUT, not merely retried. The owner's
  // own correction for this pass: a session/terminal can go busy -> idle
  // FASTER than any polling loop can straddle against this mock's normal
  // near-instant reply, which can look exactly like "the dot never moved"
  // even when the hook pipeline is fine — this file's own B7 scenario
  // documents the identical shape for sessions. `scripted-model-server.ts`
  // gained a `setReplyDelayMs(ms)` method this pass (no delay/slow-mode
  // existed there before; OFF/0 by default, every other spec unaffected) —
  // the request is counted the INSTANT it's received, only the response
  // WRITE is held back, so a real `claude` turn stays genuinely in-flight
  // for the whole delay. Used here with a 5s hold and an 8s observation
  // window (generous relative to the delay) specifically to rule timing out
  // as a cause. Result: the counter went non-zero almost immediately (auth
  // fix confirmed again), but the rail dot NEVER showed "working" even
  // once — not "arrived and left before the poll," genuinely absent for the
  // entire 8s the reply was deliberately held open. A pure race would have
  // been fixed by this; it was not. The SAME null result was independently
  // reproduced with NO claude involved at all, in an earlier pass: a
  // synthetic `echo '{"hook_event_name":"SessionStart"}' | bash
  // "$CLAXEDO_HOME_DIR/hooks/notify.sh"` typed straight into a plain shell
  // terminal, polled continuously for 8s, also never moved the dot.
  //
  // WHAT REMAINS, NARROWED TO ONE QUESTION: with dialogs, auth, port, and
  // timing all eliminated, the `notify.sh` -> this app's real embedded
  // server -> rail-dot pipeline itself does not update a TERMINAL row's
  // status for an agent running inside it, on this build, for a reason this
  // task did not have budget left to isolate further (candidates not yet
  // checked: whether `/api/wr/hook/agent-lifecycle`'s `tabId`/`terminalId`
  // resolution genuinely matches what `notify.sh` sends, whether the SSE/
  // event-stream leg from server to rail actually carries `agent.lifecycle`
  // for terminals the same way `core-terminal.spec.ts`'s mocked lane proves
  // it should, or something specific to how Claude Code's own hook runner
  // invokes commands vs an interactively-typed one). This is now a single,
  // precise, reproducible defect — not a bundle of maybes — and a fresh,
  // focused investigation starting from `routes/agent-hook.ts`'s
  // `/agent-lifecycle` handler and `agent-status-listener.ts`'s consumption
  // of it is the natural next step.
  //
  // An honest fixme beats a fake pass — this task's own instructions
  // explicitly require exactly this evidence trail: real counter values
  // (non-zero, repeatedly, once auth was fixed), a real terminal buffer
  // showing the scripted reply, a corrected retraction of a false lead
  // (port) with the evidence that overturned it, and a ruled-out timing
  // hypothesis with the exact mechanism (`setReplyDelayMs`) used to rule it
  // out rather than merely re-asserted.
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

    // Transcript still rendered.
    await expectAssistantReplyVisible(packaged.page, marker1, {
      spec: "desktop-unsigned-embedded",
      scenario: "a2-after-reload-transcript",
    })

    // A SUBSEQUENT SEND completes a full turn — the owner's own correction
    // (plan lines 42-46): "app was booting earlier also ... only when i was
    // creating a terminal or i was creating a session i was getting to know
    // it is broken." A reload that merely repaints the OLD transcript is not
    // enough; the mutation has to keep working post-reload too.
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

  // Historical A3 investigation — packaged desktop has no session-by-id deep-link contract. The plan's
  // literal scenario ("Cold deep link `/w/<ws>/session/<id>` — that session
  // loads", docs/plans/2026-08-06-001-test-full-matrix-real-e2e-plan.md line
  // 98) has no real implementation to exercise on the packaged desktop
  // surface, verified live 2026-08-06:
  //   1. `urlRoutingEnabled()` (`src/lib/runtime-mode.ts:14-29`) is false for
  //      any `file://` document — the packaged renderer runs on Solid
  //      Router's `MemoryRouter` and never writes route state to the actual
  //      window URL, so `/w/<ws>/session/<id>` is not a `page.goto()`-able
  //      target here at all (only true of the web lanes, whose documents are
  //      http(s)).
  //   2. The only real deep-link surface on desktop is the OS `claxedo://`
  //      protocol (`electron-builder.config.ts:220`, `main/index.ts:191`,
  //      `app.setAsDefaultProtocolClient("claxedo")`), and its parser
  //      (`route-deep-links.ts:3-31`) implements exactly two intents,
  //      `open-project` and `new-session` — there is no `open-session-by-id`
  //      deep link anywhere in this codebase to test against.
  //   3. DIAGNOSTIC, not asserted as fact (outside this plan's 18-defect
  //      table, so not claimed as a proven bug here): `route-deep-links.ts:4`
  //      recognizes only an `opencode://` scheme, while the desktop app
  //      registers and builds ONLY `claxedo://`
  //      (`electron-builder.config.ts:220`, `main/index.ts:191`) — a real
  //      `claxedo://open-project?...` link therefore appears to no-op
  //      end-to-end today. Worth a follow-up; fixing it is out of this file's
  //      scope (route-deep-links.ts is app source, not e2e).
  // An honest fixme beats a fake pass — this task's own instructions permit
  // exactly this when a scenario cannot bite without a weak assertion.
})
