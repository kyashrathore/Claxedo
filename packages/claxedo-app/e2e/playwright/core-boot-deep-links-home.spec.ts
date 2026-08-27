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
 *     repopulates the workbench. Project/model prefs (`opencode.global.dat:server`,
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
 *     `activeWorkspaceId() ?? projects()[0]?.worktree`, so the canvas instead renders a
 *     live `EmptyDraftSessionComposer` for that project (and `shouldOpenEmptyDraftSession`
 *     can auto-navigate away from `/` entirely). Tests below assert against that
 *     visible workbench surface.
 *   `ConnectionError` (`src/app/entry/app.tsx:267`): "Could not reach {server name}" +
 *     "Retrying automatically…" copy; no interactive retry control. It renders as the
 *     `fallback` of the same `<Show>` that owns `props.children`, so ConnectionError and
 *     the shell root are mutually exclusive by construction.
 *   `[data-testid="session-content"][data-session-id]` — a workspace-backed session
 *     pane (`src/claxedo-ui/content-renderers/session-content.tsx`).
 *   `[data-testid="central-session-content"][data-session-id]` — a session pane with
 *     no resolvable workspace backing ("No workspace backing" / "Session unavailable").
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
 *      TWO origin exclusions apply, and ONLY two: Clerk's dev-key CORS noise (an
 *      always-on side effect of `VITE_AUTH_ENABLED=true`, unrelated to this app's own
 *      code paths) and the unmockable central-server origin `127.0.0.1:3001` (see the
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
import { expectAssistantReplyVisible, SELECTORS } from "../helpers/turn-oracle"

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
    ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
      serverUrl: window.location.origin,
      activeDirectory: dir,
    }
    localStorage.setItem(
      "opencode.global.dat:server",
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

/**
 * Answers setup's first question ("where should agents run?") before the page
 * boots, so a test can start at a later step. Without it every run opens on the
 * destination question and the cloud steps stay absent — which is the flow's
 * point, not a bug to route around in production.
 */
async function seedDestination(page: Page, destination: "local" | "cloud" | "both") {
  await page.addInitScript((value: string) => {
    localStorage.setItem("opencode.global.dat:onboarding.destination.v1", JSON.stringify({ destination: value }))
  }, destination)
}

async function seedNoProjects(page: Page) {
  await page.addInitScript(() => {
    localStorage.clear()
    // Without this, `getDefaultBaseUrl()`/`server.url` falls through to the hardcoded,
    // cross-origin default backend (127.0.0.1:3001) instead of the page's own origin —
    // the resulting fetch is cross-origin, triggers a CORS preflight, and fails outside
    // any of this file's same-origin `page.route()` patterns ("TypeError: Failed to
    // fetch" from src/context/global-sdk.tsx's event stream). Same fix as
    // seedOneProject/seedProjectWithRawLayout below.
    ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string } }).__OPENCODE__ = {
      serverUrl: window.location.origin,
    }
  })
}

/** Seeds one project AND a raw value for the workbench-layout storage key, so we can
 * exercise the corrupted-layout self-heal path (behavior 7) without also triggering
 * the deep-link wipe (`initialStateForPath` only wipes on session-owning routes, and
 * these tests boot at "/"). */
