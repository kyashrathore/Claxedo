/**
 * SPEC: Cold boot, deep links, Home, and shell resilience
 *
 * PURPOSE — the entry points to the whole app: a fresh browser, a bookmarked/typed
 * session URL, a reload with corrupted local state, a session the server no longer
 * has, or a server that is momentarily unreachable. This spec owns the contract that
 * the shell always lands the user somewhere correct and never dies on bad input —
 * every other spec assumes boot already works.
 *
 * STATE MODEL —
 *   - Workbench/pane state (open tabs, split layout, focused pane) lives in ONE raw
 *     `localStorage["claxedo.state.v5"]` key (`STORAGE_KEY_V5`,
 *     `src/claxedo-ui/state/provider.tsx`), loaded once per app mount by
 *     `loadInitialState()` and passed through `validate()`
 *     (`src/claxedo-ui/state/persistence.ts`). `validate()` never throws: it drops
 *     unparseable JSON (`emptyClaxedoState()`), and for parseable-but-malformed JSON it
 *     repairs every slice field-by-field against defaults (dangling meta ids, panes
 *     pointing at deleted content, non-array `panes`, etc. are all dropped/backfilled).
 *   - `initialStateForPath()` (same file) additionally WIPES `workbench`, `meta`,
 *     `terminal`, `workspacePanel`, and `processPane` back to empty on every fresh boot
 *     whose URL "owns" an initial surface (`routeOwnsInitialSurface`: `/s/:id`,
 *     `/w/:id/session[/:id]`, `/w/:id/page/:id`, `/w/:id/terminal/:id`, or a legacy
 *     `/:dir` route carrying a session/page/terminal id) — so whatever was open in a
 *     previous tab/session is discarded and only the URL's own route-intent
 *     repopulates the workbench. Project/model prefs (`claxedo.global.dat:server`,
 *     `:model`) are separate keys and are NOT touched by this wipe.
 *   - Route → pane resolution: `parseShellRoute` (`src/shell/identity/route.ts`)
 *     classifies the pathname; `createRouteIntentAdapter.receive()`
 *     (`src/claxedo-ui/state/route-intent.ts`) turns that into
 *     `state.layout.openSession(...)` / `openCentralSession(...)` calls. For LOCAL
 *     projects the `/w/:workspaceId/...` form carries only the opaque project or
 *     workspace ID; project inventory resolves that ID to the runtime directory.
 *     The bare `/s/:sessionId` form has no workspaceId and must resolve through the
 *     session inventory (workspace match, else a `central` fallback via
 *     `openCentralSession`). After a first send, `src/session/submit/handoff.ts`
 *     navigates to `workspaceSessionRoute(workspaceId, id)` (or `sessionRoute(id)` only
 *     for sessions whose `sessionRef.host === "central"`).
 *   - Server connectivity gating ("startup gate"): `ConnectionGate`
 *     (`src/app/entry/app.tsx:184`) is a `createResource` that polls `GET /api/claxedo/health`
 *     (`src/utils/server-health.ts`) — for an `http`-type connection this is a SINGLE
 *     check, not a retry loop, capped at a 10s timeout either way.
 *     `revealBeforeHealth = pathname.startsWith("/s/") || pathname.startsWith("/w/")`
 *     skips waiting on that poll entirely and reveals `props.children` immediately for
 *     session routes (racing the poll in the background instead); every other route
 *     blocks behind `ClaxedoSplash` until the poll settles, then renders either
 *     `props.children` or `ConnectionError`. Recovery from `ConnectionError` is
 *     automatic, not a button: `src/context/server.tsx`'s own `healthQuery` (native
 *     `GET /health`, `refetchInterval: 10s`) drives a `createEffect` inside
 *     `ConnectionGate` that calls `actions.refetch()` once `server.healthy() === true`.
 *   - Missing-session handling: `src/session/store/session-controller.ts`'s
 *     `syncCompatSession` classifies a fetch failure via `isSessionNotFoundError`
 *     (matches `"session_not_found"`, `"Session not found"`, or
 *     `"Request failed: 404"`). On a match it calls `removeMissingSession()`, which
 *     prunes both the directory-session cache row and the shared session-inventory
 *     react-query cache entry (`removeSessionInventoryQueryData` — the same cache that
 *     feeds the sidebar's session rows) and flips a per-session `missingSessions`
 *     signal that `src/pages/session.tsx`'s `sessionMissing` memo reads to swap the
 *     timeline for the `session-unavailable` placeholder.
 *
 * ANATOMY —
 *   `[data-claxedo]` — shell root (`src/app/app-shell-layout.tsx:301`); it lives INSIDE
 *     `ConnectionGate`'s `<Show when={startup()}>` children branch, so its presence is
 *     exactly "the app painted past the gate" and its ABSENCE is the load-bearing oracle
 *     for "the gate is still holding" (behavior 9's negative half).
 *   The route-matched `/` component remains mounted invisibly so its providers stay
 *     available (`RailWorkbenchShell` wraps all routed page content in
 *     `<div class="hidden">`, `src/app/workbench/rail/rail-workbench-shell.tsx:129`).
 *     The visible zero-project surface is `RailWorkbenchCanvas`'s
 *     `OnboardingEmptyState`: a four-step setup shell whose project action delegates to
 *     the existing `handleNewProject`. With ≥1 project registered,
 *     `useRailEmptyDraftController`'s `emptyDraftDirectory` memo
 *     (`src/app/workbench/rail/rail-empty-draft-controller.ts:40`) resolves to
 *     `activeDirectory() ?? projects()[0]?.worktree`, so the canvas instead renders a
 *     live `EmptyDraftSessionComposer` for that project (and `shouldOpenEmptyDraftSession`
 *     can auto-navigate away from `/` entirely). Tests below assert against that
 *     visible workbench surface.
 *   `ConnectionError` (`src/app/entry/app.tsx:267`): "Could not reach {server name}" +
 *     "Retrying automatically…" copy; no interactive retry control. It renders as the
 *     `fallback` of the same `<Show>` that owns `props.children`, so ConnectionError and
 *     the shell root are mutually exclusive by construction.
 *   `[data-testid="session-content"][data-session-id]` — a workspace-backed session
 *     pane (`src/claxedo-ui/content-renderers/session-content.tsx`).
 *   `[data-testid="session-content-missing-workspace"][data-session-id]` — a session pane with
 *     no resolvable workspace backing ("Missing workspace").
 *   `[data-testid="session-unavailable"][data-session-id]` — INSIDE a resolved
 *     `session-content` pane, rendered by `src/pages/session.tsx` when the session's
 *     own message/detail fetch 404s ("Session unavailable").
 *   `[data-testid="rail-sidebar-session-row"][data-session-id]` — a sidebar session
 *     row (`src/claxedo-ui/navigation-islands/session-navigation-list.tsx`).
 *   Composer/timeline selectors are shared with `core-first-prompt-local` and
 *     `e2e/helpers/turn-oracle.ts` (`SELECTORS`) — reused here unchanged.
 *
 * BEHAVIORS —
 *   1. A completely fresh browser context boots the shell (`[data-claxedo]` visible)
 *      with zero console errors/exceptions and zero failed/bad network requests.
 *      ONE origin exclusion applies, and only one: the unmockable central-server
 *      origin `127.0.0.1:3001` (see the
 *      `fromUnmockedCentralOrigin` FINDING). The console list additionally drops
 *      Chromium's own *mirror* lines for network failures ("Failed to load resource"),
 *      which carry no URL in `message.text()` and therefore cannot be origin-attributed
 *      — that is a de-duplication, not a hole: every such line also lands in
 *      `requests.failed`/`requests.badResponses` WITH its full URL, and the test pins
 *      that correspondence explicitly so a mirror line with no network record fails.
 *   2. With zero projects ever registered, the workbench renders the setup shell with
 *      four visible steps, live lock state, and a project action.
 *   4. A bare `/s/:sessionId` deep link to an already-created session resolves through
 *      the session inventory and materializes the same `session-content` pane
 *      (oracle-proven: the historical reply is visible).
 *   5. A `/w/:workspaceId/session/:sessionId` deep link materializes the same
 *      `session-content` pane directly from the URL, without depending on the session
 *      inventory.
 *   6. A fresh navigation (full page load, not SPA routing) to a session-owning URL
 *      discards any OTHER tabs/panes that were open in the workbench before that
 *      navigation — only the URL's own session content survives
 *      (`workbench.contentIds` in `claxedo.state.v5` drops back to exactly one entry).
 *   7. Corrupted persisted layout self-heals on boot: both totally unparseable JSON and
 *      parseable-but-structurally-invalid JSON in `claxedo.state.v5` produce a clean
 *      boot (`[data-claxedo]` visible, no "Something went wrong" error screen, no
 *      `pageerror` console entries) instead of a crash.
 *   8. A session whose detail/message fetch 404s renders `session-unavailable` inside
 *      its pane, and a subsequent fresh boot at that session's URL no longer lists it
 *      in the sidebar (pruned from the cached session inventory).
 *   9. Startup gate: a session-owning route (`/s/…`, `/w/…`) reveals real content
 *      (the resolved session pane) promptly even while `/api/claxedo/health` never
 *      succeeds; a non-session route (`/`) never reveals its content while health
 *      never succeeds — it shows `ConnectionError` instead and stays there.
 *  10. An unreachable server shows the `ConnectionError` screen, and once
 *      `/api/claxedo/health` starts succeeding again the app auto-recovers to normal
 *      content with no user action (no retry button to click).
 *  11. [`VITE_CLAXEDO_ONBOARDING_V1=true` + `CLAXEDO_ONBOARDING_DESKTOP_E2E=1` only]
 *      Desktop-style ramp: with a project already registered, the flagged onboarding
 *      owner opens in `data-mode="form"` at the "Connect your AI" step, credential
 *      discovery/selection saves only the CHECKED items, and once a saved credential
 *      verifies the owner flips to `data-mode="hidden"` and hands off to the real draft
 *      composer — which then sends a normal first prompt.
 *  12. [`VITE_CLAXEDO_ONBOARDING_V1=true`, non-desktop surface only] `/?onboarding=…`
 *      is an honored deep link into a specific setup step, resolved against reality
 *      rather than taken on faith: a step that does not apply on this surface
 *      (`remote-access` on web) or that is not yet reachable (`ai` while the cloud
 *      answer still owes a provider key) lands on the first thing worth doing
 *      instead of on a screen the user cannot act on.
 *
 * INVARIANTS —
 *   - A fresh app mount at a session-owning URL always discards any workbench state
 *     that isn't the URL's own content (`initialStateForPath`, behavior 6).
 *   - Session routes never wait on server health to reveal content
 *     (`revealBeforeHealth`, behavior 9).
 *   - Corrupted persisted layout state never crashes boot (`validate()`, behavior 7).
 *   - Completed assistant content is never hidden by stale busy state (INVARIANTS.md
 *     #2) — implicitly relied on by every oracle call here, unchanged from
 *     `core-first-prompt-local`.
 *
 * HARNESS NOTES — none; every scenario uses the default `opencode` harness from
 *   `installMockRuntime`. Startup-gate/unreachable-server scenarios are pure
 *   shell/network concerns above the harness layer.
 *
 * OUT OF SCOPE — split/multi-pane/tab-strip semantics and the compact-switcher UI
 *   (`core-panes-split-tabs`); full sidebar tree behavior — grouping, filters,
 *   load-more, drag, archive — beyond the single prune assertion in behavior 8
 *   (`core-sidebar-tree`); workspace/project creation dialogs' actual submission flow,
 *   including the cloud-project dialog opened in behavior 3
 *   (`core-workspace-lifecycle`); the desktop-native-picker and non-sandboxed-web
 *   `DialogSelectDirectory` "Open project" branches, which are documented in ANATOMY
 *   but not e2e-reachable because this build fixes `VITE_SANDBOX_ENABLED=true` on the
 *   web platform (`src/index.tsx` `getDefaultConfig()`) — see the finding in this
 *   spec's PR/task notes.
 */
