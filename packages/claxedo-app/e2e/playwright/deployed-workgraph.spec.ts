/**
 * Authenticated post-deploy WorkGraph acceptance.
 *
 * This test talks to the deployed app and control plane without intercepting a
 * product route. The only request instrumentation installed by Clerk's official
 * helper targets the Clerk Frontend API to attach a short-lived testing token.
 */
import { clerk, clerkSetup } from "@clerk/testing/playwright"
import { expect, test, type Page, type Response } from "@playwright/test"

const appURL = required("CLAXEDO_APP_URL")
const controlPlaneURL = required("CLAXEDO_CONTROL_PLANE_URL")
const publishableKey = required("CLERK_PUBLISHABLE_KEY")
const smokeUser = required("WORKGRAPH_SMOKE_USER_A_ID")
const smokeEmail = required("WORKGRAPH_SMOKE_USER_A_EMAIL")
const smokeOrganization = required("WORKGRAPH_SMOKE_ORGANIZATION_A_ID")
const smokeRepositoryURL = required("WORKGRAPH_SMOKE_REPOSITORY_URL")
const smokeBaseRevision = required("WORKGRAPH_SMOKE_BASE_REVISION")
const guardedOrigins = new Set([new URL(appURL).origin, new URL(controlPlaneURL).origin])

test.describe.serial("deployed WorkGraph", () => {
  test.beforeAll(async () => {
    await clerkSetup({ publishableKey, secretKey: required("CLERK_SECRET_KEY"), dotenv: false })
  })

  test("authenticates, persists a Stream and Task across desktop and narrow reloads, then deletes them", async ({
    page,
  }, testInfo) => {
    // Stream deletion is durable: the command marks the record and the
    // every-minute reconcile lane finalizes it, so the card disappears within
    // the cron cadence plus one live-sync window rather than instantly.
    testInfo.setTimeout(360_000)
    const pageErrors: Error[] = []
    const failedResponses: string[] = []
    const workGraphAuthorizations: string[] = []
    const recordPageError = (error: Error) => pageErrors.push(error)
    const recordNetworkResponse = (response: Response) =>
      recordResponse(response, failedResponses, workGraphAuthorizations)
    page.on("pageerror", recordPageError)
    page.on("response", recordNetworkResponse)

    await page.addInitScript(() => {
      const scope = window as typeof window & { __CLAXEDO_CLERK_TESTING__?: boolean }
      scope.__CLAXEDO_CLERK_TESTING__ = true
    })
    await page.goto("/", { waitUntil: "domcontentloaded" })
    expect(await page.evaluate(() => navigator.webdriver)).toBe(false)
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
    await create.getByRole("button", { name: "Local worktree" }).click()
    await page.getByText("Cloud workspace", { exact: true }).click()
    await create.getByRole("textbox", { name: "GitHub repository URL" }).fill(smokeRepositoryURL)
    await create.getByRole("combobox", { name: /^Base revision/ }).fill(smokeBaseRevision)
    await expect(create.getByRole("button", { name: "Create" })).toBeEnabled()
    await create.getByRole("button", { name: "Create" }).click()
    await expect(create).toBeHidden()

    let stream = streamContainer(page, streamTitle)
    await expect(stream).toBeVisible()
    await stream.getByRole("button", { name: "Add task", exact: true }).click()
    await stream.getByRole("textbox", { name: `Add task to ${streamTitle}` }).fill(taskTitle)
    await stream.getByRole("textbox", { name: `Add task to ${streamTitle}` }).press("Enter")
    await expect(stream.getByText(taskTitle, { exact: true })).toBeVisible()

    await page.reload({ waitUntil: "domcontentloaded" })
    stream = streamContainer(page, streamTitle)
    await expect(stream).toBeVisible()
    await expect(stream.getByText(taskTitle, { exact: true })).toBeVisible()

    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload({ waitUntil: "domcontentloaded" })
    stream = streamContainer(page, streamTitle)
    await expect(page.getByRole("main", { name: "WorkGraph" })).toBeVisible()
    await expect(stream).toBeVisible()
    await expect(stream.getByText(taskTitle, { exact: true })).toBeVisible()

    await stream.getByRole("button", { name: `Delete task ${taskTitle}` }).click()
    await expect(stream.getByText(taskTitle, { exact: true })).toBeHidden()
    await stream.getByRole("button", { name: `Delete stream ${streamTitle}` }).click()
    await page.getByRole("button", { name: "Delete stream", exact: true }).click()
    // The portaled confirmation popover repeats the title while it closes, so
    // assert on the stream card itself rather than any text occurrence. The
    // card clears once the reconcile lane finalizes the durable deletion.
    await expect(streamContainer(page, streamTitle)).toBeHidden({ timeout: 150_000 })

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
    await clerk.signOut({ page })
  })
})

type BrowserClerk = {
  loaded: boolean
  setActive(input: { organization: string }): Promise<void>
  organization: { id: string } | null
}

function streamContainer(page: Page, title: string) {
  return page.getByRole("article", { name: `Stream ${title}` })
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
