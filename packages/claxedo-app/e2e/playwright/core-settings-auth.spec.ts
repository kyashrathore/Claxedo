/**
 * Settings dialog, account/auth, providers/connections/sandbox, and the
 * signed-auth system routes (`/login`, `/cli-login`, `CloudAuthGate`, the
 * top-level error page).
 *
 * Harness constraints — several gates in this feature are decided by
 * `import.meta.env.VITE_*` flags baked into the bundle when the shared dev
 * server started, so a spec cannot flip them at runtime:
 *   - `VITE_AUTH_ENABLED=true`, so `authEnabled === false` — and with it
 *     `principal.kind === "local"` — is unreachable from a spec here.
 *   - `VITE_SANDBOX_ENABLED` in `.env.local` is dead config: no source file
 *     reads it and the Sandbox ("compute") tab is ungated, so there is no
 *     flag-off branch to cover.
 *   - `platform.checkUpdate` is implemented only by the desktop platform
 *     object, so every update-check affordance is permanently disabled on this
 *     web build and the error page's "Check for updates" button never renders.
 *   - `getClaxedoServerUrl()` is baked to `VITE_CLAXEDO_SERVER_URL`
 *     (`http://127.0.0.1:3001`), always a loopback host, so `CloudAuthGate`
 *     never redirects by default. Two dev/e2e-only runtime overrides move that
 *     instead: `window.__CLAXEDO_E2E_SERVER_URL__` (read by
 *     `resolveDefaultUrl()`) moves `ServerProvider`'s resolved default, hence
 *     `CloudAuthGate`'s `server.url`; `window.__CLAXEDO__.serverUrl` (read by
 *     `getDefaultBaseUrl()`) moves only the Sandbox tab's mutation gate and
 *     leaves `CloudAuthGate`'s resolution path alone.
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
 * Every custom route this spec registers (credentials, integrations, sandbox
 * providers, network policy, cli/exchange) targets `getClaxedoServerUrl()`
 * (credentials/integrations/cli-exchange) or a deliberately-forced
 * `window.__CLAXEDO__.serverUrl` (the sandbox read-only-lock scenario) — both
 * genuinely cross-origin relative to the Playwright test page, through
 * `authFetch`/`api.*`, which always attach `Authorization`/`Content-Type`
 * headers. A real browser performs a real CORS preflight (`OPTIONS`) against
 * those before the actual request, even though the response is mocked — an
 * unhandled preflight (e.g. falling through to a catch-all 404) fails the
 * real GET/PUT/DELETE that follows. Wrap every custom handler so `OPTIONS`
 * short-circuits with a 2xx + CORS headers.
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

/** Reads the `__claxedoSignInCalls` e2e seam (`src/platform/auth/browser-auth-test-bypass.ts`,
 * DEV || VITE_CLAXEDO_E2E gated) — every `auth.signIn()` invocation with the
 * `redirectUrl` it was given. The `/login` "Continue triggers sign-in" test
 * below asserts a POSITIVE count through this same seam, which is this file's
 * proof the seam is live and therefore that the zero-call assertions elsewhere
 * are not vacuous. */
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
  const dialog = page.locator('[data-slot="dialog-container"]').last()
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  return dialog
}

/** Escape is the Settings dialog's own close affordance at desktop viewport:
 * the `aria-label="Close settings"` button only renders under the
 * `max-sm:flex` mobile breakpoint. */
async function closeSettings(page: Page) {
  await page.keyboard.press("Escape")
  await expect(page.locator('[data-slot="dialog-container"]').last()).toBeHidden({ timeout: 5_000 })
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

/** How many `new Notification(...)` the app actually constructed — the positive
 * control that `platform.notify`'s body RAN (see installMockNotificationApi). */
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
  // Turn START gets the same budget as turn completion below. Three CI runs
  // (354, 361, 365 — the last with a 15s budget) saw the same stall: the
  // click clears the composer and then NO turn ever starts, the button
  // sitting disabled+"send" with the empty-composer label the whole window.
  // That is a dropped send, not a slow one, so re-submit once — the first
  // click provably started no turn, so a second cannot double-send. A turn
  // that DID start (icon "stop", or the user bubble landed) is never retried.
  //
  // Fast mock turns can finish before Playwright samples data-icon="stop";
  // treat a new exact user bubble as proof the send landed.
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
  return page.locator(`[role="tab"][data-value="${value}"]`)
}