import { sessionListRoute } from "../helpers/contracts/session-list"
import { expect, test, type Locator, type Page, type Route } from "@playwright/test"
import { installMockRuntime } from "../helpers/mock-runtime"
import { expectAssistantReplyVisible, ensureComposerModelSelected, SELECTORS } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-core-boot-deep-links-home"
const PROJECT_ID = "project_core_boot_deep_links_home"
const ONBOARDING_V1 = process.env.VITE_CLAXEDO_ONBOARDING_V1 === "true"
const SESSION_ID = "ses_core_boot_deep_links_home"

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function workspaceSessionUrl(workspaceId: string, sessionId: string) {
  return `/w/${encodeURIComponent(workspaceId)}/session/${encodeURIComponent(sessionId)}`
}

async function seedOneProject(page: Page, dir: string) {
  await page.addInitScript(({ dir, projectId }: { dir: string; projectId: string }) => {
    localStorage.clear()
    ;(window as typeof window & { __CLAXEDO__?: { serverUrl?: string; activeDirectory?: string } }).__CLAXEDO__ = {
      serverUrl: window.location.origin,
      activeDirectory: dir,
    }
    localStorage.setItem(
      "claxedo.global.dat:server",
      JSON.stringify({
        list: [],
        projects: { local: [{ id: projectId, worktree: dir, expanded: true }] },
        lastProject: {},
        workspaceServer: {},
        closedProjects: {},
      }),
    )
  }, { dir, projectId: PROJECT_ID })
}

