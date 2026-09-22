/**
 * Settings surface, account/auth, providers/connections/sandbox, and the
 * signed-auth system routes (`/login`, `/cli-login`, the top-level error
 * page). Whether a signed session is required at all is the server's
 * declaration and is covered by `core-deployment-posture.spec.ts`, which owns
 * `CloudAuthGate`'s decision.
 *
 * Harness constraints — several gates in this feature are decided by
 * `import.meta.env.VITE_*` flags baked into the bundle when the shared dev
 * server started, so a spec cannot flip them at runtime:
 *   - `VITE_SANDBOX_ENABLED` in `.env.local` is dead config: no source file
 *     reads it and the Sandbox ("compute") tab is ungated, so there is no
 *     flag-off branch to cover.
 *   - `platform.checkUpdate` is implemented only by the desktop platform
 *     object, so every update-check affordance is permanently disabled on this
 *     web build and the error page's "Check for updates" button never renders.
 *   - `getClaxedoServerUrl()` is baked to `VITE_CLAXEDO_SERVER_URL`
 *     (`http://127.0.0.1:3001`). Two dev/e2e-only runtime overrides move the
 *     server the shell resolves: `window.__CLAXEDO_E2E_SERVER_URL__` (read by
 *     `resolveDefaultUrl()`) moves `ServerProvider`'s resolved default;
 *     `window.__CLAXEDO__.serverUrl` (read by `getDefaultBaseUrl()`) moves only
 *     the Sandbox tab's mutation gate.
 *   - `/__e2e/error-page?variant=` (`src/app/routes/error-page-harness.tsx`,
 *     dev/e2e-only) mounts the real `ErrorPage` for a chosen `InitError`, so
 *     the top-level `ErrorBoundary` fallback is reachable without a real
 *     render-time crash.
 *   - The Playwright config owns the process-wide auth composition
 *     (`test-user` or `local-unsigned`). Tests whose subject is a signed
 *     principal call `stampTestAuth()` before the app boots; every other test
 *     inherits the matrix mode.
 */
import { expect, test, type Page } from "@playwright/test"
import { installMockRuntime, providerCatalogIndex } from "../helpers/mock-runtime"
import { ensureComposerModelSelected } from "../helpers/turn-oracle"
import { stampTestAuth } from "../playwright-global-setup"

const DIR = "/tmp/e2e-core-settings-auth"
const SESSION_ID = "ses_core_settings_auth"

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function corsHeaders(route: import("@playwright/test").Route) {
  return {
    "Access-Control-Allow-Origin": route.request().headers().origin ?? new URL(route.request().url()).origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "authorization,content-type,accept",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  }
}

async function json(route: import("@playwright/test").Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: corsHeaders(route),
    body: JSON.stringify(body),
  })
}

/**
 * Wraps a handler so `OPTIONS` short-circuits with a 2xx and CORS headers. The routes
 * here are cross-origin to the test page and carry `Authorization`/`Content-Type`, so the
 * browser preflights them for real; an unhandled preflight fails the request behind it.
 */
function withCors(handler: (route: import("@playwright/test").Route) => Promise<void> | void) {
  return async (route: import("@playwright/test").Route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders(route) })
      return
    }
    await handler(route)
  }
}

async function seedProject(page: Page, dir: string, opts?: { serverUrl?: string }) {
  await page.addInitScript(
    ({ d, serverUrl }: { d: string; serverUrl?: string }) => {
      localStorage.clear()
      ;(window as typeof window & { __CLAXEDO__?: { serverUrl?: string; activeDirectory?: string } }).__CLAXEDO__ = {
        serverUrl: serverUrl ?? window.location.origin,
        activeDirectory: d,
      }
      localStorage.setItem(
        "claxedo.global.dat:server",
        JSON.stringify({
          list: [],
          projects: { local: [{ worktree: d, expanded: true }] },
          lastProject: {},
          workspaceServer: {},
          closedProjects: {},
        }),
      )
    },
    { d: dir, serverUrl: opts?.serverUrl },
  )
}

/**
 * Declare a session-issuing server to a test that mounts a system route
 * directly and installs no runtime mock.
 *
 * The app starts its identity provider only where the server declared it
 * issues sessions, and the webdriver test bypass lives inside that provider —
 * so without this declaration a `stampTestAuth` visitor stays anonymous and
 * the signed branch under test is never reached.
 */
async function routeDeploymentDeclaration(page: Page) {
  await page.route("**/api/claxedo/bootstrap**", (route) =>
    json(route, { healthy: true, version: "1.0.0-test", events: { hostAggregate: false }, deployment: { issuesSessions: true } }),
  )
}

/** The app auto-signs-in whenever `navigator.webdriver` is true; this turns that bypass off. */
async function disableTestAuthBypass(page: Page) {
  await page.addInitScript(() => {
    ;(window as typeof window & { __CLAXEDO_DISABLE_TEST_AUTH_BYPASS__?: boolean }).__CLAXEDO_DISABLE_TEST_AUTH_BYPASS__ = true
  })
}

/**
 * Latches (before the app's first script runs) whether a "Continue" button is
 * EVER attached to the document. `/login`'s redirect-if-already-signed guard is
 * a synchronous early `return null` in the component body
 * (`src/app/routes/login.tsx`), so for a signed visitor the button should
 * never be created at all — a claim that an after-the-fact `toHaveCount(0)`
 * cannot make (any post-redirect page satisfies that trivially, flash or no
 * flash). A MutationObserver started at document-creation time can.
 */
async function recordContinueButtonFlash(page: Page) {
  await page.addInitScript(() => {
    const w = window as typeof window & { __continueButtonSeen__?: boolean }
    w.__continueButtonSeen__ = false
    const scan = () => {
      if (w.__continueButtonSeen__) return
      for (const button of document.querySelectorAll("button")) {
        if ((button.textContent ?? "").includes("Continue")) {
          w.__continueButtonSeen__ = true
          return
        }
      }
    }
    const start = () => {
      scan()
      new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true })
    }
    if (document.documentElement) start()
    else document.addEventListener("readystatechange", start, { once: true })
  })
}

function continueButtonFlashed(page: Page) {
  return page.evaluate(() => (window as typeof window & { __continueButtonSeen__?: boolean }).__continueButtonSeen__ === true)
}

/** Reads the `__claxedoSignInCalls` seam: every `auth.signIn()` call with the
 * `redirectUrl` it was given. The Continue-triggers-sign-in test asserts a non-zero count
 * through it, which is what keeps the zero-call assertions elsewhere from being vacuous. */
function signInCalls(page: Page) {
  return page.evaluate(
    () => (window as typeof window & { __claxedoSignInCalls?: { redirectUrl?: string }[] }).__claxedoSignInCalls ?? [],
  )
}

async function openWorkbench(page: Page, dir: string) {
  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
}

async function openSettings(page: Page) {
  await page.getByTestId("rail-account-trigger").click()
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click()
  const surface = page.locator('[data-component="settings-content"]')
  await expect(surface).toBeVisible({ timeout: 10_000 })
  return surface
}

/** The rail's own back row. Settings is a surface on a route, so Escape closes
 * nothing and the workbench behind it was never unmounted. */
async function closeSettings(page: Page) {
  await page.locator('[data-action="settings-nav-back"]').click()
  await expect(page.locator('[data-component="settings-content"]')).toHaveCount(0, { timeout: 5_000 })
}

/**
 * Installs a scriptable `window.Notification` stub before the app's first
 * script runs, so the contract — permission requested at most once, only
 * from the Settings toggle, never from turn completion — can be asserted
 * without ever triggering a REAL OS/browser permission prompt.
 */
async function installMockNotificationApi(page: Page) {
  await page.addInitScript(() => {
    const w = window as typeof window & {
      __notificationRequestCount__?: number
      __notificationInstanceCount__?: number
    }
    w.__notificationRequestCount__ = 0
    w.__notificationInstanceCount__ = 0
    // Force `platform.notify`'s in-view early-return (src/app/entry/main.tsx,
    // `document.visibilityState === "visible" && document.hasFocus()`) to be
    // FALSE. Without this the notify body never executes at all for a single
    // Playwright page (always visible, always focused), and "turn completion
    // issued zero permission requests" would be satisfied by notify never
    // running rather than by notify declining to request — i.e. the assertion
    // could not distinguish the contract from a dead code path. Overriding
    // `hasFocus` (its only consumer in the whole app: `grep -rn hasFocus src`
    // ⇒ that one line) makes the body run for real, so the test observes the
    // path it claims to pin and the constructed-Notification counter becomes a
    // positive control that it ran.
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false })
    class MockNotification {
      static permission: NotificationPermission = "default"
      static requestPermission(): Promise<NotificationPermission> {
        w.__notificationRequestCount__ = (w.__notificationRequestCount__ ?? 0) + 1
        MockNotification.permission = "granted"
        return Promise.resolve("granted")
      }
      onclick: (() => void) | null = null
      constructor(_title: string, _options?: NotificationOptions) {
        w.__notificationInstanceCount__ = (w.__notificationInstanceCount__ ?? 0) + 1
      }
      close() {}
    }
    Object.defineProperty(window, "Notification", {
      configurable: true,
      writable: true,
      value: MockNotification,
    })
  })
}