async function selectTab(page: Page, value: string) {
  await tabTrigger(page, value).click()
  await expect(tabTrigger(page, value)).toHaveAttribute("aria-selected", "true")
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

async function mockAuthAndGlobalConfigRoutes(page: Page, hits: { authDelete: string[]; configPatch: unknown[] }) {
  await page.route("**/auth/**", (route) => {
    if (route.request().method() !== "DELETE") return route.continue()
    hits.authDelete.push(new URL(route.request().url()).pathname)
    return json(route, true)
  })
  await page.route("**/global/config**", (route) => {
    const method = route.request().method()
    if (method === "PATCH") {
      hits.configPatch.push(route.request().postDataJSON())
      return json(route, { disabled_providers: route.request().postDataJSON()?.config?.disabled_providers ?? [] })
    }
    if (method === "GET") {
      return json(route, { provider: {}, disabled_providers: [] })
    }
    return route.continue()
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
  test.describe("settings dialog: tabs, gating, mobile nav", () => {
    test("General is active by default; switching tabs shows exactly one panel — behavior 1", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)
      await openSettings(page)

      await expect(tabTrigger(page, "general")).toHaveAttribute("aria-selected", "true")
      await expect(page.locator('[data-slot="tabs-content"]:not([hidden])')).toHaveCount(1)
      await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible()

      await selectTab(page, "shortcuts")
      await expect(page.locator('[data-slot="tabs-content"]:not([hidden])')).toHaveCount(1)
      await expect(page.getByRole("heading", { name: "Keyboard shortcuts", exact: true })).toBeVisible()

      await selectTab(page, "providers")
      await expect(page.locator('[data-slot="tabs-content"]:not([hidden])')).toHaveCount(1)
      await expect(page.getByRole("heading", { name: "Providers", exact: true })).toBeVisible()

      await selectTab(page, "connections")
      await expect(page.locator('[data-slot="tabs-content"]:not([hidden])')).toHaveCount(1)
      await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible()
    })

    test("the Sandbox preview flag exposes its settings tab — behavior 2", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await mockSandboxDrivers(page, { default_driver: "docker", drivers: [] }).install()
      await openWorkbench(page, DIR)
      await openSettings(page)

      await expect(tabTrigger(page, "compute")).toBeVisible()
      await selectTab(page, "compute")
      await expect(page.getByRole("heading", { name: "Sandbox Providers", exact: true })).toBeVisible()
    })

    test("mobile viewport: menu mode by default, tab selection drills into content, back returns to menu — behavior 3", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)
      // Open at the default (desktop) viewport — the rail sidebar's gear
      // button reachability under <640px is the outer shell's responsive
      // layout, not this spec's territory. Resize AFTER the
      // dialog is open so only the dialog's own `.settings-mobile-*` media
      // query (`src/claxedo-ui/claxedo-layout.css`, max-width:639px) is
      // under test.
      const dialog = await openSettings(page)
      await page.setViewportSize({ width: 375, height: 812 })

      await expect(dialog.locator(".settings-mobile-menu")).toHaveCount(1)
      await expect(dialog.locator('[data-slot="tabs-list"]')).toBeVisible()
      // NOT `:not([hidden])` (used for the desktop one-panel-at-a-time checks
      // above): Kobalte's Tabs.Content only toggles the `hidden` ATTRIBUTE on
      // the INACTIVE panels — the active panel never gets `hidden` from
      // Kobalte itself. Menu mode additionally hides the active panel too,
      // but purely via the app's own CSS class rule
      // (`.settings-mobile-menu > [data-slot="tabs-content"] { display: none
      // !important }`, `src/claxedo-ui/claxedo-layout.css`), which never
      // touches the `hidden` attribute — so `:not([hidden])` still matches
      // the (CSS-hidden) active panel and this assertion would always see 1,
      // never 0. `:visible` checks actual computed visibility instead.
      await expect(dialog.locator('[data-slot="tabs-content"]:visible')).toHaveCount(0)

      await tabTrigger(page, "shortcuts").click()
      await expect(dialog.locator(".settings-mobile-content")).toHaveCount(1)
      await expect(dialog.locator('[data-slot="tabs-list"]')).toBeHidden()
      await expect(dialog.locator(".settings-mobile-back")).toBeVisible()
      await expect(page.getByRole("heading", { name: "Keyboard shortcuts", exact: true })).toBeVisible()

      await dialog.locator(".settings-mobile-back").click()
      await expect(dialog.locator(".settings-mobile-menu")).toHaveCount(1)
      await expect(dialog.locator('[data-slot="tabs-list"]')).toBeVisible()
    })
  })

  test.describe("General: account section + sign-out", () => {
    test("runner auth mode exposes the declared account principal — behavior 33", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)

      const mode = process.env.CLAXEDO_E2E_AUTH_MODE ?? "test-user"
      const expectedLabel = mode === "local-unsigned" ? "Local workspace" : "Test User"
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

    test("account section renders for the default signed test-bypass principal, with identity + sign-out — behavior 4", async ({ page }) => {
      await stampTestAuth(page.context())
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)
      await openSettings(page)

      await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible()
      await expect(page.getByText("test@claxedo.test")).toBeVisible()
      await expect(page.getByRole("button", { name: "Log out" })).toBeVisible()
    })

    test("account section still renders for an anonymous principal, without an identity row — behavior 4", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await disableTestAuthBypass(page)
      await openWorkbench(page, DIR)
      await openSettings(page)

      await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible()
      await expect(page.getByRole("button", { name: "Log out" })).toBeVisible()
      await expect(page.getByText("test@claxedo.test")).toHaveCount(0)
    })

    // `isSignedIn()` is unconditionally true under Playwright
    // (`navigator.webdriver`), which would bounce `/login` straight back to the
    // workbench. `signOut()` therefore sets `__CLAXEDO_TEST_SIGNED_OUT__`,
    // which `testAuth()` honours to report an anonymous principal — a
    // dev/e2e-only seam in `src/platform/auth/browser-auth-test-bypass.ts`, not
    // a production behavior change.
    test("Log out signs out, purges persisted auth state, and stays on /login — behavior 5", async ({ page }) => {
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

      // The synthetic principal is now signed OUT, so `/login`'s
      // redirect-if-already-signed guard no longer bounces back to the
      // workbench — landing (and staying) on /login proves the principal is
      // anonymous (a still-signed principal would bounce to "/"). Generous
      // timeout: LoginPage is a lazily code-split route whose chunk import is
      // slow under a loaded dev server (never a wall-clock sleep).
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
    test("hovering a color scheme option live-previews, moving off cancels, selecting commits — behavior 6", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)
      await openSettings(page)

      const committedBefore = await page.evaluate(() => document.documentElement.dataset.colorScheme)

      await openSelect(page, "settings-color-scheme")
      const darkOption = selectOption(page, "Dark")
      await expect(darkOption).toBeVisible()
      // Previewing reapplies the global theme and can replace the option node
      // while a physical-pointer hover is still running. Dispatch the exact
      // pointer-enter event owned by Select instead of forcing Playwright's
      // actionability engine through that intentional replacement; the
      // resulting document scheme below remains the product-level oracle.
      await darkOption.dispatchEvent("pointerenter", { pointerType: "mouse" })
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.colorScheme)).toBe("dark")

      // Move off without selecting — closing the popover cancels the preview.
      // NOT Escape: the Settings dialog's own escape-to-close handling wins the
      // race against the popover's escape-to-dismiss, so Escape here makes the
      // select TRIGGER disappear too, i.e. it closes the whole dialog and not
      // just the popover. Clicking elsewhere in the dialog is a true outside
      // click and dismisses only the popover.
      await page.getByRole("heading", { name: "General", exact: true }).click()
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.colorScheme)).toBe(committedBefore)
      // Wait for the popover to be FULLY gone (not just the preview reverted)
      // before reopening it — reopening while its close transition is still
      // in flight is flaky.
      await expect(page.locator('[data-slot="select-select-item"]')).toHaveCount(0)

      await openSelect(page, "settings-color-scheme")
      // `{ force: true }`: same continuous-re-render churn as the hover
      // above — clicking still passes the cursor over the option first,
      // triggering the same `onHighlight` → store-write → re-render loop.
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

    test("all three notification switches toggle and write through to useSettings().notifications.* — behavior 7", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)
      await openSettings(page)

      // All THREE named switches, not just "agent" — behavior 7 names
      // agent/permissions/errors and a per-switch mis-wiring (e.g. two rows
      // bound to the same setter) is invisible if only one is exercised.
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

    test("Notification permission is requested at most once, only from enabling the toggle, never from turn completion — behavior 32", async ({ page }) => {
      await installMockNotificationApi(page)
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)

      // Agent notifications default ON (`defaultSettings.notifications.agent`,
      // src/context/settings.tsx) — turn it OFF first so the first driven
      // turn below proves the "setting off" half of the contract.
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

      // Turning the toggle ON is the ONLY point a permission request may
      // fire — assert it fires exactly once, from this click.
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
      // POSITIVE CONTROL FIRST: prove `platform.notify`'s body actually RAN
      // this time (it constructed a Notification) — otherwise the zero-new-
      // requests assertion below would be satisfied by the notify path never
      // executing at all, which is exactly the false-positive shape this test
      // exists to avoid. `installMockNotificationApi` forces the in-view
      // early-return false so the body is reachable at all.
      await expect.poll(() => notificationInstanceCount(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
      // ...and STILL exactly one permission request in total: notify read the
      // (already "granted") permission and never re-requested it.
      expect(await notificationRequestCount(page)).toBe(1)
    })

    test("update-check affordances are disabled on the web platform (no platform.checkUpdate) — behavior 8", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await openWorkbench(page, DIR)
      await openSettings(page)

      await expect(page.locator('[data-action="settings-updates-startup"] input[type="checkbox"]')).toBeDisabled()
      await expect(page.getByRole("button", { name: "Check now" })).toBeDisabled()
    })
  })

  test.describe("Shortcuts: search, rebind, conflict, reset", () => {
    test("search filters the list; a no-match query shows the empty state — behavior 9", async ({ page }) => {
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

    test("rebinding a shortcut records the next keydown as its new binding — behaviors 9,10", async ({ page }) => {
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

    test("rebinding to a combo already used elsewhere shows a conflict toast and changes nothing — behavior 11", async ({ page }) => {
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
      // On conflict the capture handler toasts and `return`s WITHOUT calling
      // `stop()` (src/components/settings-keybinds.tsx) — capture
      // mode deliberately stays active (row still reads "Press keys") so the
      // user can immediately try a different combo. NOT Escape to exit: the
      // Settings dialog has its own escape-to-close handling that wins the
      // race against the capture listener's own Escape handling (verified
      // live — pressing Escape here closes the whole dialog, not just
      // capture mode). Clicking the SAME row again is the app's other exit
      // path (`start(id)`: `if (store.active === id) { stop(); return }`,
      // same file :276-280) and doesn't touch the dialog.
      await anotherRow.click()
      await expect(anotherRow).toHaveText(beforeText ?? "")

      // The row that already OWNED the combination must still own it — the
      // other half of "leaves both bindings unchanged". Re-filter to bring the
      // palette row back into the (currently unfiltered) list.
      await page.getByPlaceholder("Search shortcuts").fill("Command Palette")
      await expect(page.locator('[data-keybind-id="command.palette"]')).toHaveText(paletteBinding ?? "")
    })

    test("Reset to defaults is disabled until an override exists, then clears overrides — behavior 12", async ({ page }) => {
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
    test("connecting a popular API-key provider PUTs credentials and marks it connected — behavior 13", async ({ page }) => {
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
      await selectTab(page, "providers")

      const harnessSection = page.locator('[data-component="harness-providers-section"]')
      await page.locator('[data-action="settings-scope-harness"]').click()
      await page.locator('[data-slot="select-select-item"][data-key="%7B%22kind%22%3A%22native%22%2C%22harnessId%22%3A%22pi%22%7D"]').click()
      await expect(harnessSection.getByText("Anthropic")).toBeVisible()
      const row = harnessSection.locator("div.border-b").filter({ hasText: "Anthropic" })
      await row.getByRole("button", { name: "Connect" }).click()

      await expect(row.getByLabel(/Anthropic API key/i)).toBeVisible()
      await row.getByLabel(/Anthropic API key/i).fill("sk-test-anthropic-key")
      await row.getByRole("button", { name: "Continue" }).click()

      await expect.poll(() => credHits.put.length, { timeout: 10_000 }).toBe(1)
      expect(credHits.put[0]).toMatchObject({ provider_id: "anthropic", kind: "api_key", secret: "sk-test-anthropic-key" })
      await expect(page.getByText("Anthropic connected")).toBeVisible()
    })

    test("an env-sourced connected provider has no Disconnect button; API-key Disconnect DELETEs credentials and engine auth — behavior 14", async ({ page }) => {
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
      const authHits = { authDelete: [] as string[], configPatch: [] as unknown[] }
      await mockAuthAndGlobalConfigRoutes(page, authHits)
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "providers")

      const harnessSection = page.locator('[data-component="harness-providers-section"]')
      await page.locator('[data-action="settings-scope-harness"]').click()
      await page.locator('[data-slot="select-select-item"][data-key="%7B%22kind%22%3A%22native%22%2C%22harnessId%22%3A%22pi%22%7D"]').click()
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
      const authHits = { authDelete: [] as string[], configPatch: [] as unknown[] }
      await mockAuthAndGlobalConfigRoutes(page, authHits)
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "providers")
      const row = page.locator('[data-component="harness-providers-section"] [data-provider="clinepass-2"]')
      await page.locator('[data-action="settings-scope-harness"]').click()
      await page.locator('[data-slot="select-select-item"][data-key="%7B%22kind%22%3A%22native%22%2C%22harnessId%22%3A%22pi%22%7D"]').click()
      await expect(row.getByText("Config", { exact: true })).toBeVisible()
      await expect(row.getByRole("button", { name: "Disconnect" })).toHaveCount(0)
      expect(authHits).toEqual({ authDelete: [], configPatch: [] })
      expect(credentialHits.delete).toEqual([])
    })

    test("provider settings do not offer the removed embedded provider registry", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await mockProviderCatalog(page, { connected: [], popular: [] })
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "providers")
      await expect(page.locator('[data-component="custom-provider-section"]')).toHaveCount(0)
    })
  })

  test.describe("Models: catalog hydration", () => {
    test("Settings Models lists every model after connected-provider detail hydration", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await mockProviderCatalog(page, {
        connected: [{
          id: "opencode",
          name: "OpenCode Zen",
          models: {
            "big-pickle": { id: "big-pickle", name: "Big Pickle" },
            "model-two": { id: "model-two", name: "Second Model" },
          },
        }],
        popular: [],
      })
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "models")
      // Settings reads under an explicit (workspace, harness); a workspace with
      // nothing remembered selects no harness and requests no catalog until one
      // is chosen (settings-scope.tsx, providers.vitest.tsx). Choose OpenCode.
      await page.locator('[data-action="settings-scope-harness"]').click()
      await page.locator('[data-slot="select-select-item"][data-key="%7B%22kind%22%3A%22native%22%2C%22harnessId%22%3A%22opencode%22%7D"]').click()

      const modelsPanel = page.locator('[data-slot="tabs-content"]:not([hidden])')
      await expect(modelsPanel.getByText("OpenCode Zen")).toBeVisible({ timeout: 15_000 })
      await expect(modelsPanel.getByRole("switch", { name: "Big Pickle" })).toBeVisible({ timeout: 15_000 })
      await expect(modelsPanel.getByRole("switch", { name: "Second Model" })).toBeVisible({ timeout: 15_000 })
    })
  })

  test.describe("Connections: status states, connect flow, OAuth polling, secret hygiene, disconnect", () => {
    test("integration rows show status chips and the right action set per status — behavior 16", async ({ page }) => {
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

    test("connecting a key-method integration POSTs /connect and reloads the list on success — behavior 17", async ({ page }) => {
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

    test("a 409 connection_exists response switches to confirm-replace instead of erroring — behavior 17", async ({ page }) => {
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

    test("an OAuth-only integration opens the URL and polls attempts until complete — behavior 18", async ({ page }) => {
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
      // The exact authorization URL the server returned was handed to
      // `window.open` — asserted BEFORE the success poll so a failure here is
      // attributed to the open step, not to polling.
      await expect
        .poll(
          () => page.evaluate(() => (window as typeof window & { __openedUrls__?: string[] }).__openedUrls__ ?? []),
          { timeout: 10_000 },
        )
        .toEqual(["http://127.0.0.1:9/oauth/authorize"])

      await expect(page.getByText("GitHub connected")).toBeVisible({ timeout: 15_000 })
      expect(mock.attemptCalls.length).toBeGreaterThanOrEqual(2)
    })

    // This cannot prove "the pasted secret is cleared from the in-memory flow":
    // `createConnectFlow` runs INSIDE the component body
    // (`src/app/dialogs/connect-integration.tsx`), so its store is per-instance
    // and dies with the component. A reopened dialog is a brand-new instance
    // with a brand-new empty store, so everything below holds identically with
    // `onCleanup(() => flow.reset())` deleted. What it does prove is that no
    // secret survives in any input's value and that nothing was sent; the
    // externally-visible half of `reset()` is pinned by the next test.
    test("closing the connect dialog leaves no secret in any input and sends nothing — behavior 19 (partial: see header)", async ({ page }) => {
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
      // NOT "the Settings dialog underneath" — verified live (a throwaway
      // reproduction polling dialog count every 100ms showed it hit 0
      // immediately and stayed there): `useDialog().show()`
      // (packages/ui/src/context/dialog.tsx) DISPOSES the entire
      // existing dialog stack before mounting the new one — it is a
      // stack-REPLACE, not a stack-PUSH (that's the separate `push()`
      // method, unused by `DialogConnectIntegration`'s call site). Opening
      // the connect dialog therefore already disposed the Settings dialog;
      // closing the connect dialog leaves NO dialog open at all, not the
      // Settings dialog one layer down. Re-verify secret hygiene by
      // reopening Settings → Connections → Connect from scratch, matching
      // what the app actually does.
      await expect(page.locator('[data-slot="dialog-container"]')).toHaveCount(0)

      await openSettings(page)
      await selectTab(page, "connections")
      await page.getByRole("button", { name: "Connect", exact: true }).click()
      const reopenedDialog = page.locator('[data-slot="dialog-container"]').last()
      const reopenedSecret = reopenedDialog.getByLabel("API secret")
      // Positive precondition: the field actually re-rendered. Without it, an
      // empty-value assertion on a locator that matched nothing is vacuous.
      await expect(reopenedSecret).toHaveCount(1)
      // `toHaveValue` reads the input's `value` PROPERTY (the only place a
      // password input's contents ever live) — a rendered-text query cannot.
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

    // The DISCRIMINATING half of behavior 19. `onCleanup(() => flow.reset())`
    // (`src/app/dialogs/connect-integration.tsx`) does two things: it clears
    // the store (unobservable — the store dies with the component either way,
    // see the test above) and it bumps `generation`, which is the ONLY thing
    // that stops `pollAttempt`'s loop
    // (`src/features/settings/ui/connections-logic.ts`). That loop is a plain
    // async function, not owned by Solid and not tied to the component's
    // lifetime, so without that cleanup it would keep issuing
    // `GET /attempts/:id` forever after the dialog is gone.
    test("closing the connect dialog mid-OAuth cancels the attempt poll loop — behavior 19", async ({ page }) => {
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

      // Prove the loop is genuinely RUNNING first — otherwise "it stopped"
      // would be satisfied by a loop that never started (the same
      // false-positive shape this test exists to close).
      await expect.poll(() => mock.attemptCalls.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)

      await dialog.locator('[data-slot="dialog-close-button"]').click()
      await expect(page.locator('[data-slot="dialog-container"]')).toHaveCount(0)

      // `pollAttempt` re-checks `generation` immediately after each
      // `await sleep(pollIntervalMs)` and again after each fetch resolves, so
      // once the cleanup has run no further request is dispatched. Let one
      // in-flight request settle, then hold an observation window several poll
      // intervals wide (pollIntervalMs defaults to 2000ms) and require the
      // counter to be perfectly flat across it. This is an absence-of-events
      // observation, which is inherently time-boxed — there is no event to
      // await for "a request that must never happen".
      await page.waitForTimeout(500)
      const afterClose = mock.attemptCalls.length
      await page.waitForTimeout(7_000)
      expect(mock.attemptCalls.length).toBe(afterClose)
    })

    test("disconnect is a two-step inline confirm; Cancel sends nothing, Confirm DELETEs — behavior 20", async ({ page }) => {
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
    test("switching provider offers 'Use for new workspaces', PUTs default, and clears — behavior 21", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      const sandbox = mockSandboxDrivers(page, {
        default_driver: "docker",
        drivers: [
          { id: "docker", label: "Docker", fields: [{ key: "token", label: "Token", secret: true }], configured: true, source: "config", default: true },
          // Configured on purpose: switching the active provider without
          // retyping a stored key is exactly what this affordance is for, and
          // it only renders for a provider that already has credentials.
          { id: "e2b", label: "E2B", fields: [{ key: "token", label: "Token", secret: true }], configured: true, source: "config", default: false },
        ],
      })
      await sandbox.install()
      await openWorkbench(page, DIR)
      await openSettings(page)
      await selectTab(page, "compute")

      const useForNew = page.getByRole("button", { name: "Use for new workspaces" })
      await expect(useForNew).toHaveCount(0)
      // Scoped to the ACTIVE tabs-content panel, not a bare `.first()`:
      // inactive `Tabs.Content` panels stay mounted (Kobalte hides them via
      // the `hidden` attribute, not removal — see the mobile-menu fix
      // above), so an unscoped `[data-slot="select-select-trigger"]` matches
      // selects from every mounted panel and `.first()`'s resolution is
      // genuinely unstable across retries (verified live: consecutive polls
      // resolved to two DIFFERENT trigger elements with different ids).
      await page.locator('[data-slot="tabs-content"]:not([hidden]) [data-slot="select-select-trigger"]').first().click()
      // `{ force: true }`: this Select's options don't settle under
      // Playwright's hover-stability check (same symptom as the
      // color-scheme popover above — verified live, "element is not
      // stable" then "element was detached from the DOM, retrying", never
      // settling within the full test timeout) — a `packages/ui` Select
      // popover behavior, not specific to this row's own `onHighlight`
      // wiring (this Select has none).
      await page.locator('[data-slot="select-select-item"]').filter({ hasText: "E2B" }).click({ force: true })

      await expect(useForNew).toBeVisible()
      await useForNew.click()

      await expect.poll(() => sandbox.putDefaultCalls.length, { timeout: 10_000 }).toBe(1)
      expect(sandbox.putDefaultCalls[0]).toMatchObject({ driver: "e2b" })
      await expect(page.getByText("Default sandbox provider updated")).toBeVisible()
      // E2B is the active provider now, so the affordance retires itself.
      await expect(useForNew).toHaveCount(0)
    })

    test("credential CRUD: Save PUTs auth, Remove DELETEs — behavior 22", async ({ page }) => {
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

    test("non-loopback base URL locks every sandbox mutation control and shows the read-only notice — behavior 23", async ({ page }) => {
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
      await expect(page.locator('[data-slot="tabs-content"]:not([hidden]) [data-slot="select-select-trigger"]').first()).toBeDisabled()
      // The credential form is always open, so the read-only lock has to reach
      // the input itself, not just the buttons around it.
      await expect(page.locator('[data-slot="tabs-content"]:not([hidden]) input[type="password"]').first()).toBeDisabled()
      await expect(page.getByRole("button", { name: "Remove" })).toBeDisabled()
    })

    test("Network Policy inside the workspace-less Sandbox tab always allows adding an entry — behavior 24", async ({ page }) => {
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
    test("already-signed visitors are redirected before Continue ever renders — behavior 25", async ({ page }) => {
      await stampTestAuth(page.context())
      await page.route("**/api/claxedo/bootstrap**", (route) =>
        json(route, {
          healthy: true,
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
      // ...and the "BEFORE Continue ever renders" half, which the URL check
      // alone says nothing about: the observer installed before the app's
      // first script never saw a Continue button attached.
      expect(await continueButtonFlashed(page)).toBe(false)
    })

    test("not-signed visitors see Continue, which triggers sign-in — behavior 25", async ({ page }) => {
      await disableTestAuthBypass(page)
      // POSITIVE CONTROL for the no-flash observer used by the signed-visitor
      // test above: the same detector, on the page where Continue DOES render,
      // must latch true. Without this pairing, that test's `toBe(false)` could
      // be passing because the observer is broken rather than because nothing
      // flashed.
      await recordContinueButtonFlash(page)
      await page.goto("/login")
      await page.waitForLoadState("domcontentloaded")
      await expect(page).toHaveURL(/\/login$/)

      const continueButton = page.getByRole("button", { name: "Continue" })
      await expect(continueButton).toBeVisible()
      expect(await continueButtonFlashed(page)).toBe(true)
      await expect(page.getByRole("link", { name: /Terms of Service/i })).toBeVisible()

      await continueButton.click()
      // No provider key in this harness ⇒ the redirect is a no-op and the button's
      // "Redirecting..." state clears within a microtask — asserting that label
      // was racy by construction on starved runners. The race-free contract is
      // that the click INVOKED sign-in, recorded by the e2e seam in
      // browser-auth-test-bypass.ts (__claxedoSignInCalls, DEV || VITE_CLAXEDO_E2E gated).
      await expect.poll(async () => (await signInCalls(page)).length).toBe(1)
      // `/login` passes its own `redirectUrl()`, which defaults to "/" — assert
      // the ARGUMENT too, not just that something was called.
      expect((await signInCalls(page))[0]?.redirectUrl).toBe("/")
    })
  })

  test.describe("/cli-login", () => {
    test("missing/invalid params are rejected immediately with zero auth calls — behavior 26", async ({ page }) => {
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

    test("a non-loopback callback origin is rejected the same way, with zero auth calls — behavior 26", async ({ page }) => {
      await page.goto("/cli-login?callback=https%3A%2F%2Fevil.example.com%2Fcb&state=abc123")
      await page.waitForLoadState("domcontentloaded")
      await expect(page.getByText("Invalid CLI sign-in callback.")).toBeVisible()
      // The security-relevant half: an attacker-supplied callback origin must
      // not even start an auth handshake. See the note above on why this zero
      // is non-vacuous.
      await expect.poll(async () => (await signInCalls(page)).length, { timeout: 3_000 }).toBe(0)
    })

    test("not-signed visitor with valid params calls signIn with the current URL as redirectUrl — behavior 27", async ({ page }) => {
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

    test("signed visitor with valid params exchanges a CLI token and auto-submits the callback form — behavior 28", async ({ page }) => {
      await stampTestAuth(page.context())
      let exchangeCalls = 0
      let exchangeAuth: string | null = null
      await page.route(
        "**/api/auth/cli/exchange",
        withCors(async (route) => {
          exchangeCalls += 1
          exchangeAuth = route.request().headers()["authorization"] ?? null
          // Real delay on the mock response (not a test-side wait — see the
          // same fix the other mocked routes use): an instant response lets the
          // whole approving→exchange→auto-submit→navigate chain finish
          // before "Approving CLI sign-in..." ever paints (verified live —
          // the assertion's own call log showed the page had ALREADY
          // navigated to the callback URL by the time it polled).
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

    test("an exchange failure surfaces the server's error message and never submits a form — behavior 29", async ({ page }) => {
      await stampTestAuth(page.context())
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

  test.describe("signed gate (CloudAuthGate)", () => {
    test("a loopback-transport session never redirects to /login, even for an anonymous principal — behavior 30", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await disableTestAuthBypass(page)
      await openWorkbench(page, DIR)

      await expect(page).not.toHaveURL(/\/login$/)
      await expect(page.getByRole("textbox", { name: /Ask anything/i }).last()).toBeVisible({ timeout: 20_000 })
    })

    // `resolveDefaultUrl()` (`src/app/entry/app.tsx`) reads
    // `window.__CLAXEDO_E2E_SERVER_URL__` in a dev/e2e build — baked out of
    // production — so a spec can force ServerProvider's resolved default (hence
    // CloudAuthGate's `server.url`) to a non-loopback host.
    test("an anonymous principal on a non-loopback transport is force-redirected to /login — behavior 30b", async ({ page }) => {
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await seedProject(page, DIR)
      await disableTestAuthBypass(page)
      // Force the resolved default server to a NON-loopback host, so
      // centralTransportForServer(server.url) !== "loopback" ⇒ needsSignedAuth().
      await page.addInitScript(() => {
        ;(window as typeof window & { __CLAXEDO_E2E_SERVER_URL__?: string }).__CLAXEDO_E2E_SERVER_URL__ =
          "https://cloud.example.test"
      })

      await page.goto(`/${slug(DIR)}/session`)
      await page.waitForLoadState("domcontentloaded")

      // Anonymous + non-loopback ⇒ the signed gate redirects to /login (a brief
      // "Loading..." placeholder shows while the session status resolves first).
      await expect(page).toHaveURL(/\/login$/, { timeout: 20_000 })
      await expect(page.getByRole("button", { name: "Continue" })).toBeVisible({ timeout: 10_000 })
    })
  })

  test.describe("error page (top-level ErrorBoundary fallback)", () => {
    // The `/__e2e/error-page?variant=` injection route
    // (`src/app/routes/error-page-harness.tsx`, dev/e2e-only) mounts the real
    // <ErrorPage> for a chosen InitError variant — the ErrorBoundary fallback
    // content without a real render-time crash.
    test("InitError variants render their formatted chain with Restart (and no Check-for-updates on web) — behavior 31", async ({ page }) => {
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

      // A different variant re-renders a distinct cause-chain through the same
      // route (proves the formatter's `Caused by:` nesting, not just one shape).
      await page.goto("/__e2e/error-page?variant=causeChain")
      await page.waitForLoadState("domcontentloaded")
      await expect(page.getByRole("textbox", { name: "Error Details" })).toHaveValue(
        /Failed to reach provider[\s\S]*Caused by:[\s\S]*socket hang up/,
      )
    })
  })
})