/** Pre-answers setup's destination question so a test can start at a later step. */
async function seedDestination(page: Page, destination: "local" | "cloud" | "both") {
  await page.addInitScript((value: string) => {
    localStorage.setItem("claxedo.global.dat:onboarding.destination.v1", JSON.stringify({ destination: value }))
  }, destination)
}

async function seedNoProjects(page: Page) {
  await page.addInitScript(() => {
    localStorage.clear()
    // Without a serverUrl the app targets the cross-origin default backend
    // (127.0.0.1:3001), outside every same-origin route mock in this file.
    ;(window as typeof window & { __CLAXEDO__?: { serverUrl?: string } }).__CLAXEDO__ = {
      serverUrl: window.location.origin,
    }
  })
}

/** Seeds one project plus a raw `claxedo.state.v5` value. Callers boot at "/" so the
 * session-route wipe in `initialStateForPath` does not discard it first. */
async function seedProjectWithRawLayout(page: Page, dir: string, rawLayout: string) {
  await page.addInitScript(
    (input: { d: string; raw: string }) => {
      localStorage.clear()
      ;(window as typeof window & { __CLAXEDO__?: { serverUrl?: string; activeDirectory?: string } }).__CLAXEDO__ = {
        serverUrl: window.location.origin,
        activeDirectory: input.d,
      }
      localStorage.setItem(
        "claxedo.global.dat:server",
        JSON.stringify({
          list: [],
          projects: { local: [{ worktree: input.d, expanded: true }] },
          lastProject: {},
          workspaceServer: {},
          closedProjects: {},
        }),
      )
      localStorage.setItem("claxedo.state.v5", input.raw)
    },
    { d: dir, raw: rawLayout },
  )
}

