import type { Page } from "@playwright/test"
import { expect, test, UI, type SignedStack } from "../harness"
import { hostedFetch, inviteHostedPerson } from "../../../harness/e2e/harness/hosted-auth"
import { chooseSettings, openSection } from "./15-settings.navigation"

async function colleague(signed: SignedStack, name: string) {
  const person = await signed.signUp(name)
  const orgs = await hostedFetch(signed.hosted, "/api/control/orgs", {}, signed.owner.person)
  const [{ org_id: orgId, name: orgName }] = await orgs.json() as Array<{ org_id: string; name: string }>
  const token = await inviteHostedPerson(signed.hosted, signed.owner.person, person.person, orgId)
  const accepted = await hostedFetch(signed.hosted, "/api/control/invitations/accept", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }),
  }, person.person)
  expect(accepted.status).toBe(200)
  return { orgName }
}

async function openSettings(page: Page, isMobile: boolean) {
  if (isMobile) await page.getByRole("button", { name: UI.openRail }).click()
  await chooseSettings(page)
  await expect(page.getByTestId("settings-page")).toBeVisible()
}

test("53 settings on the web: the signed-in person's organization, usage, models, connections and a project's Where it runs say only what applies on the web, at phone width too", async ({ signed, page, isMobile }, testInfo) => {
  const { orgName } = await colleague(signed, "Grace Member")
  await signed.makeWorkspace("settings-web", "Settings project")
  await signed.signIn(page, signed.owner)
  await openSettings(page, isMobile)

  await openSection(page, isMobile, "Organization")
  const org = page.getByRole("region", { name: orgName })
  await expect(page.getByText("Sign in to see your organization.", { exact: true })).toHaveCount(0)
  await expect(org.getByText(/^Your role/)).toHaveCount(0)
  const members = org.getByRole("list", { name: "Members" })
  await expect(members.getByRole("listitem")).toHaveCount(2)
  const self = members.getByRole("listitem").filter({ hasText: "Ada Owner" })
  await expect(self.getByText("You", { exact: true })).toBeVisible()
  await expect(self.getByText("Owner", { exact: true })).toBeVisible()
  await expect(members.getByRole("listitem").filter({ hasText: "Grace Member" }).getByText("Member", { exact: true })).toBeVisible()

  await openSection(page, isMobile, "Usage")
  const views = page.getByRole("group", { name: "Usage view" })
  await expect(views.getByRole("button", { name: "Usage through Claxedo" })).toHaveAttribute("aria-pressed", "true")
  await expect(views.getByRole("button", { name: "Usage limits" })).toHaveCount(0)
  await views.getByRole("button", { name: "Cloud" }).click()
  await expect(page.getByText("No cloud workspace is running.", { exact: true })).toBeVisible()
  await views.getByRole("button", { name: "Usage through Claxedo" }).click()
  await expect(page.getByText("No sessions ran through Claxedo in this period. Usage shows here once one does.", { exact: true })).toBeVisible()
  await expect(page.getByRole("group", { name: "Range" })).toBeVisible()
  await expect(page.getByRole("group", { name: "Daily usage" })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath("usage-empty.png") })

  await openSection(page, isMobile, "Models")
  await expect(page.getByText(/Scanning|sign-ins on/)).toHaveCount(0)
  await expect(page.getByText("No Claude Code account yet", { exact: true })).toBeVisible()
  const claude = page.locator("section").filter({ has: page.getByRole("heading", { level: 2, name: "Claude Code", exact: true }) }).last()
  await expect(claude.getByRole("button", { name: "Add an account" })).toHaveCount(1)
  await expect(claude.getByRole("tab")).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath("models-accountless.png") })
  await expect(page.getByText(/^(Local and cloud|Local only)$/)).toHaveCount(0)

  await openSection(page, isMobile, "Connections")
  await expect(page.getByText("Agent connections", { exact: true })).toHaveCount(0)
  await expect(page.getByText(/^(code-host|work-source|docs)$/)).toHaveCount(0)
  const integrations = page.getByRole("group", { name: "Integrations" })
  await expect(integrations.getByText(/^Lets agents .+\.$/).first()).toBeVisible()
  await expect(integrations.getByRole("button", { name: /^(Connect…|Add another…)$/ }).first()).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  await openSection(page, isMobile, "Projects")
  await page.getByRole("link", { name: /Settings project/ }).click()
  const settings = page.getByTestId("settings-page")
  await expect(settings.getByRole("heading", { name: "Settings project" })).toBeVisible()
  await expect(settings.getByRole("heading", { level: 2, name: "Settings", exact: true })).toHaveCount(0)
  const where = settings.getByRole("group", { name: "Where it runs" })
  await expect(where.getByText("settings-web", { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("project-where-it-runs.png") })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