function notificationRequestCount(page: Page) {
  return page.evaluate(
    () => (window as typeof window & { __notificationRequestCount__?: number }).__notificationRequestCount__ ?? 0,
  )
}

/** How many `new Notification(...)` the app constructed — the control that
 * `platform.notify`'s body ran at all. */
function notificationInstanceCount(page: Page) {
  return page.evaluate(
    () => (window as typeof window & { __notificationInstanceCount__?: number }).__notificationInstanceCount__ ?? 0,
  )
}

/** Fills the composer, submits, and waits for the FULL turn (busy -> ...
 * -> session.idle) to settle — proven via the submit control's `data-icon`
 * leaving "stop" (INVARIANTS.md cross-cutting invariant #4), not a sleep.
 * This spec pins notification-permission plumbing on session.idle here, not
 * reply rendering, so the shared turn-oracle (reply-content assertions) is
 * intentionally not used for this one scenario. */
async function driveOneTurn(page: Page, promptText: string) {
  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 10_000 })
  await ensureComposerModelSelected(page)
  await input.click()
  await input.fill(promptText)
  await expect(input).toContainText(promptText, { timeout: 5_000 })

  const submit = page.locator('[data-action="prompt-submit"]').last()
  const userBubble = page.getByText(promptText, { exact: true }).last()
  const bubbleCountBefore = await page.getByText(promptText, { exact: true }).count()
  await submit.click()
  // A click can clear the composer and start no turn at all, leaving the button disabled
  // on the empty-composer label. That is a dropped send rather than a slow one, so it is
  // re-submitted once; a turn that did start is never retried, so this cannot double-send.
  // Fast mock turns can also finish before `data-icon="stop"` is ever sampled, so a new
  // user bubble counts as proof the send landed.
  const turnStarted = async () => {
    if ((await submit.getAttribute("data-icon")) === "stop") return true
    return (await page.getByText(promptText, { exact: true }).count()) > bubbleCountBefore
  }
  try {
    await expect.poll(turnStarted, { timeout: 15_000 }).toBe(true)
  } catch (error) {
    if ((await submit.getAttribute("data-icon")) !== "send") throw error
    if ((await page.getByText(promptText, { exact: true }).count()) > bubbleCountBefore) throw error
    await input.click()
    await input.fill(promptText)
    await expect(input).toContainText(promptText, { timeout: 5_000 })
    await submit.click()
    await expect.poll(turnStarted, { timeout: 15_000 }).toBe(true)
  }
  await expect(submit).not.toHaveAttribute("data-icon", "stop", { timeout: 15_000 })
  await expect(userBubble).toBeVisible({ timeout: 15_000 })
}

function tabTrigger(page: Page, value: string) {
  return page.locator(`[data-component="settings-nav-item"][data-section="${value}"]`)
}

async function selectTab(page: Page, value: string) {
  await tabTrigger(page, value).click()
  await expect(tabTrigger(page, value)).toHaveAttribute("aria-current", "page")
}

/** The settings column: one panel, the open section's, under its one level-one heading. */
async function expectOpenSection(page: Page, value: string, title: string) {
  await expect(tabTrigger(page, value)).toHaveAttribute("aria-current", "page")
  const content = page.locator('[data-component="settings-content"]')
  await expect(content).toHaveCount(1)
  await expect(content).toHaveAttribute("data-section", value)
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1)
  await expect(page.getByRole("heading", { name: title, level: 1, exact: true })).toBeVisible()
}

async function openSelect(page: Page, dataAction: string) {
  await page.locator(`[data-action="${dataAction}"] [data-slot="select-select-trigger"]`).click()
}

function selectOption(page: Page, label: string) {
  return page.locator('[data-slot="select-select-item"]').filter({ hasText: label })
}

type ProviderFixture = {
  id: string
  name: string
  source?: "env" | "api" | "config" | "custom"
  models?: Record<string, unknown>
}

async function mockProviderCatalog(page: Page, input: {
  connected: ProviderFixture[]
  popular: ProviderFixture[]
}) {
  const all = [...input.connected, ...input.popular]
  const fullCatalog = {
    all: all.map((p) => {
      const models = p.models ?? { "m-1": { id: "m-1", name: "Model 1", cost: {} } }
      return {
        id: p.id,
        name: p.name,
        source: p.source,
        env: [],
        models,
      }
    }),
    default: Object.fromEntries(
      all.map((p) => {
        const models = p.models ?? { "m-1": { id: "m-1", name: "Model 1", cost: {} } }
        return [p.id, Object.keys(models)[0]]
      }),
    ),
    connected: input.connected.map((p) => p.id),
  }
  // Index-shaped list (one default model per connected provider) so Models can
  // still exercise detail hydration. Keep `source` so Providers disconnect tags
  // work without a hydrate race against mock-runtime's provider stub.
  const indexCatalog = providerCatalogIndex(fullCatalog)
  const listBody = {
    all: indexCatalog.all.map((provider) => {
      const full = fullCatalog.all.find((item) => item.id === provider.id)
      return full?.source ? { ...provider, source: full.source } : provider
    }),
    connected: indexCatalog.connected,
    default: indexCatalog.default,
  }
  // `?provider=<id>` is the catalog route's detail form; without it the same
  // handler answers the index shape built above.
  const connectedNow = () => fullCatalog.connected
  const fulfillProvider = (route: Parameters<Parameters<Page["route"]>[1]>[0]) => {
    if (route.request().method() !== "GET" && route.request().resourceType() !== "fetch" && route.request().resourceType() !== "xhr") {
      return route.continue()
    }
    const url = new URL(route.request().url())
    const providerId = url.searchParams.get("provider")
    if (providerId) {
      const provider = fullCatalog.all.find((item) => item.id === providerId)
      return json(route, provider
        ? { all: [provider], connected: connectedNow(), default: fullCatalog.default }
        : { all: [], connected: connectedNow(), default: fullCatalog.default })
    }
    return json(route, { ...listBody, connected: connectedNow() })
  }
  // Registered after mock-runtime's own provider stub: Playwright tries the
  // most recently registered matching route first.
  await page.route("**/api/claxedo/agent-config/providers?**", fulfillProvider)
}

async function mockAuthRoutes(page: Page, hits: { authDelete: string[] }) {
  await page.route("**/auth/**", (route) => {
    if (route.request().method() !== "DELETE") return route.continue()
    hits.authDelete.push(new URL(route.request().url()).pathname)
    return json(route, true)
  })
}

async function mockCredentialRoutes(page: Page, hits: { put: unknown[]; delete: string[] }) {
  await page.route(
    "**/api/claxedo/credentials",
    withCors(async (route) => {
      if (route.request().method() !== "PUT") return route.continue()
      hits.put.push(route.request().postDataJSON())
      return json(route, { ok: true })
    }),
  )
  await page.route(
    "**/api/claxedo/credentials/provider/**",
    withCors(async (route) => {
      if (route.request().method() !== "DELETE") return route.continue()
      hits.delete.push(new URL(route.request().url()).pathname)
      return json(route, { ok: true })
    }),
  )
}

type IntegrationFixture = { id: string; name: string; methods: ("key" | "oauth")[]; capabilities: string[]; prompts?: { id: string; label: string; secret?: boolean }[] }
type ConnectionFixture = { id: string; integrationId: string; scope: "team" | "personal"; status: "connected" | "degraded" | "broken"; accountLabel?: string }