async function openDraftPrompt(page: Page, dir: string): Promise<Locator> {
  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })
  await expect(input).toHaveAttribute("contenteditable", "true")
  return input
}

/** Sidebar session rows come from `GET /api/control/session-list`, which
 * `installMockRuntime` does not mock. */
async function installSessionListMock(page: Page) {
  await page.route(sessionListRoute, (route) => {
    const type = route.request().resourceType()
    if (type !== "fetch" && type !== "xhr") return route.continue()
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        view: { scope: "global", groupBy: "none", sort: "updated_desc", limit: 50 },
        items: [
          {
            type: "session",
            sessionRef: SESSION_ID,
            sessionId: SESSION_ID,
            title: "",
            directory: DIR,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            tags: [],
            attachments: [],
          },
        ],
        totalKnown: 1,
      }),
    })
  })
}

/** Installs the mock runtime, sends a first prompt, and returns the URL the app
 * navigated to for the created session. */
async function createSessionViaFirstSend(page: Page, promptText: string) {
  const mock = await installMockRuntime(page, {
    dir: DIR,
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    // Drafts require an explicit model; `ensureComposerModelSelected` picks this one.
    harnessModels: { opencode: [{ id: "gpt-5", name: "GPT-5" }] },
  })
  await seedOneProject(page, DIR)
  const input = await openDraftPrompt(page, DIR)
  await ensureComposerModelSelected(page)
  await input.click()
  await input.fill(promptText)
  await expect(input).toContainText(promptText, { timeout: 10_000 })
  await page.locator(SELECTORS.submitControl).last().click()
  await expect(page).toHaveURL(new RegExp(`(?:/s/${SESSION_ID}|/w/[^/]+/session/${SESSION_ID})$`), { timeout: 20_000 })
  await expectAssistantReplyVisible(page, `ack 1: ${promptText}`)
  return { url: page.url(), workspaceId: mock.session.workspaceId }
}

async function readPersistedLayout(page: Page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem("claxedo.state.v5")
    if (!raw) return null
    try {
      return JSON.parse(raw) as { workbench?: { contentIds?: string[] } }
    } catch {
      return null
    }
  })
}

