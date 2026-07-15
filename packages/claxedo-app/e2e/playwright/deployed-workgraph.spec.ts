/**
 * Authenticated post-deploy WorkGraph acceptance.
 *
 * This test talks to the deployed app and control plane without intercepting a
 * product route. The only request instrumentation installed by Clerk's official
 * helper targets the Clerk Frontend API to attach a short-lived testing token.
 */
import { clerk, clerkSetup, setupClerkTestingToken } from "@clerk/testing/playwright"
import { expect, test, type Locator, type Page, type Response } from "@playwright/test"

const appURL = required("CLAXEDO_APP_URL")
const controlPlaneURL = required("CLAXEDO_CONTROL_PLANE_URL")
const publishableKey = required("CLERK_PUBLISHABLE_KEY")
const smokeUser = required("WORKGRAPH_SMOKE_USER_A_ID")
const smokeEmail = required("WORKGRAPH_SMOKE_USER_A_EMAIL")
const smokeOrganization = required("WORKGRAPH_SMOKE_ORGANIZATION_A_ID")
const guardedOrigins = new Set([new URL(appURL).origin, new URL(controlPlaneURL).origin])

test.describe.serial("deployed WorkGraph", () => {
  test.beforeAll(async () => {
    await clerkSetup({ publishableKey, secretKey: required("CLERK_SECRET_KEY"), dotenv: false })
  })

  test("authenticates, persists a Stream and Task across desktop and narrow reloads, then deletes them", async ({
    page,
  }, testInfo) => {
    const pageErrors: Error[] = []
    const failedResponses: string[] = []
    const workGraphAuthorizations: string[] = []
    const recordPageError = (error: Error) => pageErrors.push(error)
    const recordNetworkResponse = (response: Response) =>
      recordResponse(response, failedResponses, workGraphAuthorizations)
    page.on("pageerror", recordPageError)
    page.on("response", recordNetworkResponse)

    await setupClerkTestingToken({ page })
    await page.goto("/", { waitUntil: "domcontentloaded" })
    expect(await page.evaluate(() => navigator.webdriver)).toBe(false)
    await installClerkForOfficialTestingHelper(page, publishableKey)
    await clerk.signIn({ page, emailAddress: smokeEmail })
    await page.evaluate(async (organization) => {
      const instance = (window as typeof window & { Clerk: BrowserClerk }).Clerk
      await instance.setActive({ organization })
      if (instance.organization?.id !== organization) {
        throw new Error(`Clerk activated ${instance.organization?.id ?? "no organization"}; expected ${organization}`)
      }
    }, smokeOrganization)

    const suffix = `${testInfo.retry}-${crypto.randomUUID()}`
    const streamTitle = `Release smoke ${suffix}`
    const taskTitle = `Verify deployed persistence ${suffix}`

    await page.goto("/workgraph", { waitUntil: "domcontentloaded" })
    await expect(page.getByRole("main", { name: "WorkGraph" })).toBeVisible()
    await page.getByRole("button", { name: "New stream" }).click()
    const create = page.getByRole("dialog", { name: "New stream" })
    await create.getByRole("textbox", { name: "What are you trying to ship?" }).fill(streamTitle)
    await create.getByRole("button", { name: "Create" }).click()
    await expect(create).toBeHidden()

    let stream = streamContainer(page, streamTitle)
    await expect(stream).toBeVisible()
    await ensureExpanded(stream, streamTitle)
    await stream.getByRole("button", { name: "Add task", exact: true }).click()
    await stream.getByRole("textbox", { name: `Add task to ${streamTitle}` }).fill(taskTitle)
    await stream.getByRole("textbox", { name: `Add task to ${streamTitle}` }).press("Enter")
    await expect(stream.getByText(taskTitle, { exact: true })).toBeVisible()

    await page.reload({ waitUntil: "domcontentloaded" })
    stream = streamContainer(page, streamTitle)
    await expect(stream).toBeVisible()
    await ensureExpanded(stream, streamTitle)
    await expect(stream.getByText(taskTitle, { exact: true })).toBeVisible()

    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload({ waitUntil: "domcontentloaded" })
    stream = streamContainer(page, streamTitle)
    await expect(page.getByRole("main", { name: "WorkGraph" })).toBeVisible()
    await expect(stream).toBeVisible()
    await ensureExpanded(stream, streamTitle)
    await expect(stream.getByText(taskTitle, { exact: true })).toBeVisible()

    await stream.getByRole("button", { name: `Delete task ${taskTitle}` }).click()
    await expect(stream.getByText(taskTitle, { exact: true })).toBeHidden()
    await stream.getByRole("button", { name: `Delete stream ${streamTitle}` }).click()
    await page.getByRole("button", { name: "Delete stream", exact: true }).click()
    await expect(page.getByText(streamTitle, { exact: true })).toBeHidden()

    expect(workGraphAuthorizations.length).toBeGreaterThan(0)
    expect(workGraphAuthorizations.every((authorization) => authorization.startsWith("Bearer "))).toBe(true)
    expect(workGraphAuthorizations.some((authorization) => authorization === "Bearer test-bypass-token")).toBe(false)
    expect(
      workGraphAuthorizations.every((authorization) => organizationClaim(authorization) === smokeOrganization),
    ).toBe(true)
    expect(workGraphAuthorizations.every((authorization) => subjectClaim(authorization) === smokeUser)).toBe(true)
    expect(pageErrors.map((error) => error.message)).toEqual([])
    expect(failedResponses).toEqual([])

    page.off("pageerror", recordPageError)
    page.off("response", recordNetworkResponse)
    await installClerkForOfficialTestingHelper(page, publishableKey)
    await clerk.signOut({ page })
  })
})