function mockIntegrations(
  page: Page,
  input: {
    integrations: IntegrationFixture[]
    connections: ConnectionFixture[]
    onConnect?: (integrationId: string, body: Record<string, unknown>) => { status: number; body: Record<string, unknown> }
    onAttempt?: (attemptId: string) => { status: number; body: Record<string, unknown> }
  },
) {
  const connectCalls: { integrationId: string; body: Record<string, unknown> }[] = []
  const attemptCalls: string[] = []
  const disconnectCalls: string[] = []
  const reverifyCalls: string[] = []

  return {
    connectCalls,
    attemptCalls,
    disconnectCalls,
    reverifyCalls,
    async install() {
      await page.route(
        "**/api/claxedo/integrations**",
        withCors(async (route) => {
        const url = new URL(route.request().url())
        const suffix = url.pathname.split("/api/claxedo/integrations")[1] ?? ""
        const method = route.request().method()

        if (suffix === "" && method === "GET") {
          return json(route, {
            integrations: input.integrations,
            connections: input.connections,
            personalScopeEnabled: false,
          })
        }

        const connectMatch = suffix.match(/^\/([^/]+)\/connect$/)
        if (connectMatch && method === "POST") {
          const integrationId = decodeURIComponent(connectMatch[1])
          const body = route.request().postDataJSON() as Record<string, unknown>
          connectCalls.push({ integrationId, body })
          const result = input.onConnect?.(integrationId, body) ?? { status: 200, body: { ok: true } }
          return json(route, result.body, result.status)
        }

        const attemptMatch = suffix.match(/^\/attempts\/([^/]+)$/)
        if (attemptMatch && method === "GET") {
          const attemptId = decodeURIComponent(attemptMatch[1])
          attemptCalls.push(attemptId)
          const result = input.onAttempt?.(attemptId) ?? { status: 200, body: { status: "pending" } }
          return json(route, result.body, result.status)
        }

        const disconnectMatch = suffix.match(/^\/connections\/([^/]+)$/)
        if (disconnectMatch && method === "DELETE") {
          disconnectCalls.push(decodeURIComponent(disconnectMatch[1]))
          return json(route, { ok: true })
        }

        const reverifyMatch = suffix.match(/^\/connections\/([^/]+)\/reverify$/)
        if (reverifyMatch && method === "POST") {
          reverifyCalls.push(decodeURIComponent(reverifyMatch[1]))
          return json(route, { ok: true })
        }

        return route.fulfill({ status: 404, contentType: "application/json", headers: corsHeaders(route), body: "{}" })
        }),
      )
    },
  }
}

function mockSandboxDrivers(page: Page, initial: { default_driver: string; drivers: { id: string; label: string; fields: { key: string; label: string; secret?: boolean }[]; configured: boolean; source: string; default: boolean }[] }) {
  let state = initial
  const putAuthCalls: { driverId: string; body: unknown }[] = []
  const deleteAuthCalls: string[] = []
  const putDefaultCalls: unknown[] = []
  return {
    putAuthCalls,
    deleteAuthCalls,
    putDefaultCalls,
    async install() {
      await page.route(
        "**/api/workspace/drivers**",
        withCors(async (route) => {
        const url = new URL(route.request().url())
        const method = route.request().method()
        if (url.pathname === "/api/workspace/drivers" && method === "GET") return json(route, state)
        if (url.pathname === "/api/workspace/drivers/default" && method === "PUT") {
          const body = route.request().postDataJSON() as { driver: string }
          putDefaultCalls.push(body)
          state = { ...state, default_driver: body.driver, drivers: state.drivers.map((p) => ({ ...p, default: p.id === body.driver })) }
          return json(route, state)
        }
        const authMatch = url.pathname.match(/^\/api\/workspace\/drivers\/([^/]+)\/auth$/)
        if (authMatch && method === "PUT") {
          const driverId = decodeURIComponent(authMatch[1])
          const body = route.request().postDataJSON()
          putAuthCalls.push({ driverId, body })
          state = { ...state, drivers: state.drivers.map((p) => (p.id === driverId ? { ...p, configured: true } : p)) }
          return json(route, state)
        }
        if (authMatch && method === "DELETE") {
          const driverId = decodeURIComponent(authMatch[1])
          deleteAuthCalls.push(driverId)
          state = { ...state, drivers: state.drivers.map((p) => (p.id === driverId ? { ...p, configured: false } : p)) }
          return json(route, { ok: true })
        }
        return route.fulfill({ status: 404, contentType: "application/json", headers: corsHeaders(route), body: "{}" })
        }),
      )
      // The Sandbox tab's Network Policy section (`network-policy.tsx`) fires its
      // own unconditional `createResource` fetches (policy rows + groups) the
      // instant it mounts — independent of anything above, and NOT covered by the
      // `**/api/workspace/drivers**` route. Left unmocked, those hit the real
      // (unreachable in this harness) backend, reject with "Failed to fetch", and
      // — reproduced live — crash the top-level `ErrorBoundary` (src/app/entry/
      // app.tsx wraps `DialogProvider`, so the Settings dialog's own subtree
      // is inside it) partway through an otherwise-passing scenario, which is
      // exactly the class of failure this default exists to prevent for every
      // caller of `.install()`. A test that needs specific policy rows/groups can
      // still register its own more-specific `**/api/claxedo/network-policy**`
      // route AFTER calling `.install()` — Playwright's last-registered-first
      // matching lets it win (see the "Network Policy..." test below, the
      // pattern this default is modeled on).
      await page.route(
        "**/api/claxedo/network-policy**",
        withCors((route) => {
          const url = new URL(route.request().url())
          if (url.pathname === "/api/claxedo/network-policy/groups") return json(route, { groups: {} })
          return json(route, { policies: [] })
        }),
      )
    },
  }
}