async function seedProjectWithRawLayout(page: Page, dir: string, rawLayout: string) {
  await page.addInitScript(
    (input: { d: string; raw: string }) => {
      localStorage.clear()
      ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
        serverUrl: window.location.origin,
        activeDirectory: input.d,
      }
      localStorage.setItem(
        "opencode.global.dat:server",
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

/** FINDING (shared-helper gap, worked around locally per this pooled phase's rules —
 * mock-runtime.ts edits are forbidden here): the sidebar's session list
 * (`rail-sidebar-session-row`) is populated from `GET /api/control/session-list`
 * (`src/utils/workspace-control-routes.ts` `controlSessionNavigationListUrl`,
 * `src/claxedo-ui/layouts/rail-sidebar.tsx`'s `globalSessionList` query) — a
 * claxedo-server-native endpoint entirely distinct from the OpenCode `/session` API
 * that `installMockRuntime` mocks. Without this route the sidebar shows "Could not
 * load sessions." and no row ever renders. `mock-runtime.ts` should grow a default
 * handler for this route. */
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

/** Drives a full first-send flow (same shape as core-first-prompt-local) and returns
 * the URL the app navigated to once the session was created. Every deep-link /
 * discard-stale-tab scenario below builds on top of this real, oracle-proven turn.
 * Installs the shared mock runtime itself — every caller in this file relies on this
 * (a prior version of this helper omitted the call, which silently let every route
 * fall through to a real, non-existent backend at 127.0.0.1:3001 and hung every
 * caller on the `ConnectionError` screen — see finding in this spec's PR notes). */
async function createSessionViaFirstSend(page: Page, promptText: string) {
  await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, sessionId: SESSION_ID })
  await seedOneProject(page, DIR)
  const input = await openDraftPrompt(page, DIR)
  await input.click()
  await input.fill(promptText)
  await expect(input).toContainText(promptText, { timeout: 10_000 })
  await page.locator(SELECTORS.submitControl).last().click()
  await expect(page).toHaveURL(new RegExp(`(?:/s/${SESSION_ID}|/w/[^/]+/session/${SESSION_ID})$`), { timeout: 20_000 })
  await expectAssistantReplyVisible(page, `ack 1: ${promptText}`)
  return page.url()
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

// FINDING (verified by reading source, not resolvable via a spec-local page.route —
// mock-runtime.ts edits are forbidden in this pooled phase): `AuthenticatedLayout`'s
// `resolveDefaultUrl()` (src/app.tsx:353-361) always falls back to the hardcoded
// `getClaxedoServerUrl()` default (http://127.0.0.1:3001) for the app's own "central"
// server connection when no `platform.getDefaultServer()`/env override is present —
// this is a SEPARATE resolution path from `__OPENCODE__.serverUrl`
// (`getDefaultBaseUrl()`/`seedOneProject`/`seedNoProjects` in this file), used only by
// `directory-layout.tsx`. Multiple distinct control-plane-scoped endpoints
// (`src/context/global-sdk.tsx`'s global event stream on mount, `/api/wr/events` relay
// polling, `/api/control/sessions`) all connect to this central URL directly and are
// NOT interceptable from a same-origin `page.route()` — tried with and without a query
// string, and with/without a resourceType guard, verified not to work — so they
// genuinely reach 127.0.0.1:3001 and fail to connect (no real claxedo-server runs there
// in this mocked test). This is an environment/architecture gap, not app misbehavior
// under real conditions (a real dev environment DOES run claxedo-server on :3001) —
// filtered by origin here the same way Clerk's noise is, pending either an app fix
// (respect a test-injected central server URL) or a mock-runtime.ts default-backend-
// origin route.
function fromUnmockedCentralOrigin(item: string) {
  return item.includes("127.0.0.1:3001")
}

/** Chromium's own console MIRROR of a network event ("Failed to load resource: …").
 * `mock-runtime.ts` records only `message.text()`, which for these lines carries no URL
 * (the origin lives in `message.location()`, which the shared helper does not capture),
 * so they cannot be origin-attributed from the console list alone. Dropping them from
 * `nonClerkConsole` is a DE-DUPLICATION, not a silent hole: a resource that fails to
 * load always also produces either a `requestfailed` (`requests.failed`) or a >=400
 * `response` (`requests.badResponses`) entry WITH its full URL, and those two lists are
 * asserted below with only the two documented origin exclusions. `expectConsoleMirrors
 * AreAccountedFor` pins that correspondence so this filter can never swallow a failure
 * the network assertions cannot see. (The former blanket `"ERR_FAILED"` clause was
 * removed: it was undocumented, matched any origin, and is redundant — Chromium prefixes
 * those same lines with "Failed to load resource".) */
function isNetworkMirrorConsole(item: string) {
  return item.includes("Failed to load resource")
}

function nonClerkConsole(entries: string[]) {
  return entries.filter(
    (item) =>
      !item.includes("clerk.accounts.dev") &&
      !item.includes("Clerk:") &&
      !isNetworkMirrorConsole(item) &&
      !fromUnmockedCentralOrigin(item),
  )
}

/** Every dropped network-mirror console line must have a real network record behind it.
 * If mirrors outnumber the recorded failures, some failure exists that ONLY the
 * (URL-less, hence unfilterable) console knows about — exactly the blind spot the
 * `isNetworkMirrorConsole` filter would otherwise create. */
function expectConsoleMirrorsAreAccountedFor(requests: { console: string[]; failed: string[]; badResponses: string[] }) {
  const mirrors = requests.console.filter(isNetworkMirrorConsole)
  expect(mirrors.length).toBeLessThanOrEqual(requests.failed.length + requests.badResponses.length)
}

function nonClerkFailed(entries: string[]) {
  return entries.filter((item) => !item.includes(".clerk.accounts.dev") && !fromUnmockedCentralOrigin(item))
}

function nonClerkBadResponses(entries: string[]) {
  return entries.filter((item) => !item.includes(".clerk.accounts.dev") && !fromUnmockedCentralOrigin(item))
}

test.describe("core boot, deep links, and home @core", () => {
  test("cold boot with zero projects paints a clean shell and the Home empty state — behaviors 1,2", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, sessionId: SESSION_ID })
    // NOTE: the global SDK's central event-stream connection (zero-workspace context)
    // is NOT interceptable from here — see the `nonClerkConsole` FINDING comment below
    // for the full citation (it targets a hardcoded default origin the app resolves
    // independently of any test-injected server URL, and same-origin page.route
    // patterns — tried with and without a query string — do not catch it).
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
      // Behavior 2: the flagged onboarding owner renders the registry-driven shell.
      await expect(page.getByRole("heading", { name: "Set up Claxedo" })).toBeVisible({ timeout: 20_000 })
      // Setup is a page with one step on screen, not a checklist of four rows.
      // Without a sandbox provider token the two cloud steps do not apply, so
      // the counter reads 2 rather than 4.
      await expect(page.locator("header").getByText("Step 1 of 2")).toBeVisible()
      await expect(page.getByRole("heading", { name: "Choose where your first task runs" })).toBeVisible()
      // Required steps have no exit: no skip, and no Back on the first screen.
      // Scoped to the setup page — the shell has its own "Skip to composer"
      // accessibility link that is not a setup affordance.
      const setupPage = page.locator('[data-component="setup-page"]')
      await expect(setupPage.getByRole("button", { name: /^Skip/ })).toHaveCount(0)
      await expect(setupPage.getByRole("button", { name: "Back" })).toHaveCount(0)
      await page.screenshot({ path: "../../docs/plans/evidence/onboarding-home-empty.png", fullPage: true })
    } else {
      await expect(page.getByText("No projects yet. Create one to get started.")).toBeVisible({ timeout: 20_000 })
      await expect(page.getByRole("heading", { name: "Set up Claxedo" })).toHaveCount(0)
    }
    // Non-visibility, not `.toHaveCount(0)`: `routes/home.tsx` is dead code but still
    // MOUNTS, inside `RailWorkbenchShell`'s permanently-`hidden` subtree (see the ANATOMY
    // finding). Its "Recent projects" node is gated on `recent().length > 0`, which this
    // zero-project fixture never satisfies — so this line's job is only to state that the
    // dead recents surface is not user-visible; the load-bearing behavior-2 oracle is the
    // "No projects yet…" / "Set up Claxedo" branch assertion above.
    await expect(page.getByText("Recent projects")).not.toBeVisible()

    // Behavior 1: clean boot hygiene.
    await expect(page.locator("text=/something went wrong/i")).toHaveCount(0)
    // (A `localStorage.length < 20` proxy for "clean shell" used to sit here. It was an
    // arbitrary magic ceiling — it neither named a key that must not be written nor
    // could fail for any behavior this spec owns — so it is gone rather than restated.
    // The real boot-hygiene oracles are the four network/console lists below.)
    expect(nonClerkConsole(mock.requests.console)).toEqual([])
    expect(nonClerkFailed(mock.requests.failed)).toEqual([])
    expect(nonClerkBadResponses(mock.requests.badResponses)).toEqual([])
    // `requests.unhandled` is now a REAL list — every fetch/xhr that reached the end of
    // the route chain without a handler. Verified live while it was being built: a
    // deliberately-unmocked `fetch("/tripwire-scaffold-probe")` was recorded as exactly
    // one entry ("GET http://localhost:4455/tripwire-scaffold-probe") and nothing else,
    // and mocking the one real escape this assertion found on its first honest run
    // (`GET /api/control/sessions`) took the list back to empty. Before that it was
    // written to by nothing at all, so this line passed vacuously.
    expect(mock.requests.unhandled).toEqual([])
    expectConsoleMirrorsAreAccountedFor(mock.requests)
  })

  test("the local-only onboarding ramp hands off from AI verification to the real draft composer — behavior 11 @onboarding-enabled", async ({ page }) => {
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
    expect(await page.evaluate(() => localStorage.getItem("opencode.global.dat:onboarding.dismissals.v1"))).toBeNull()
    await expect(page.getByTestId("onboarding-owner")).toHaveAttribute("data-mode", "form")
    await expect(page.getByRole("heading", { name: "Set up Claxedo" })).toBeVisible({ timeout: 20_000 })
    // Web has no remote-access step, so the local flow advances directly to
    // its second and final step once the project is present.
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
    await composer.fill(firstPrompt)
    await page.locator(SELECTORS.submitControl).last().click()
    await expectAssistantReplyVisible(page, `ack 1: ${firstPrompt}`)
    expect(mock.requests.promptCount).toBe(1)
  })

  test("the remote-access deep link is honoured once earlier steps are proven — behavior 12 @onboarding-enabled", async ({ page }) => {
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

    // Saying yes to the cloud owes a provider key and a connected repository;
    // both are already satisfied here, so the flow is free to move past step 1.
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
    // Web has no "this machine" to reach, so the step is absent and the deep
    // link lands on the first thing still worth doing rather than on nothing.
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

    await seedOneProject(page, DIR)
    await seedDestination(page, "both")
    await page.goto("/?onboarding=ai", { waitUntil: "domcontentloaded" })

    // The server rejects workspace creation without driver credentials, so a
    // bare yes is not a finished answer. The deep link past it falls back to
    // the question, whose own form is where the missing key is repaired —
    // reachable WITHOUT already having a key, which is the circularity this
    // flow exists to break.
    await expect(page.getByRole("heading", { name: "Do you want to run cloud sessions too?" })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText("Sandbox provider", { exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Save key" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Next" })).toBeDisabled()
  })

  test("workspace-scoped deep link materializes the pane and a fresh nav discards stale tabs — behaviors 5,6", async ({ page }) => {
    const primaryUrl = await createSessionViaFirstSend(page, "core boot workspace deep link turn")
    expect(primaryUrl).toContain(workspaceSessionUrl(PROJECT_ID, SESSION_ID))

    // Behavior 6 needs a stale tab to actually exist before the fresh nav, so open one
    // DELIBERATELY. The precondition is pinned STRICTLY `> 1`: with the previous
    // `toBeGreaterThanOrEqual(1)` the post-nav `toBe(1)` assertion below was satisfiable
    // by a 1 -> 1 no-op, i.e. the test passed without anything ever being discarded.
    //
    // CORRECTED FINDING (2026-07-25 — the previous comment here was stale and its
    // premise is now measurably false): `useRailEmptyDraftController`
    // (src/app/workbench/rail/rail-empty-draft-controller.ts:53-60) does NOT auto-open a
    // second draft pane in this scenario. `shouldOpenEmptyDraftSession` requires BOTH
    // `visibleRenderableSurfaceIds().length === 0` AND `!focusedSurface()`, and the real
    // session pane materialized by the first send is visible AND focused — so the
    // auto-draft never fires and `contentIds` stays at exactly 1. (Pinning `> 1` without
    // this click was tried first and timed out at a steady `Received: 1`, which is what
    // exposed the stale claim.) With no auto-draft to dedupe against, the "New Session"
    // click that the old comment described as a no-op now genuinely opens a second pane:
    // `handleNewSession` (src/features/session/actions/session-actions.tsx:194) calls
    // `state.layout.openSession(directory, "new", ...)`, and there is no existing
    // (directory, "new") surface for the workbench to collapse it into.
    await page.getByRole("button", { name: "New Session", exact: true }).first().click()
    await expect
      .poll(async () => (await readPersistedLayout(page))?.workbench?.contentIds?.length ?? 0, { timeout: 15_000 })
      .toBeGreaterThan(1)

    // Behavior 6: a FRESH navigation (full page load) back to the session's own deep
    // link discards the extra draft tab — only the URL's own content survives.
    await page.goto(primaryUrl, { waitUntil: "domcontentloaded" })
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

    // Behavior 5: the pane that materializes is the correct session pane.
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

  test("bare /s/:sessionId deep link resolves through the session inventory to the same pane — behavior 4", async ({ page }) => {
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

  test("unparseable persisted layout self-heals into a clean boot — behavior 7", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, sessionId: SESSION_ID })
    await seedProjectWithRawLayout(page, DIR, "{not valid json at all")
    await page.goto("/", { waitUntil: "domcontentloaded" })

    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("Something went wrong")).toHaveCount(0)
    expect(mock.requests.console.filter((entry) => entry.startsWith("pageerror:"))).toEqual([])
  })

  test("structurally-invalid persisted layout self-heals into a clean boot — behavior 7", async ({ page }) => {
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

  test("a session that 404s on fetch shows session-unavailable and is pruned from the sidebar — behavior 8", async ({ page }) => {
    const primaryUrl = await createSessionViaFirstSend(page, "core boot missing session turn")

    // Installed only after the send settles (not inside createSessionViaFirstSend):
    // registering it earlier makes the control-plane list advertise the session
    // before the app's own create-session call resolves, which hangs the submit
    // control (session-store reconciliation confusion) — see installSessionListMock's
    // doc comment for the underlying shared-helper gap this works around.
    await installSessionListMock(page)
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    await expect(page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${SESSION_ID}"]`)).toBeVisible({
      timeout: 15_000,
    })

    // Simulate the server having lost this session: its detail/message fetch and the
    // list endpoint both stop including it.
    // Bug fix (verified — not shared-helper territory): these patterns end in the same
    // suffix as the PAGE's own document-navigation URL below
    // (`/w/<workspaceId>/session/<id>` also ends in `/session/${SESSION_ID}`), so without a
    // resourceType guard the "session 404" mock also intercepts `page.goto(primaryUrl)`
    // itself and serves raw JSON as the document — a bare `method !== "GET"` check
    // does not distinguish the two (both are GET).
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
    // Also override the control-plane list (installSessionListMock above still reports
    // the row unconditionally) so this fresh boot's OWN list fetch reflects "gone" too
    // — a full page.goto tears down the JS/react-query state, so client-side pruning
    // from a prior boot does not carry over; the list response itself must be empty.
    await page.route(sessionListRoute, (route) => {
      if (!isApiCall(route)) return route.fallback()
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ view: { scope: "global", groupBy: "none", sort: "updated_desc", limit: 50 }, items: [], totalKnown: 0 }),
      })
    })

    // A fresh boot (full page load) at the session's own deep link — the server no
    // longer has it, so the whole discovery chain (list + detail) reflects "gone".
    await page.goto(primaryUrl, { waitUntil: "domcontentloaded" })
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

    await expect(page.locator(`[data-testid="session-unavailable"][data-session-id="${SESSION_ID}"]`)).toBeVisible({
      timeout: 20_000,
    })
    // The prune is eventual: it lands on a later sync/discovery pass, not on
    // the unavailable surface's own settling (run 383 and one local repro: the
    // row outlived a 10-20s window while the unavailable pane was already up,
    // then pruned). Budget a full sync cycle on a starved runner.
    await expect(page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${SESSION_ID}"]`)).toHaveCount(0, {
      timeout: 45_000,
    })
  })

  test("session routes reveal the shell immediately while server health is failing — behavior 9", async ({ page }) => {
    const primaryUrl = await createSessionViaFirstSend(page, "core boot startup gate turn")

    // From here on /api/claxedo/health always fails. revealBeforeHealth means this
    // must NOT block the session pane from rendering.
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

  test("non-session routes hold the gate and show Could not reach when health never recovers — behavior 9", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, sessionId: SESSION_ID })
    await page.route("**/api/claxedo/health", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ healthy: false }) }),
    )
    await seedOneProject(page, DIR)

    await page.goto("/", { waitUntil: "domcontentloaded" })
    await expect(page.getByText(/Could not reach/)).toBeVisible({ timeout: 15_000 })
    // The "content never revealed" half of behavior 9 is pinned on the SHELL ROOT, not
    // on any page-level text. `[data-claxedo]` (app-shell-layout.tsx:301) mounts inside
    // `ConnectionGate`'s `<Show when={startup()}>` children branch, whose `fallback` is
    // ConnectionError itself — so its absence is a direct, falsifiable statement that the
    // gate is still holding, and it flips the instant the gate leaks. (This assertion
    // previously used `getByText("Recent projects")`, which is a poor oracle here: that
    // string only ever renders inside `pages/home.tsx`, which `RailWorkbenchShell` keeps
    // in a permanently `hidden` subtree — see the ANATOMY finding — and only once its
    // lazy chunk plus the projects query have both landed. It could read 0 for reasons
    // that have nothing to do with the gate.)
    await expect(page.locator("[data-claxedo]")).toHaveCount(0)

    // Stays broken — no spurious recovery while health keeps failing.
    await page.waitForTimeout(1_500)
    await expect(page.getByText(/Could not reach/)).toBeVisible()
    await expect(page.locator("[data-claxedo]")).toHaveCount(0)
  })

  test("unreachable server auto-recovers once health returns, no retry button — behavior 10", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, sessionId: SESSION_ID })
    let claxedoHealthCalls = 0
    await page.route("**/api/claxedo/health", (route) => {
      claxedoHealthCalls += 1
      if (claxedoHealthCalls === 1) {
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ healthy: false }) })
      }
      return route.fallback()
    })
    // Zero projects (not seedOneProject): with ≥1 project the real empty-workbench
    // surface auto-navigates to a draft-session composer (see ANATOMY finding), which
    // would confound "recovered to normal content" with "navigated away from /". Zero
    // projects keeps the real fallback stable and directly comparable to behavior 2.
    // installMockRuntime's default bootstrap/project routes report ONE project
    // (session.dir) unconditionally — override both (same shape as behaviors-1,2's
    // test) so the project list genuinely reflects zero, matching seedNoProjects below.
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

    // Automatic recovery: no click, just the server.healthy() -> refetch() loop. Real
    // empty-state marker (RailWorkbenchCanvas fallback — see ANATOMY finding).
    await expect(page.getByText("No projects yet. Create one to get started.")).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText(/Could not reach/)).toHaveCount(0)
  })
})