type BrowserClerk = {
  load(): Promise<void>
  setActive(input: { organization: string }): Promise<void>
  organization: { id: string } | null
}

async function installClerkForOfficialTestingHelper(page: Page, key: string) {
  const frontendApi = required("CLERK_FAPI")
  await page.addScriptTag({
    url: `https://${frontendApi}/npm/@clerk/clerk-js@5.125.10/dist/clerk.browser.js`,
  })
  await page.evaluate(async (publishableKey) => {
    const scope = window as typeof window & { Clerk: unknown }
    if (typeof scope.Clerk !== "function") throw new Error("Clerk browser constructor did not load")
    const ClerkConstructor = scope.Clerk as new (key: string) => BrowserClerk
    const instance = new ClerkConstructor(publishableKey)
    scope.Clerk = instance
    await instance.load()
  }, key)
}

function streamContainer(page: Page, title: string) {
  return page.locator(".workgraph-stream").filter({ has: page.getByText(title, { exact: true }) })
}

async function ensureExpanded(stream: Locator, title: string) {
  const disclosure = stream.getByRole("button", { name: new RegExp(`^(Expand|Collapse) ${escapeRegex(title)}$`) })
  if ((await disclosure.getAttribute("aria-expanded")) === "false") await disclosure.click()
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function recordResponse(response: Response, failed: string[], workGraphAuthorizations: string[]) {
  const url = new URL(response.url())
  if (url.origin === new URL(controlPlaneURL).origin && url.pathname.startsWith("/api/workgraph")) {
    workGraphAuthorizations.push(response.request().headers().authorization ?? "")
  }
  if (response.status() < 400 || !guardedOrigins.has(url.origin)) return
  failed.push(`${response.status()} ${response.request().method()} ${response.url()}`)
}

function organizationClaim(authorization: string) {
  const claims = jwtClaims(authorization)
  if (!claims || typeof claims !== "object" || !("org_id" in claims) || typeof claims.org_id !== "string") {
    throw new Error("WorkGraph authorization did not carry an org_id claim")
  }
  return claims.org_id
}

function subjectClaim(authorization: string) {
  const claims = jwtClaims(authorization)
  if (!("sub" in claims) || typeof claims.sub !== "string") {
    throw new Error("WorkGraph authorization did not carry a sub claim")
  }
  return claims.sub
}

function jwtClaims(authorization: string): object {
  const encoded = authorization.slice("Bearer ".length).split(".")[1]
  if (!encoded) throw new Error("WorkGraph authorization was not a JWT")
  const claims: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
  if (!claims || typeof claims !== "object") throw new Error("WorkGraph authorization carried invalid JWT claims")
  return claims
}

function required(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required for the deployed WorkGraph browser gate`)
  return value
}