test.describe("core settings + auth @core", () => {
  test.describe("settings surface: sections, gating, mobile nav", () => {
    test("General is open by default; picking a section draws exactly that section's panel", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)
      await openSettings(page)

      await expectOpenSection(page, "general", "General")

      await selectTab(page, "shortcuts")
      await expectOpenSection(page, "shortcuts", "Keyboard shortcuts")

      await selectTab(page, "models")
      await expectOpenSection(page, "models", "Models")

      await selectTab(page, "connections")
      await expectOpenSection(page, "connections", "Connections")
    })

    // The core browser command explicitly enables the preview entry point; the
    // underlying sandbox authorization and mutation contracts remain separate.
    test("the Sandbox preview flag exposes its settings section", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await mockSandboxDrivers(page, { default_driver: "docker", drivers: [] }).install()
      await openWorkbench(page, DIR)
      await openSettings(page)

      await expect(tabTrigger(page, "compute")).toBeVisible()
      await selectTab(page, "compute")
      await expectOpenSection(page, "compute", "Sandbox")
    })

    // On a phone the rail is a drawer, so the section list is reached through the
    // drawer opener, and picking a section (or leaving settings) dismisses it the way
    // every other rail navigation does.
    test("mobile viewport: the panel fills the screen, the nav is the drawer, picking a section dismisses it", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)
      const content = await openSettings(page)
      await page.setViewportSize({ width: 375, height: 812 })

      const nav = page.locator('[data-component="settings-nav"]')
      const scrim = page.getByTestId("mobile-sidebar-scrim")
      await expect(content).toBeInViewport()
      await expect(nav).not.toBeInViewport()
      await expect(scrim).toHaveCount(0)

      await page.getByTestId("mobile-sidebar-opener").click()
      await expect(nav).toBeInViewport()
      await expect(scrim).toHaveCount(1)

      await tabTrigger(page, "shortcuts").click()
      await expect(content).toHaveAttribute("data-section", "shortcuts")
      await expect(page.getByRole("heading", { name: "Keyboard shortcuts", exact: true })).toBeInViewport()
      await expect(nav).not.toBeInViewport()
      await expect(scrim).toHaveCount(0)

      await page.getByTestId("mobile-sidebar-opener").click()
      await expect(nav).toBeInViewport()
      await page.locator('[data-action="settings-nav-back"]').click()
      await expect(page.locator('[data-component="settings-content"]')).toHaveCount(0)
      await expect(scrim).toHaveCount(0)
    })
  })

  test.describe("General: account section + sign-out", () => {
    test("runner auth mode exposes the declared account principal", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)

      const mode = process.env.CLAXEDO_E2E_AUTH_MODE ?? "test-user"
      const expectedLabel = mode === "local-unsigned" ? "Not signed in" : "Test User"
      const trigger = page.getByTestId("rail-account-trigger")
      await expect(trigger).toHaveAttribute("aria-label", expectedLabel)
      await trigger.click()
      if (mode === "local-unsigned") {
        await expect(page.getByRole("menuitem", { name: "Log out" })).toHaveCount(0)
        await expect(page.getByRole("menuitem", { name: "Settings", exact: true })).toBeVisible()
      } else {
        await expect(page.getByRole("menuitem", { name: "Log out" })).toBeVisible()
      }
      await expect(page.getByText("test@claxedo.test")).toHaveCount(0)
    })

    test("account section renders for the default signed test-bypass principal, with identity + sign-out", async ({ page }) => {
      await stampTestAuth(page.context())
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)
      await openSettings(page)

      await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible()
      await expect(page.getByText("test@claxedo.test")).toBeVisible()
      await expect(page.getByRole("button", { name: "Log out" })).toBeVisible()
    })

    // Settings still opens and the rest of General renders; only the account
    // surface is gone. The signed case above is the control: the same surface,
    // the same section, the heading present.
    test("a server that issues no sessions has no account surface in Settings", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, issuesSessions: false })
      await seedProject(page, DIR)
      await disableTestAuthBypass(page)
      await openWorkbench(page, DIR)
      const dialog = await openSettings(page)

      await expect(dialog.getByRole("heading", { name: "Appearance", exact: true })).toBeVisible()
      await expect(page.getByRole("heading", { name: "Account", exact: true })).toHaveCount(0)
      await expect(page.getByRole("button", { name: "Log out" })).toHaveCount(0)
      await expect(page.getByText("test@claxedo.test")).toHaveCount(0)
    })

    // The webdriver bypass otherwise reports every principal as signed, so `signOut()`
    // sets `__CLAXEDO_TEST_SIGNED_OUT__`, which `testAuth()` honours in dev/e2e builds
    // only; without it `/login`'s redirect-if-signed guard bounces straight back.
    test("Log out signs out, purges persisted auth state, and stays on /login", async ({ page }) => {
      await stampTestAuth(page.context())
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)

      // Seed a persisted `claxedo.*` marker that a real sign-out must purge
      // (clearPersistedAuthState wipes every claxedo.* / projection-cache key).
      await page.evaluate(() => localStorage.setItem("claxedo.marker.should-be-purged", "1"))

      await openSettings(page)
      const logout = page.getByRole("button", { name: "Log out" })
      await expect(logout).toBeVisible()
      await logout.click()

      // Landing and staying on /login is what proves the principal went anonymous: a
      // still-signed one bounces to "/". The long budget covers LoginPage's lazy chunk.
      await expect(page).toHaveURL(/\/login$/, { timeout: 20_000 })
      // The anonymous login page's "Continue" CTA renders. A CSS/text locator,
      // not getByRole: the Settings dialog stays in the app-wide DialogProvider
      // stack across the route change and its modal marks siblings aria-inert,
      // so the accessibility-tree query can't see the (rendered) button.
      await expect(page.locator("button").filter({ hasText: "Continue" })).toBeVisible({ timeout: 20_000 })

      const marker = await page.evaluate(() => localStorage.getItem("claxedo.marker.should-be-purged"))
      expect(marker).toBeNull()
    })
  })

  test.describe("General: appearance preview/commit + notifications + updates", () => {
    test("hovering a color scheme option live-previews, moving off cancels, selecting commits", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)
      await openSettings(page)

      const committedBefore = await page.evaluate(() => document.documentElement.dataset.colorScheme)

      await openSelect(page, "settings-color-scheme")
      const darkOption = selectOption(page, "Dark")
      await expect(darkOption).toBeVisible()
      // Previewing reapplies the global theme and can replace the option node mid-hover,
      // so the pointer-enter event Select owns is dispatched directly rather than driven
      // through Playwright's actionability engine.
      await darkOption.dispatchEvent("pointerenter", { pointerType: "mouse" })
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.colorScheme)).toBe("dark")

      // Move off without selecting — closing the popover cancels the preview. An
      // outside click on the panel dismisses only the popover.
      await page.getByRole("heading", { name: "General", exact: true }).click()
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.colorScheme)).toBe(committedBefore)
      // Reopening while the close transition is still in flight is flaky, so wait for the
      // popover to be gone rather than just for the preview to revert.
      await expect(page.locator('[data-slot="select-select-item"]')).toHaveCount(0)

      await openSelect(page, "settings-color-scheme")
      // `{ force: true }`: the click passes the cursor over the option first and sets off
      // the same highlight → store-write → re-render churn as the hover above.
      await selectOption(page, "Dark").click({ force: true })
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.colorScheme)).toBe("dark")
      // The EXACT committed value, not merely "something was written":
      // `@opencode-ai/ui`'s theme context writes the raw scheme string to the
      // `opencode-color-scheme` key (packages/ui/src/theme/context.tsx +
      // :312, via a plain `localStorage.setItem(key, value)` — no JSON
      // wrapper), so a commit that persisted the WRONG scheme (or the
      // pre-existing one) would satisfy a bare `toBeTruthy()` and must not.
      const persisted = await page.evaluate(() => localStorage.getItem("opencode-color-scheme"))
      expect(persisted).toBe("dark")
    })

    test("all three notification switches toggle and write through to useSettings().notifications.*", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)
      await openSettings(page)

      // All three switches: two rows bound to the same setter is invisible if only one
      // is exercised.
      for (const key of ["agent", "permissions", "errors"] as const) {
        const box = page.locator(`[data-action="settings-notifications-${key}"] input[type="checkbox"]`)
        const before = await box.isChecked()
        await page.locator(`[data-action="settings-notifications-${key}"] [data-slot="switch-control"]`).click()
        await expect.poll(() => box.isChecked()).toBe(!before)

        // The `checked` flip alone proves nothing about the CONTEXT write
        // behavior 7 actually claims: a plain uncontrolled checkbox flips its
        // own `checked` with `useSettings().notifications.set*` entirely
        // broken. `useSettings()`'s store is `persisted("settings.v3", ...)`
        // (src/platform/settings/provider.tsx) with no storage prefix
        // (=> the bare `settings.v3` localStorage key,
        // src/platform/persistence/persist.ts), so the store write is
        // observable end-to-end here.
        await expect
          .poll(async () =>
            page.evaluate(
              (k: string) =>
                (JSON.parse(localStorage.getItem("settings.v3") ?? "{}") as { notifications?: Record<string, boolean> })
                  .notifications?.[k],
              key,
            ),
          )
          .toBe(!before)
      }
    })

    test("Notification permission is requested at most once, only from enabling the toggle, never from turn completion", async ({ page }) => {
      await installMockNotificationApi(page)
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)

      // Agent notifications default on; turning them off first lets the turn below cover
      // the setting-off half.
      await openSettings(page)
      const agentSwitch = page.locator('[data-action="settings-notifications-agent"] input[type="checkbox"]')
      const agentControl = page.locator('[data-action="settings-notifications-agent"] [data-slot="switch-control"]')
      if (await agentSwitch.isChecked()) await agentControl.click()
      await expect.poll(() => agentSwitch.isChecked()).toBe(false)
      await closeSettings(page)

      await driveOneTurn(page, "notification setting off turn")
      expect(await notificationRequestCount(page)).toBe(0)
      // With the setting OFF the notification provider never even calls
      // `platform.notify` (src/app/providers/notification.tsx gates on
      // `settings.notifications.agent()`), so nothing should have been
      // constructed either.
      expect(await notificationInstanceCount(page)).toBe(0)

      // Enabling the toggle is the only point a permission request may fire.
      await openSettings(page)
      if (!(await agentSwitch.isChecked())) await agentControl.click()
      await expect.poll(() => agentSwitch.isChecked()).toBe(true)
      await expect.poll(() => notificationRequestCount(page)).toBe(1)
      await closeSettings(page)

      // A second, fully-completed turn with notifications now enabled must NOT
      // request permission again: the browser's permission prompt reappears on
      // every turn completion whenever `platform.notify`
      // (src/app/entry/main.tsx) calls `Notification.requestPermission()`
      // itself while permission is still "default".
      await driveOneTurn(page, "notification setting on turn")
      // Control first: a constructed Notification shows `platform.notify` ran, so the
      // zero-new-requests assertion below is not satisfied by a path that never executed.
      await expect.poll(() => notificationInstanceCount(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
      // ...and still one permission request in total: notify read the granted permission
      // rather than asking again.
      expect(await notificationRequestCount(page)).toBe(1)
    })

    test("update-check affordances are disabled on the web platform (no platform.checkUpdate)", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)
      await openSettings(page)

      await expect(page.locator('[data-action="settings-updates-startup"] input[type="checkbox"]')).toBeDisabled()
      await expect(page.getByRole("button", { name: "Check now" })).toBeDisabled()
    })
  })

  test.describe("Shortcuts: search, rebind, conflict, reset", () => {
    test("search filters the list; a no-match query shows the empty state", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "shortcuts")

      const search = page.getByPlaceholder("Search shortcuts")
      await search.fill("Command Palette")
      await expect(page.locator('[data-keybind-id="command.palette"]')).toBeVisible()

      await search.fill("zzz-definitely-not-a-real-shortcut-zzz")
      await expect(page.getByText("No shortcuts found")).toBeVisible()
    })

    test("rebinding a shortcut records the next keydown as its new binding", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "shortcuts")

      await page.getByPlaceholder("Search shortcuts").fill("Command Palette")
      const row = page.locator('[data-keybind-id="command.palette"]')
      const originalBinding = await row.textContent()
      expect(originalBinding).toBeTruthy()
      await row.click()
      await expect(row).toHaveText("Press keys")

      await page.keyboard.press("Alt+Shift+K")
      // The ACTUAL new binding's label, not just "no longer capturing":
      // `not.toHaveText("Press keys")` + `not.toHaveText("Unassigned")` is
      // satisfied by an app that silently RESTORED the original binding, which
      // is precisely the regression behavior 10 is meant to catch. The row
      // renders `formatKeybind(...)` (src/features/settings/ui/keybinds.tsx →
      // src/app/providers/command-palette.tsx), which on a non-mac
      // `navigator.platform` joins the translated modifier labels with "+"
      // ("Alt"/"Shift", src/platform/i18n/en.ts) and upper-cases a
      // single-character key; on mac it concatenates the glyphs with no
      // separator. Playwright's bundled Chromium reports "Win32" here
      // regardless of host OS (see the conflict test below for the same fact),
      // but resolve it at runtime rather than hardcoding either form.
      const isMac = await page.evaluate(() => /(Mac|iPod|iPhone|iPad)/.test(navigator.platform))
      await expect(row).toHaveText(isMac ? "⌥⇧K" : "Alt+Shift+K")
      expect(await row.textContent()).not.toBe(originalBinding)
    })

    test("rebinding to a combo already used elsewhere shows a conflict toast and changes nothing", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "shortcuts")

      // Command Palette's default binding is mod+shift+p — attempt to steal it
      // for a different command (search finds a General-group non-palette row).
      await page.getByPlaceholder("Search shortcuts").fill("Command Palette")
      const paletteBinding = await page.locator('[data-keybind-id="command.palette"]').textContent()
      expect(paletteBinding).toBeTruthy()

      await page.getByPlaceholder("Search shortcuts").fill("")
      const anotherRow = page.locator("[data-keybind-id]").filter({ hasNotText: "Unassigned" }).nth(1)
      const anotherId = await anotherRow.getAttribute("data-keybind-id")
      expect(anotherId).not.toBe("command.palette")
      const beforeText = await anotherRow.textContent()

      await anotherRow.click()
      await expect(anotherRow).toHaveText("Press keys")
      // Capture mode consumes exactly the NEXT keydown and exits (behavior
      // 10) — pressing a second combo as a cross-platform hedge does nothing
      // once the first has already been consumed, so the modifier for this
      // single press must actually match `mod` (src/context/command-
      // upstream.tsx, `IS_MAC = /(Mac|iPod|iPhone|iPad)/.test(navigator.
      // platform)`). Playwright's bundled Chromium reports
      // `navigator.platform === "Win32"` in this harness regardless of the
      // host OS, so `mod` is always Ctrl here, never Meta/Cmd — resolve it at
      // runtime instead of hardcoding either.
      const isMac = await page.evaluate(() => /(Mac|iPod|iPhone|iPad)/.test(navigator.platform))
      await page.keyboard.press(isMac ? "Meta+Shift+P" : "Control+Shift+P")

      await expect(page.getByText("Shortcut already in use")).toBeVisible({ timeout: 5_000 })
      // On conflict the capture handler toasts and returns without calling
      // `stop()`: capture mode deliberately stays active (row still reads
      // "Press keys") so the user can immediately try a different combo.
      // Clicking the same row again is the app's own exit path out of capture.
      await anotherRow.click()
      await expect(anotherRow).toHaveText(beforeText ?? "")

      // The row that already OWNED the combination must still own it — the
      // other half of "leaves both bindings unchanged". Re-filter to bring the
      // palette row back into the (currently unfiltered) list.
      await page.getByPlaceholder("Search shortcuts").fill("Command Palette")
      await expect(page.locator('[data-keybind-id="command.palette"]')).toHaveText(paletteBinding ?? "")
    })

    test("Reset to defaults is disabled until an override exists, then clears overrides", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "shortcuts")

      const reset = page.getByRole("button", { name: "Reset to defaults" })
      await expect(reset).toBeDisabled()

      await page.getByPlaceholder("Search shortcuts").fill("Command Palette")
      const row = page.locator('[data-keybind-id="command.palette"]')
      await row.click()
      await page.keyboard.press("Alt+Shift+K")
      await expect(reset).toBeEnabled()

      await reset.click()
      await expect(page.getByText("Shortcuts reset")).toBeVisible()
      await expect(reset).toBeDisabled()
    })
  })

  test.describe("Providers: connect, disconnect, env-locked, custom validation", () => {
    test("connecting a popular API-key provider PUTs credentials and marks it connected", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await mockProviderCatalog(page, {
        connected: [],
        popular: [{ id: "anthropic", name: "Anthropic" }],
      })
      const credHits = { put: [] as unknown[], delete: [] as string[] }
      await mockCredentialRoutes(page, credHits)
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "models")

      const harnessSection = page.locator('[data-component="pi-providers-section"]')
      const row = harnessSection.locator('[data-provider="anthropic"]')
      await expect(row.getByText("Anthropic")).toBeVisible()
      await row.getByRole("button", { name: "Connect" }).click()

      // Connecting opens in a dialog and, with two methods on offer (subscription
      // token, API key), waits for one to be picked before showing its field.
      const card = page.locator('[data-component="provider-connect-card"]')
      await expect(card).toBeVisible()
      await card.getByRole("radio").and(card.locator('[data-method-type="api"]')).click()
      await expect(card.getByLabel(/Anthropic API key/i)).toBeVisible()
      await card.getByLabel(/Anthropic API key/i).fill("sk-test-anthropic-key")
      // A new credential needs a name of the user's own, or the row would be
      // listed under the provider id, which reads the same for every key.
      await card.getByRole("button", { name: "Continue" }).click()
      await expect(card.getByText("Add a label so you can recognize this account")).toBeVisible()
      expect(credHits.put).toEqual([])
      await card.getByLabel("Label", { exact: true }).fill("work key")
      await card.getByRole("button", { name: "Continue" }).click()

      await expect.poll(() => credHits.put.length, { timeout: 10_000 }).toBe(1)
      expect(credHits.put[0]).toMatchObject({
        provider_id: "anthropic",
        kind: "api_key",
        secret: "sk-test-anthropic-key",
        label: "work key",
      })
      await expect(page.getByText("Anthropic connected")).toBeVisible()
      // The list is where the user left it: the dialog closes on its own.
      await expect(card).toHaveCount(0)
    })

    test("an env-sourced connected provider has no Disconnect button; API-key Disconnect DELETEs credentials and engine auth", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await mockProviderCatalog(page, {
        connected: [
          { id: "anthropic", name: "Anthropic", source: "env" },
          { id: "openai", name: "OpenAI", source: "api" },
        ],
        popular: [],
      })
      const credHits = { put: [] as unknown[], delete: [] as string[] }
      await mockCredentialRoutes(page, credHits)
      const authHits = { authDelete: [] as string[] }
      await mockAuthRoutes(page, authHits)
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "models")

      const harnessSection = page.locator('[data-component="pi-providers-section"]')
      const envRow = harnessSection.locator('[data-provider="anthropic"]')
      await expect(envRow).toHaveCount(1)
      await expect(envRow.getByText("Environment", { exact: true })).toBeVisible()
      await expect(envRow.getByRole("button", { name: "Disconnect" })).toHaveCount(0)

      const apiRow = harnessSection.locator('[data-provider="openai"]')
      await expect(apiRow).toHaveCount(1)
      await expect(apiRow.getByText("API key", { exact: true })).toBeVisible()
      await apiRow.getByRole("button", { name: "Disconnect" }).click()

      await expect.poll(() => credHits.delete.length, { timeout: 10_000 }).toBe(1)
      expect(credHits.delete[0]).toContain("/openai")
      await expect.poll(() => authHits.authDelete.length, { timeout: 10_000 }).toBe(1)
      expect(authHits.authDelete[0]).toMatch(/\/auth\/openai$/)
      await expect(page.getByText("OpenAI disconnected")).toBeVisible()
    })

    test("configuration-owned providers do not advertise unsupported disconnect writes", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await mockProviderCatalog(page, {
        connected: [{ id: "clinepass-2", name: "Cline pass 2", source: "config" }], popular: [],
      })
      const credentialHits = { put: [] as unknown[], delete: [] as string[] }
      await mockCredentialRoutes(page, credentialHits)
      const authHits = { authDelete: [] as string[] }
      await mockAuthRoutes(page, authHits)
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "models")
      const row = page.locator('[data-component="pi-providers-section"] [data-provider="clinepass-2"]')
      await expect(row.getByText("Config", { exact: true })).toBeVisible()
      await expect(row.getByRole("button", { name: "Disconnect" })).toHaveCount(0)
      expect(authHits).toEqual({ authDelete: [] })
      expect(credentialHits.delete).toEqual([])
    })

    test("provider settings do not offer the removed embedded provider registry", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await mockProviderCatalog(page, { connected: [], popular: [] })
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "models")
      await expect(page.locator('[data-component="custom-provider-section"]')).toHaveCount(0)
    })
  })

  test.describe("Models: catalog hydration", () => {
    test("Settings Models lists every model after connected-provider detail hydration", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      // Two connected providers, so each one is named above its models. With a
      // single provider whose id is the harness's own, the harness heading stands
      // for it and no provider row is drawn.
      await mockProviderCatalog(page, {
        connected: [
          {
            id: "opencode",
            name: "OpenCode Zen",
            models: {
              "big-pickle": { id: "big-pickle", name: "Big Pickle" },
              "model-two": { id: "model-two", name: "Second Model" },
            },
          },
          { id: "anthropic", name: "Anthropic", models: { "claude-x": { id: "claude-x", name: "Claude X" } } },
        ],
        popular: [],
      })
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "models")

      // A harness opens on its accounts; its models are the other tab. The index
      // catalog names only each provider's default model, so "Second Model" is on
      // screen only once the provider's detail has been fetched.
      const harness = page.locator('[data-component="models-section-opencode"]')
      await harness.locator('[data-action="settings-models-tab-models"]').click()
      const group = harness.locator('[data-component="models-group"][data-provider="opencode"]')
      await expect(group.getByText("OpenCode Zen")).toBeVisible({ timeout: 15_000 })
      // A provider with a model on opens already, so its rows need no expand click.
      await expect(group.getByRole("switch", { name: "Big Pickle" })).toBeVisible({ timeout: 15_000 })
      await expect(group.getByRole("switch", { name: "Second Model" })).toBeVisible({ timeout: 15_000 })
      await expect(harness.locator('[data-component="models-group"][data-provider="anthropic"]').getByText("Anthropic")).toBeVisible()
    })
  })

  test.describe("Connections: status states, connect flow, OAuth polling, secret hygiene, disconnect", () => {
    test("integration rows show status chips and the right action set per status", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      const mock = mockIntegrations(page, {
        integrations: [{ id: "notion", name: "Notion", methods: ["key"], capabilities: ["docs"], prompts: [{ id: "secret", label: "API secret", secret: true }] }],
        connections: [{ id: "conn-degraded", integrationId: "notion", scope: "team", status: "degraded" }],
      })
      await mock.install()
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "connections")

      await expect(page.getByText("Degraded")).toBeVisible()
      await expect(page.getByRole("button", { name: "Re-verify" })).toBeVisible()
      await expect(page.getByRole("button", { name: "Reconnect" })).toBeVisible()
    })

    test("connecting a key-method integration POSTs /connect and reloads the list on success", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      const mock = mockIntegrations(page, {
        integrations: [{ id: "notion", name: "Notion", methods: ["key"], capabilities: ["docs"], prompts: [{ id: "secret", label: "API secret", secret: true }] }],
        connections: [],
      })
      await mock.install()
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "connections")

      await page.getByRole("button", { name: "Connect", exact: true }).click()
      const dialog = page.locator('[data-slot="dialog-container"]').last()
      await expect(dialog.getByText("Connect Notion")).toBeVisible()
      await dialog.getByLabel("API secret").fill("notion-secret-value")
      await dialog.getByRole("button", { name: "Connect" }).click()

      await expect.poll(() => mock.connectCalls.length, { timeout: 10_000 }).toBe(1)
      expect(mock.connectCalls[0].integrationId).toBe("notion")
      await expect(page.getByText("Notion connected")).toBeVisible()
      await expect(dialog).toBeHidden()
    })

    test("a 409 connection_exists response switches to confirm-replace instead of erroring", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      const mock = mockIntegrations(page, {
        integrations: [{ id: "notion", name: "Notion", methods: ["key"], capabilities: ["docs"], prompts: [{ id: "secret", label: "API secret", secret: true }] }],
        connections: [],
        onConnect: (_id, body) =>
          body.confirmReplace === true
            ? { status: 200, body: { ok: true } }
            : { status: 409, body: { code: "connection_exists" } },
      })
      await mock.install()
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "connections")

      await page.getByRole("button", { name: "Connect", exact: true }).click()
      const dialog = page.locator('[data-slot="dialog-container"]').last()
      await dialog.getByLabel("API secret").fill("notion-secret-value")
      await dialog.getByRole("button", { name: "Connect" }).click()

      await expect(dialog.getByText(/already exists\. Replace the existing connection\?/)).toBeVisible({ timeout: 10_000 })
      await dialog.getByRole("button", { name: "Replace" }).click()
      await expect.poll(() => mock.connectCalls.length, { timeout: 10_000 }).toBe(2)
      await expect(dialog).toBeHidden()
    })

    test("an OAuth-only integration opens the URL and polls attempts until complete", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      let polls = 0
      const mock = mockIntegrations(page, {
        integrations: [{ id: "github", name: "GitHub", methods: ["oauth"], capabilities: ["repos"] }],
        connections: [],
        onConnect: () => ({ status: 200, body: { url: "http://127.0.0.1:9/oauth/authorize", attemptId: "attempt-1" } }),
        onAttempt: () => {
          polls += 1
          return polls < 2 ? { status: 200, body: { status: "pending" } } : { status: 200, body: { status: "complete" } }
        },
      })
      await mock.install()
      // The stub RECORDS its argument so the URL handed to `window.open` can be
      // asserted; a bare `() => null` leaves the "opens the URL" half with no
      // assertion behind it and passes with `options.openUrl?.(url)`
      // (`src/features/settings/ui/connections-logic.ts`) deleted outright.
      await page.addInitScript(() => {
        const w = window as typeof window & { __openedUrls__?: string[]; open: typeof window.open }
        w.__openedUrls__ = []
        w.open = ((url?: string | URL) => {
          w.__openedUrls__?.push(typeof url === "string" ? url : (url?.toString() ?? ""))
          return null
        }) as typeof window.open
      })
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "connections")

      await page.getByRole("button", { name: "Connect", exact: true }).click()
      const dialog = page.locator('[data-slot="dialog-container"]').last()
      await dialog.getByRole("button", { name: "Continue with OAuth" }).click()

      await expect(dialog.getByText("Waiting for authorization")).toBeVisible()
      // The authorization URL the server returned reached `window.open`. Asserted before
      // the success poll so a failure lands on the open step, not on polling.
      await expect
        .poll(
          () => page.evaluate(() => (window as typeof window & { __openedUrls__?: string[] }).__openedUrls__ ?? []),
          { timeout: 10_000 },
        )
        .toEqual(["http://127.0.0.1:9/oauth/authorize"])

      await expect(page.getByText("GitHub connected")).toBeVisible({ timeout: 15_000 })
      expect(mock.attemptCalls.length).toBeGreaterThanOrEqual(2)
    })

    // The title stops at what a spec can falsify. `createConnectFlow` runs inside the
    // component body, so its store is per-instance and dies with the component either way:
    // a reopened-and-empty assertion observes disposal, not the cleanup. What is asserted
    // is that no input holds the secret and nothing was sent; the cleanup's one observable
    // effect is pinned by the next test.
    test("closing the connect dialog leaves no secret in any input and sends nothing", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      const mock = mockIntegrations(page, {
        integrations: [{ id: "notion", name: "Notion", methods: ["key"], capabilities: ["docs"], prompts: [{ id: "secret", label: "API secret", secret: true }] }],
        connections: [],
      })
      await mock.install()
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "connections")

      await page.getByRole("button", { name: "Connect", exact: true }).click()
      const dialog = page.locator('[data-slot="dialog-container"]').last()
      const secretField = dialog.getByLabel("API secret")
      await secretField.fill("leaked-if-not-cleared")
      await dialog.locator('[data-slot="dialog-close-button"]').click()
      // Connect is the only dialog on screen: Settings is a surface on a
      // route, so it is not in the dialog stack at all and closing this one
      // leaves nothing behind it.
      await expect(page.locator('[data-slot="dialog-container"]')).toHaveCount(0)

      await openSettings(page)
      await selectTab(page, "connections")
      await page.getByRole("button", { name: "Connect", exact: true }).click()
      const reopenedDialog = page.locator('[data-slot="dialog-container"]').last()
      const reopenedSecret = reopenedDialog.getByLabel("API secret")
      // Positive precondition: the field actually re-rendered. Without it, an
      // empty-value assertion on a locator that matched nothing is vacuous.
      await expect(reopenedSecret).toHaveCount(1)
      // `toHaveValue` reads the `value` property, the only place a password input's
      // contents live; a text query cannot see them.
      await expect(reopenedSecret).toHaveValue("")

      const secretLeakedIntoAField = await page.evaluate((needle: string) => {
        const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")]
        if (fields.some((field) => field.value.includes(needle))) return true
        return [...document.querySelectorAll<HTMLElement>("[contenteditable]")].some((node) =>
          (node.textContent ?? "").includes(needle),
        )
      }, "leaked-if-not-cleared")
      expect(secretLeakedIntoAField).toBe(false)

      expect(mock.connectCalls.length).toBe(0)
      expect(JSON.stringify(mock.connectCalls)).not.toContain("leaked-if-not-cleared")
    })

    // The connect dialog's cleanup bumps `generation`, which is the only thing that stops
    // `pollAttempt`'s loop. That loop is a plain async function tied to nothing in Solid's
    // lifecycle, so without the cleanup it keeps hitting `GET /attempts/:id` forever after
    // the dialog is gone.
    test("closing the connect dialog mid-OAuth cancels the attempt poll loop", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      const mock = mockIntegrations(page, {
        integrations: [{ id: "github", name: "GitHub", methods: ["oauth"], capabilities: ["repos"] }],
        connections: [],
        onConnect: () => ({ status: 200, body: { url: "http://127.0.0.1:9/oauth/authorize", attemptId: "attempt-1" } }),
        // Never completes: the user closes the dialog while authorization is
        // still outstanding, which is the real-world shape of this cleanup.
        onAttempt: () => ({ status: 200, body: { status: "pending" } }),
      })
      await mock.install()
      await page.addInitScript(() => {
        ;(window as typeof window & { open: typeof window.open }).open = (() => null) as typeof window.open
      })
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "connections")

      await page.getByRole("button", { name: "Connect", exact: true }).click()
      const dialog = page.locator('[data-slot="dialog-container"]').last()
      await dialog.getByRole("button", { name: "Continue with OAuth" }).click()
      await expect(dialog.getByText("Waiting for authorization")).toBeVisible()

      // Check the loop is running first, or "it stopped" is satisfied by one that never
      // started.
      await expect.poll(() => mock.attemptCalls.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)

      await dialog.locator('[data-slot="dialog-close-button"]').click()
      await expect(page.locator('[data-slot="dialog-container"]')).toHaveCount(0)

      // `pollAttempt` re-checks `generation` after each sleep and each fetch, so once the
      // cleanup runs nothing further is dispatched. One in-flight request is allowed to
      // settle, then the counter must stay flat across several poll intervals — an absence
      // of events has no arrival to await, so the window is time-boxed.
      await page.waitForTimeout(500)
      const afterClose = mock.attemptCalls.length
      await page.waitForTimeout(7_000)
      expect(mock.attemptCalls.length).toBe(afterClose)
    })

    test("disconnect is a two-step inline confirm; Cancel sends nothing, Confirm DELETEs", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      const mock = mockIntegrations(page, {
        integrations: [{ id: "notion", name: "Notion", methods: ["key"], capabilities: ["docs"] }],
        connections: [{ id: "conn-1", integrationId: "notion", scope: "team", status: "connected" }],
      })
      await mock.install()
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "connections")

      await page.getByRole("button", { name: "Disconnect", exact: true }).click()
      await expect(page.getByText("Disconnect?")).toBeVisible()

      await page.getByRole("button", { name: "Cancel" }).click()
      await expect(page.getByText("Disconnect?")).toHaveCount(0)
      expect(mock.disconnectCalls.length).toBe(0)

      await page.getByRole("button", { name: "Disconnect", exact: true }).click()
      await page.getByRole("button", { name: "Confirm" }).click()
      await expect.poll(() => mock.disconnectCalls.length, { timeout: 10_000 }).toBe(1)
      expect(mock.disconnectCalls[0]).toBe("conn-1")
      await expect(page.getByText("Notion disconnected")).toBeVisible()
    })
  })

  test.describe("Sandbox: default provider, credential CRUD, read-only lock, network policy", () => {
    test("switching provider offers 'Use for new workspaces', PUTs default, and clears", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      const sandbox = mockSandboxDrivers(page, {
        default_driver: "docker",
        drivers: [
          { id: "docker", label: "Docker", fields: [{ key: "token", label: "Token", secret: true }], configured: true, source: "config", default: true },
          // Configured on purpose: the affordance only renders for a provider that already
          // has credentials, which is the point of switching without retyping a key.
          { id: "e2b", label: "E2B", fields: [{ key: "token", label: "Token", secret: true }], configured: true, source: "config", default: false },
        ],
      })
      await sandbox.install()
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "compute")

      const useForNew = page.getByRole("button", { name: "Use for new workspaces" })
      await expect(useForNew).toHaveCount(0)
      await page.locator('[data-component="settings-content"] [data-slot="select-select-trigger"]').first().click()
      // `{ force: true }`: the Select popover never settles under Playwright's
      // hover-stability check, which is `packages/ui` Select behaviour rather than anything
      // this row wires up.
      await page.locator('[data-slot="select-select-item"]').filter({ hasText: "E2B" }).click({ force: true })

      await expect(useForNew).toBeVisible()
      await useForNew.click()

      await expect.poll(() => sandbox.putDefaultCalls.length, { timeout: 10_000 }).toBe(1)
      expect(sandbox.putDefaultCalls[0]).toMatchObject({ driver: "e2b" })
      await expect(page.getByText("Default sandbox provider updated")).toBeVisible()
      // E2B is the active provider now, so the affordance retires itself.
      await expect(useForNew).toHaveCount(0)
    })

    test("credential CRUD: Save PUTs auth, Remove DELETEs", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      const sandbox = mockSandboxDrivers(page, {
        default_driver: "docker",
        drivers: [{ id: "docker", label: "Docker", fields: [{ key: "token", label: "Token", secret: true }], configured: false, source: "config", default: true }],
      })
      await sandbox.install()
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "compute")

      // No Configure step: the selected provider's form is always open.
      await page.locator('input[type="password"]').first().fill("provider-token-value")
      await page.getByRole("button", { name: "Save", exact: true }).click()

      await expect.poll(() => sandbox.putAuthCalls.length, { timeout: 10_000 }).toBe(1)
      expect(sandbox.putAuthCalls[0].driverId).toBe("docker")
      await expect(page.getByText("Docker credentials saved")).toBeVisible()

      await expect(page.getByRole("button", { name: "Remove" })).toBeVisible()
      await page.getByRole("button", { name: "Remove" }).click()
      await expect.poll(() => sandbox.deleteAuthCalls.length, { timeout: 10_000 }).toBe(1)
      await expect(page.getByText("Docker credentials removed")).toBeVisible()
    })

    test("non-loopback base URL locks every sandbox mutation control and shows the read-only notice", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR, { serverUrl: "https://cloud.claxedo-e2e-test.invalid" })
      const sandbox = mockSandboxDrivers(page, {
        default_driver: "docker",
        drivers: [{ id: "docker", label: "Docker", fields: [{ key: "token", label: "Token", secret: true }], configured: true, source: "config", default: true }],
      })
      await sandbox.install()
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "compute")

      await expect(
        page.getByText("Signed hosted sessions can view local sandbox providers but cannot change local credentials."),
      ).toBeVisible()
      await expect(page.locator('[data-component="settings-content"] [data-slot="select-select-trigger"]').first()).toBeDisabled()
      // The credential form is always open, so the read-only lock has to reach
      // the input itself, not just the buttons around it.
      await expect(page.locator('[data-component="settings-content"] input[type="password"]').first()).toBeDisabled()
      await expect(page.getByRole("button", { name: "Remove" })).toBeDisabled()
    })

    test("Network Policy inside the workspace-less Sandbox tab always allows adding an entry", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      const sandbox = mockSandboxDrivers(page, { default_driver: "docker", drivers: [] })
      await sandbox.install()
      let policyPostCount = 0
      await page.route(
        "**/api/claxedo/network-policy**",
        withCors((route) => {
          const url = new URL(route.request().url())
          if (url.pathname === "/api/claxedo/network-policy/groups") return json(route, { groups: { registries: ["npmjs.org"] } })
          if (route.request().method() === "POST") {
            policyPostCount += 1
            return json(route, { ok: true })
          }
          return json(route, { policies: [] })
        }),
      )
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "compute")

      await expect(page.getByText(/Only workspace admins and owners can edit network policy\./)).toHaveCount(0)
      const addButton = page.getByRole("button", { name: "Add", exact: true })
      await expect(addButton).toBeDisabled()
      await page.locator('input[placeholder="api.example.com"]').fill("api.example.com")
      await expect(addButton).toBeEnabled()
      await addButton.click()
      await expect.poll(() => policyPostCount, { timeout: 10_000 }).toBe(1)
    })
  })

  test.describe("/login", () => {
    test("already-signed visitors are redirected before Continue ever renders", async ({ page }) => {
      await stampTestAuth(page.context())
      await page.route("**/api/claxedo/bootstrap**", (route) =>
        json(route, {
          healthy: true,
          events: { hostAggregate: true },
          deployment: { issuesSessions: true },
          version: "1.0.0-test",
          path: { state: "", config: "", worktree: "", directory: "", home: "/tmp" },
          project: [],
          provider: { all: {}, default: {}, connected: [] },
          provider_auth: {},
          config: {},
        }),
      )
      await recordContinueButtonFlash(page)
      await page.goto("/login")
      await page.waitForLoadState("domcontentloaded")
      // Signed (default test-bypass) visitor: the component body's synchronous
      // `if (auth.status() === "signed") { navigate(...); return null }`
      // (`src/app/routes/login.tsx`) redirects and returns before the JSX
      // is ever created — the URL moves off /login.
      await expect(page).not.toHaveURL(/\/login$/, { timeout: 15_000 })
      // ...and nothing flashed on the way: the observer installed before the app's first
      // script never saw a Continue button attached.
      expect(await continueButtonFlashed(page)).toBe(false)
    })

    test("not-signed visitors see Continue, which triggers sign-in", async ({ page }) => {
      await disableTestAuthBypass(page)
      // Control for the no-flash observer: the same detector must latch true on the page
      // where Continue does render, or the other test's `false` could mean a broken
      // observer rather than no flash.
      await recordContinueButtonFlash(page)
      await page.goto("/login")
      await page.waitForLoadState("domcontentloaded")
      await expect(page).toHaveURL(/\/login$/)

      const continueButton = page.getByRole("button", { name: "Continue" })
      await expect(continueButton).toBeVisible()
      expect(await continueButtonFlashed(page)).toBe(true)
      await expect(page.getByRole("link", { name: /Terms of Service/i })).toBeVisible()

      await continueButton.click()
      // With no provider key the redirect is a no-op and "Redirecting..." clears within a
      // microtask, so the race-free contract is that the click invoked sign-in at all,
      // which the `__claxedoSignInCalls` seam records.
      await expect.poll(async () => (await signInCalls(page)).length).toBe(1)
      // `/login` passes its own `redirectUrl()`, which defaults to "/" — assert
      // the ARGUMENT too, not just that something was called.
      expect((await signInCalls(page))[0]?.redirectUrl).toBe("/")
    })
  })

  test.describe("/cli-login", () => {
    test("missing/invalid params are rejected immediately with zero auth calls", async ({ page }) => {
      await page.goto("/cli-login")
      await page.waitForLoadState("domcontentloaded")
      await expect(page.getByText("Claxedo CLI")).toBeVisible()
      await expect(page.getByText("Invalid CLI sign-in callback.")).toBeVisible()
      // The `__claxedoSignInCalls` seam is the same one the `/login` test above
      // uses POSITIVELY (it asserts exactly one recorded call), so a zero here
      // is a real zero and not a never-instrumented one. Poll rather than read
      // once: the rejection is synchronous in the page's createEffect, but a
      // regression that called signIn would do so asynchronously and an instant
      // read could miss it.
      await expect.poll(async () => (await signInCalls(page)).length, { timeout: 3_000 }).toBe(0)
    })

    test("a non-loopback callback origin is rejected the same way, with zero auth calls", async ({ page }) => {
      await page.goto("/cli-login?callback=https%3A%2F%2Fevil.example.com%2Fcb&state=abc123")
      await page.waitForLoadState("domcontentloaded")
      await expect(page.getByText("Invalid CLI sign-in callback.")).toBeVisible()
      // An attacker-supplied callback origin must not even start an auth handshake.
      await expect.poll(async () => (await signInCalls(page)).length, { timeout: 3_000 }).toBe(0)
    })

    test("not-signed visitor with valid params calls signIn with the current URL as redirectUrl", async ({ page }) => {
      await disableTestAuthBypass(page)
      await page.goto("/cli-login?callback=http%3A%2F%2F127.0.0.1%3A61234%2Fcb&state=abc123")
      await page.waitForLoadState("domcontentloaded")
      await expect(page.getByText("Opening Claxedo sign-in...")).toBeVisible({ timeout: 10_000 })

      // The status string alone proves only that the page took the
      // not-signed branch. Behavior 27 claims the CALL and its ARGUMENT:
      // `void auth.signIn({ redirectUrl: window.location.href })`
      // (src/app/routes/cli-login.tsx). A regression that dropped the
      // argument would fall back to `signIn`'s own default
      // (`window.location.origin`, src/platform/auth/better-auth-browser-auth.ts) and
      // silently strand the CLI handshake — the callback/state query would be
      // lost across the round trip — while still painting this exact status.
      await expect.poll(async () => (await signInCalls(page)).length, { timeout: 10_000 }).toBe(1)
      const redirectUrl = (await signInCalls(page))[0]?.redirectUrl ?? ""
      expect(redirectUrl).toContain("/cli-login")
      expect(redirectUrl).toContain("callback=http%3A%2F%2F127.0.0.1%3A61234%2Fcb")
      expect(redirectUrl).toContain("state=abc123")
    })

    test("signed visitor with valid params exchanges a CLI token and auto-submits the callback form", async ({ page }) => {
      await stampTestAuth(page.context())
      await routeDeploymentDeclaration(page)
      let exchangeCalls = 0
      let exchangeAuth: string | null = null
      await page.route(
        "**/api/auth/cli/exchange",
        withCors(async (route) => {
          exchangeCalls += 1
          exchangeAuth = route.request().headers()["authorization"] ?? null
          // A delay on the response, not a test-side wait: answering instantly lets the
          // whole approve → exchange → submit → navigate chain finish before "Approving CLI
          // sign-in..." ever paints.
          await new Promise((resolve) => setTimeout(resolve, 300))
          return json(route, { access_token: "cli-access-token-xyz", token_type: "bearer", expires_in: 3600 })
        }),
      )
      let callbackHit: URLSearchParams | undefined
      await page.route("**/local-cli-callback**", async (route) => {
        callbackHit = new URL(route.request().url()).searchParams
        if (route.request().method() === "POST") {
          callbackHit = new URLSearchParams(route.request().postData() ?? "")
        }
        return route.fulfill({ status: 200, contentType: "text/plain", body: "ok" })
      })

      await page.goto("/cli-login?callback=http%3A%2F%2F127.0.0.1%3A61234%2Flocal-cli-callback&state=state-xyz")
      await page.waitForLoadState("domcontentloaded")
      await expect(page.getByText("Approving CLI sign-in...")).toBeVisible({ timeout: 10_000 })

      await expect.poll(() => exchangeCalls, { timeout: 10_000 }).toBe(1)
      expect(exchangeAuth).toMatch(/^Bearer /)
      await expect.poll(() => callbackHit?.get("access_token"), { timeout: 10_000 }).toBe("cli-access-token-xyz")
      expect(callbackHit?.get("state")).toBe("state-xyz")
      expect(callbackHit?.get("identity")).toBeTruthy()
    })

    test("an exchange failure surfaces the server's error message and never submits a form", async ({ page }) => {
      await stampTestAuth(page.context())
      await routeDeploymentDeclaration(page)
      let formSubmitted = false
      await page.route(
        "**/api/auth/cli/exchange",
        withCors((route) =>
          route.fulfill({
            status: 401,
            contentType: "application/json",
            headers: corsHeaders(route),
            body: JSON.stringify({ error: { message: "The browser session has expired." } }),
          }),
        ),
      )
      await page.route("**/local-cli-callback**", async (route) => {
        formSubmitted = true
        return route.fulfill({ status: 200, contentType: "text/plain", body: "ok" })
      })

      await page.goto("/cli-login?callback=http%3A%2F%2F127.0.0.1%3A61234%2Flocal-cli-callback&state=state-xyz")
      await page.waitForLoadState("domcontentloaded")

      await expect(page.getByText("The browser session has expired.")).toBeVisible({ timeout: 10_000 })
      expect(formSubmitted).toBe(false)
    })

  })

  test.describe("error page (top-level ErrorBoundary fallback)", () => {
    // `/__e2e/error-page?variant=` mounts the real `<ErrorPage>` for a chosen InitError,
    // reaching the ErrorBoundary's fallback content without a render-time crash. The route
    // is dev/e2e-only.
    test("InitError variants render their formatted chain with Restart (and no Check-for-updates on web)", async ({ page }) => {
      await page.goto("/__e2e/error-page?variant=MCPFailed")
      await page.waitForLoadState("domcontentloaded")

      await expect(page.getByTestId("error-page-harness")).toBeVisible({ timeout: 15_000 })
      await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible()

      const details = page.getByRole("textbox", { name: "Error Details" })
      await expect(details).toHaveValue(/MCPFailed[\s\S]*MCP server "github" failed/)

      // Restart is always present; Check-for-updates is web-absent
      // (platform.checkUpdate is undefined on the web platform).
      await expect(page.getByRole("button", { name: "Restart" })).toBeVisible()
      await expect(page.getByRole("button", { name: "Check for updates" })).toHaveCount(0)

      // A second variant exercises the formatter's `Caused by:` nesting, not one shape.
      await page.goto("/__e2e/error-page?variant=causeChain")
      await page.waitForLoadState("domcontentloaded")
      await expect(page.getByRole("textbox", { name: "Error Details" })).toHaveValue(
        /Failed to reach provider[\s\S]*Caused by:[\s\S]*socket hang up/,
      )
    })
  })
})