// The app's central-server connection resolves to 127.0.0.1:3001 independently of
// `__CLAXEDO__.serverUrl`; same-origin `page.route()` cannot intercept it and no server
// runs there in this test.
function fromUnmockedCentralOrigin(item: string) {
  return item.includes("127.0.0.1:3001")
}

/** Chromium's console mirror of a network failure carries no URL, so it cannot be
 * origin-filtered. Each one also appears with its URL in `requests.failed` or
 * `requests.badResponses`; `expectConsoleMirrorsAreAccountedFor` checks that. */
function isNetworkMirrorConsole(item: string) {
  return item.includes("Failed to load resource")
}

function nonProviderConsole(entries: string[]) {
  return entries.filter((item) => !isNetworkMirrorConsole(item) && !fromUnmockedCentralOrigin(item))
}

/** Every dropped mirror line needs a network record behind it, or the filter is hiding a failure. */
function expectConsoleMirrorsAreAccountedFor(requests: { console: string[]; failed: string[]; badResponses: string[] }) {
  const mirrors = requests.console.filter(isNetworkMirrorConsole)
  expect(mirrors.length).toBeLessThanOrEqual(requests.failed.length + requests.badResponses.length)
}

function nonProviderFailed(entries: string[]) {
  return entries.filter((item) => !fromUnmockedCentralOrigin(item))
}

function nonProviderBadResponses(entries: string[]) {
  return entries.filter((item) => !fromUnmockedCentralOrigin(item))
}

