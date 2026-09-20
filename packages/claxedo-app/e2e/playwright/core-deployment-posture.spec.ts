/**
 * Whether the app requires a signed session is the SERVER's declaration —
 * `deployment.issuesSessions` in its bootstrap body — and nothing else.
 *
 * The three deployments this app meets cannot be told apart by anything the
 * client already holds:
 *
 *   - a desktop daemon on loopback, which authenticates by loopback and has no
 *     accounts;
 *   - a signed self-hosted node, whose embedded issuer ALSO runs on localhost,
 *     so the URL is the same one the daemon has;
 *   - the hosted central, on a public origin.
 *
 * Each test below serves one fixture at one URL and changes only the
 * declaration. The first two run against the SAME loopback server: same origin,
 * same mock, opposite outcome. That pairing is the whole point — a gate that
 * read the URL, or the bundle it was built into, cannot pass both.
 */
import { expect, test, type Page } from "@playwright/test"
import { installMockRuntime } from "../helpers/mock-runtime"

const DIR = "/tmp/e2e-core-deployment-posture"
const SESSION_ID = "ses_core_deployment_posture"
const HOSTED_ORIGIN = "https://cloud.example.test"

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function seedProject(page: Page, dir: string) {
  await page.addInitScript(
    ({ d }: { d: string }) => {
      localStorage.clear()
      ;(window as typeof window & { __CLAXEDO__?: { serverUrl?: string; activeDirectory?: string } }).__CLAXEDO__ = {
        serverUrl: window.location.origin,
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
    { d: dir },
  )
}

/** The app auto-signs-in whenever `navigator.webdriver` is true; this turns that bypass off. */
async function disableTestAuthBypass(page: Page) {
  await page.addInitScript(() => {
    ;(window as typeof window & { __CLAXEDO_DISABLE_TEST_AUTH_BYPASS__?: boolean }).__CLAXEDO_DISABLE_TEST_AUTH_BYPASS__ = true
  })
}

/**
 * Move the shell's resolved default server off loopback, the way a browser on
 * the hosted app reaches a central it is not co-located with. Read by
 * `resolveDefaultUrl()` in dev/e2e builds only.
 */
async function serveFromHostedOrigin(page: Page) {
  await page.addInitScript((origin: string) => {
    ;(window as typeof window & { __CLAXEDO_E2E_SERVER_URL__?: string }).__CLAXEDO_E2E_SERVER_URL__ = origin
  }, HOSTED_ORIGIN)
}

/**
 * Answer the declaration read with a refusal. Registered after the mock
 * runtime so it wins: Playwright matches the most recently added handler first.
 */
async function refuseTheDeclaration(page: Page, status: number) {
  await page.route("**/api/claxedo/bootstrap**", (route) =>
    route.fulfill({
      status,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ error: { code: "unavailable" } }),
    }),
  )
}

async function anonymousVisitor(page: Page, issuesSessions: boolean) {
  await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, issuesSessions })
  await seedProject(page, DIR)
  await disableTestAuthBypass(page)
}

test.describe("deployment posture is the server's declaration @core", () => {
  test("a daemon that declares it issues no sessions renders the workbench for an anonymous visitor", async ({ page }) => {
    await anonymousVisitor(page, false)

    await page.goto(`/${slug(DIR)}/session`)
    await page.waitForLoadState("domcontentloaded")

    await expect(page.getByRole("textbox", { name: /Ask anything/i }).last()).toBeVisible({ timeout: 30_000 })
    await expect(page).not.toHaveURL(/\/login$/)
  })

  // The case no URL could ever answer, and the reason this declaration exists:
  // the server below is the same loopback origin as the one above.
  test("a signed node on the SAME loopback origin sends the same visitor to /login", async ({ page }) => {
    await anonymousVisitor(page, true)

    await page.goto(`/${slug(DIR)}/session`)
    await page.waitForLoadState("domcontentloaded")

    await expect(page).toHaveURL(/\/login$/, { timeout: 30_000 })
    await expect(page.getByRole("button", { name: "Continue" })).toBeVisible({ timeout: 10_000 })
  })

  test("the hosted central on a public origin gates the same way", async ({ page }) => {
    await anonymousVisitor(page, true)
    await serveFromHostedOrigin(page)

    await page.goto(`/${slug(DIR)}/session`)
    await page.waitForLoadState("domcontentloaded")

    await expect(page).toHaveURL(/\/login$/, { timeout: 30_000 })
  })

  // The third state, and the one a two-way gate gets wrong. A rate limiter, a
  // transient 5xx, a CORS misconfiguration or an app deployed ahead of its
  // central all end the same way: the declaration cannot be read. Reading that
  // as "this server has no accounts" puts an ungated shell in front of an
  // anonymous visitor on a deployment that requires a signed session.
  test("a central that refuses the declaration holds the gate instead of rendering the shell", async ({ page }) => {
    await anonymousVisitor(page, true)
    await refuseTheDeclaration(page, 503)

    await page.goto(`/${slug(DIR)}/session`)
    await page.waitForLoadState("domcontentloaded")

    await expect(page.getByText(/Could not confirm sign-in for/)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("It refused the request (HTTP 503).")).toBeVisible()
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible()
    await expect(page.getByRole("textbox", { name: /Ask anything/i })).toHaveCount(0)
  })

  // A visitor to a machine that has no accounts is that machine's user, not an
  // unidentified one: the account menu offers no sign-in, on the same build
  // that offers one against a session-issuing central.
  test("an undeclared account surface follows the declaration too", async ({ page }) => {
    await anonymousVisitor(page, false)

    await page.goto(`/${slug(DIR)}/session`)
    await page.waitForLoadState("domcontentloaded")
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

    await page.getByTestId("rail-account-trigger").click()
    await expect(page.getByRole("menuitem", { name: "Sign in" })).toHaveCount(0)
  })
})