test.describe("core boot, deep links, and home @core", () => {
  test("cold boot with zero projects paints a clean shell and the Home empty state", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, sessionId: SESSION_ID })
    await page.route("**/api/claxedo/bootstrap**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          healthy: true,
          version: "1.0.0-test",
          path: { state: "", config: "", worktree: "", directory: "", home: "/tmp" },
          project: [],
          provider: { all: [], default: {}, connected: [] },
          provider_auth: {},
          config: {},
        }),
      }),
    )
    await page.route("**/project**", (route) => {
      const type = route.request().resourceType()
      if (type !== "fetch" && type !== "xhr") return route.continue()
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
    })
    await page.route("**/api/claxedo/credentials", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ credentials: [] }) }),
    )

    await seedNoProjects(page)
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

    if (ONBOARDING_V1) {
      await expect(page.getByRole("heading", { name: "Set up Claxedo" })).toBeVisible({ timeout: 20_000 })
      // Without a sandbox provider token the two cloud steps do not apply, so the counter reads 2.
      await expect(page.locator("header").getByText("Step 1 of 2")).toBeVisible()
      await expect(page.getByRole("heading", { name: "Choose where your first task runs" })).toBeVisible()
      // Scoped to the setup page: the shell's own "Skip to composer" link is not a setup affordance.
      const setupPage = page.locator('[data-component="setup-page"]')
      await expect(setupPage.getByRole("button", { name: /^Skip/ })).toHaveCount(0)
      await expect(setupPage.getByRole("button", { name: "Back" })).toHaveCount(0)
      await page.screenshot({ path: "../../docs/plans/evidence/onboarding-home-empty.png", fullPage: true })
    } else {
      await expect(page.getByText("No projects yet. Create one to get started.")).toBeVisible({ timeout: 20_000 })
      await expect(page.getByRole("heading", { name: "Set up Claxedo" })).toHaveCount(0)
    }
    // `not.toBeVisible`, not `toHaveCount(0)`: the home route stays mounted in a hidden subtree.
    await expect(page.getByText("Recent projects")).not.toBeVisible()

    await expect(page.locator("text=/something went wrong/i")).toHaveCount(0)
    expect(nonProviderConsole(mock.requests.console)).toEqual([])
    expect(nonProviderFailed(mock.requests.failed)).toEqual([])
    expect(nonProviderBadResponses(mock.requests.badResponses)).toEqual([])
    expect(mock.requests.unhandled).toEqual([])
    expectConsoleMirrorsAreAccountedFor(mock.requests)
  })

  test("the local-only onboarding ramp hands off from AI verification to the real draft composer @onboarding-enabled", async ({ page }) => {
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId: SESSION_ID,
      projectName: "core-boot-onboarding",
      harnessModels: { opencode: [{ id: "gpt-5", name: "GPT-5" }] },
    })
    let savedSelection: unknown
    let credentialRequests = 0
    await page.route("**/api/claxedo/credentials**", async (route) => {
      credentialRequests += 1
      const pathname = new URL(route.request().url()).pathname
      if (pathname.endsWith("/discover")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            discovery_id: "discovery_onboarding",
            items: [
              { provider_id: "anthropic", kind: "subscription_session", label: "Claude", origin: "local subscription", probe: { state: "broken", reason: "Signed out" } },
              { provider_id: "openai", kind: "oauth_token", label: "Codex", origin: "~/.codex/auth.json", probe: { state: "working" } },
            ],
          }),
        })
        return
      }
      if (pathname.endsWith("/save-discovered")) {
        savedSelection = route.request().postDataJSON()
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ saved: [{ credential_id: "cred_onboarding", provider_id: "anthropic" }] }),
        })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ credentials: [] }),
      })
    })

    await seedOneProject(page, DIR)
    await seedDestination(page, "local")
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await expect.poll(() => credentialRequests, { timeout: 20_000 }).toBeGreaterThan(0)
    expect(await page.evaluate(() => localStorage.getItem("claxedo.global.dat:onboarding.dismissals.v1"))).toBeNull()
    await expect(page.getByTestId("onboarding-owner")).toHaveAttribute("data-mode", "form")
    await expect(page.getByRole("heading", { name: "Set up Claxedo" })).toBeVisible({ timeout: 20_000 })
    // Web has no remote-access step, so with a project present this is the final step.
    await expect(page.locator("header").getByText("Step 2 of 2")).toBeVisible()
    await expect(page.getByRole("heading", { name: "Your logins" })).toBeVisible()

    await page.getByRole("button", { name: "Check my logins" }).click()

    await expect(page.getByRole("textbox", { name: /Ask anything/i }).last()).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId("onboarding-owner")).toHaveAttribute("data-mode", "hidden")
    await expect(page.getByRole("heading", { name: "Set up Claxedo" })).toHaveCount(0)
    expect(credentialRequests).toBeGreaterThanOrEqual(2)
    expect(savedSelection).toBeUndefined()
    await page.screenshot({ path: "../../docs/plans/evidence/onboarding-project-ai-handoff.png", fullPage: true })

    const firstPrompt = "inspect this repository and suggest a first task"
    const composer = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await ensureComposerModelSelected(page)
    await composer.fill(firstPrompt)
    await page.locator(SELECTORS.submitControl).last().click()
    await expectAssistantReplyVisible(page, `ack 1: ${firstPrompt}`)
    expect(mock.requests.promptCount).toBe(1)
  })

  test("the remote-access deep link is honoured once earlier steps are proven @onboarding-enabled", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, sessionId: SESSION_ID, projectName: "core-boot-web-onboarding" })
    await page.route("**/api/claxedo/credentials**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          credentials: [{
            id: "cred_web_onboarding",
            provider_id: "anthropic",
            scope: "shared",
            health: "ok",
          }],
        }),
      })
    })

    // A configured driver satisfies the cloud step, so the flow may move past it.
    await page.route("**/api/workspace/drivers**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          default_driver: "daytona",
          drivers: [{ id: "daytona", label: "Daytona", fields: [], configured: true, source: "local", default: true }],
        }),
      })
    })

    await seedOneProject(page, DIR)
    await seedDestination(page, "both")
    await page.goto("/?onboarding=remote-access", { waitUntil: "domcontentloaded" })

    await expect(page.getByTestId("onboarding-owner")).toHaveAttribute("data-mode", "form")
    // Web has no remote-access step, so the deep link lands on the next applicable one.
    await expect(page.getByRole("heading", { name: "Reach this machine from anywhere" })).toHaveCount(0)
    await expect(page.getByRole("heading", { name: "Do you want to run cloud sessions too?" })).toBeVisible({ timeout: 20_000 })
  })

  test("saying yes to the cloud holds the user until the cloud can actually run @onboarding-enabled", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, sessionId: SESSION_ID, projectName: "core-boot-web-onboarding" })
    await page.route("**/api/claxedo/credentials**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          credentials: [{ id: "cred_web", provider_id: "anthropic", scope: "shared", health: "ok" }],
        }),
      })
    })
    await page.route("**/api/workspace/drivers**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          default_driver: "daytona",
          drivers: [{ id: "daytona", label: "Daytona", fields: [], configured: false, source: "local", default: true }],
        }),
      })
    })

    await seedNoProjects(page)
    await page.goto("/", { waitUntil: "domcontentloaded" })

    await expect(page.getByRole("heading", { name: "Do you want to run cloud sessions too?" })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText("Sandbox provider", { exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Next" })).toBeDisabled()
    const cloudChoice = page.getByRole("button", { name: /^Yes, run cloud sessions too/ })
    await cloudChoice.click()
    await expect(cloudChoice).toHaveAttribute("aria-pressed", "true")

    // An unconfigured driver keeps the cloud question open; its form is where the key gets saved.
    await expect(page.getByText("Sandbox provider", { exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Save key" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Next" })).toBeDisabled()

    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(cloudChoice).toHaveAttribute("aria-pressed", "true")
    await expect(page.getByText("Sandbox provider", { exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Save key" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Next" })).toBeDisabled()
  })

  test("workspace-scoped deep link materializes the pane and a fresh nav discards stale tabs", async ({ page }) => {
    const created = await createSessionViaFirstSend(page, "core boot workspace deep link turn")
    const primaryUrl = created.url
    expect(primaryUrl).toContain(workspaceSessionUrl(created.workspaceId, SESSION_ID))

    // Open a second pane so the fresh navigation has something to discard.
    await page.getByRole("button", { name: "New Session", exact: true }).first().click()
    await expect
      .poll(async () => (await readPersistedLayout(page))?.workbench?.contentIds?.length ?? 0, { timeout: 15_000 })
      .toBeGreaterThan(1)

    await page.goto(primaryUrl, { waitUntil: "domcontentloaded" })
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

    await expect(page.locator(`[data-testid="session-content"][data-session-id="${SESSION_ID}"]`)).toBeVisible({
      timeout: 20_000,
    })
    await expectAssistantReplyVisible(page, "ack 1: core boot workspace deep link turn", {
      spec: "core-boot-deep-links-home",
      scenario: "workspace-deep-link-after-discard",
    })

    await expect.poll(async () => {
      const layout = await readPersistedLayout(page)
      return layout?.workbench?.contentIds?.length ?? -1
    }, { timeout: 10_000 }).toBe(1)
  })

  test("bare /s/:sessionId deep link resolves through the session inventory to the same pane", async ({ page }) => {
    await createSessionViaFirstSend(page, "core boot bare session deep link turn")

    await page.goto(`/s/${SESSION_ID}`, { waitUntil: "domcontentloaded" })
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    await expect(page.locator(`[data-testid="session-content"][data-session-id="${SESSION_ID}"]`)).toBeVisible({
      timeout: 20_000,
    })
    await expectAssistantReplyVisible(page, "ack 1: core boot bare session deep link turn", {
      spec: "core-boot-deep-links-home",
      scenario: "bare-session-deep-link",
    })
  })

  test("unparseable persisted layout self-heals into a clean boot", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, sessionId: SESSION_ID })
    await seedProjectWithRawLayout(page, DIR, "{not valid json at all")
    await page.goto("/", { waitUntil: "domcontentloaded" })

    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("Something went wrong")).toHaveCount(0)
    expect(mock.requests.console.filter((entry) => entry.startsWith("pageerror:"))).toEqual([])
  })

  test("structurally-invalid persisted layout self-heals into a clean boot", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, sessionId: SESSION_ID })
    const garbage = JSON.stringify({
      workbench: { panes: "not-an-array", split: null, contentIds: { nope: true }, focusedPaneId: 42 },
      meta: { orphan: { id: "orphan", type: "bogus-type-not-real" } },
      rail: { width: "wide" },
      workspacePanel: { open: "yes" },
    })
    await seedProjectWithRawLayout(page, DIR, garbage)
    await page.goto("/", { waitUntil: "domcontentloaded" })

    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("Something went wrong")).toHaveCount(0)
    expect(mock.requests.console.filter((entry) => entry.startsWith("pageerror:"))).toEqual([])
  })

  test("a session that 404s on fetch shows session-unavailable and is pruned from the sidebar", async ({ page }) => {
    const primaryUrl = (await createSessionViaFirstSend(page, "core boot missing session turn")).url

    // Installed only after the send settles: advertising the session in the list before
    // the create call resolves hangs the submit control.
    await installSessionListMock(page)
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    await expect(page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${SESSION_ID}"]`)).toBeVisible({
      timeout: 15_000,
    })

    // The server has lost the session. The resourceType guard keeps these patterns from
    // also intercepting the page's own document navigation, whose URL ends in the same
    // `/session/${SESSION_ID}` suffix.
    const isApiCall = (route: Route) => {
      const type = route.request().resourceType()
      return type === "fetch" || type === "xhr"
    }
    await page.route(`**/session/${SESSION_ID}`, (route) => {
      if (!isApiCall(route) || route.request().method() !== "GET") return route.fallback()
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "session_not_found" }),
      })
    })
    await page.route(`**/session/${SESSION_ID}/message**`, (route) => {
      if (!isApiCall(route) || route.request().method() !== "GET") return route.fallback()
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "session_not_found" }),
      })
    })
    await page.route(`**/api/claxedo/session/${SESSION_ID}/meta**`, (route) => {
      if (!isApiCall(route) || route.request().method() !== "GET") return route.fallback()
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "session_not_found" }),
      })
    })
    await page.route("**/session", (route) => {
      if (!isApiCall(route) || route.request().method() !== "GET") return route.fallback()
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
    })
    await page.route("**/session?**", (route) => {
      if (!isApiCall(route) || route.request().method() !== "GET") return route.fallback()
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
    })
    // Client-side pruning does not survive a full page load, so the list itself must be empty.
    await page.route(sessionListRoute, (route) => {
      if (!isApiCall(route)) return route.fallback()
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ view: { scope: "global", groupBy: "none", sort: "updated_desc", limit: 50 }, items: [], totalKnown: 0 }),
      })
    })

    await page.goto(primaryUrl, { waitUntil: "domcontentloaded" })
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

    await expect(page.locator(`[data-testid="session-unavailable"][data-session-id="${SESSION_ID}"]`)).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${SESSION_ID}"]`)).toHaveCount(0, {
      timeout: 45_000,
    })
  })

  test("session routes reveal the shell immediately while server health is failing", async ({ page }) => {
    const primaryUrl = (await createSessionViaFirstSend(page, "core boot startup gate turn")).url

    await page.route("**/api/claxedo/health", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ healthy: false }) }),
    )

    await page.goto(primaryUrl, { waitUntil: "domcontentloaded" })
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 8_000 })
    await expect(page.locator(`[data-testid="session-content"][data-session-id="${SESSION_ID}"]`)).toBeVisible({
      timeout: 8_000,
    })
    await expectAssistantReplyVisible(page, "ack 1: core boot startup gate turn", {
      spec: "core-boot-deep-links-home",
      scenario: "startup-gate-session-route",
    })
  })

  test("non-session routes hold the gate and show Could not reach when health never recovers", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, sessionId: SESSION_ID })
    await page.route("**/api/claxedo/health", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ healthy: false }) }),
    )
    await seedOneProject(page, DIR)

    await page.goto("/", { waitUntil: "domcontentloaded" })
    await expect(page.getByText(/Could not reach/)).toBeVisible({ timeout: 15_000 })
    // `[data-claxedo]` mounts inside the gate's children branch, so its absence means the gate still holds.
    await expect(page.locator("[data-claxedo]")).toHaveCount(0)

    await page.waitForTimeout(1_500)
    await expect(page.getByText(/Could not reach/)).toBeVisible()
    await expect(page.locator("[data-claxedo]")).toHaveCount(0)
  })

  test("unreachable server auto-recovers once health returns, no retry button", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, sessionId: SESSION_ID })
    let claxedoHealthCalls = 0
    await page.route("**/api/claxedo/health", (route) => {
      claxedoHealthCalls += 1
      if (claxedoHealthCalls === 1) {
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ healthy: false }) })
      }
      return route.fallback()
    })
    // Zero projects: with one present the empty workbench auto-navigates to a draft
    // composer, which would confound recovery with navigation. `installMockRuntime`
    // reports one project from bootstrap and `/project`, so both are overridden.
    await page.route("**/api/claxedo/bootstrap**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          healthy: true,
          version: "1.0.0-test",
          path: { state: "", config: "", worktree: "", directory: "", home: "/tmp" },
          project: [],
          provider: { all: [], default: {}, connected: [] },
          provider_auth: {},
          config: {},
        }),
      }),
    )
    await page.route("**/project**", (route) => {
      const type = route.request().resourceType()
      if (type !== "fetch" && type !== "xhr") return route.continue()
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
    })
    await seedNoProjects(page)

    await page.goto("/", { waitUntil: "domcontentloaded" })
    await expect(page.getByText(/Could not reach/)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("Retrying automatically")).toBeVisible()
    await expect(page.getByRole("button", { name: /retry/i })).toHaveCount(0)

    await expect(page.getByText("No projects yet. Create one to get started.")).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText(/Could not reach/)).toHaveCount(0)
  })
})
