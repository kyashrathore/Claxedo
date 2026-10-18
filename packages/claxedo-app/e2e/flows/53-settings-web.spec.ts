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

test("53 settings on the web: the signed-in person's organization, usage limits, sandbox and AI usage, models, connections and a project's Where it runs say only what applies on the web, at phone width too", async ({ signed, page, isMobile }, testInfo) => {
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

  await openSection(page, isMobile, "Usage limits")
  await expect(page.getByText("No connected account reports a plan here.", { exact: true })).toBeVisible()
  await expect(page.getByRole("group", { name: "Usage view" })).toHaveCount(0)

  await openSection(page, isMobile, "Sandbox usage")
  const sandbox = page.getByRole("region", { name: "Sandbox usage" })
  const range = sandbox.getByRole("group", { name: "Range" })
  await expect(range.getByRole("button", { name: "30 days", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(sandbox.getByText("Last 30 days", { exact: true })).toBeVisible()
  await expect(sandbox.getByText("0 min", { exact: true })).toBeVisible()
  await expect(sandbox.getByText("$0.00", { exact: true })).toBeVisible()
  await expect(sandbox.getByText("No sandbox ran in this range.", { exact: true })).toBeVisible()
  const rangeStart = await page.evaluate(() => { const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - 29); return start.getTime() })
  const minutes = await hostedFetch(signed.hosted, `/api/claxedo/usage/machine-time?since=${rangeStart}`, {}, signed.owner.person)
  expect(await minutes.json()).toMatchObject({ since: rangeStart, activeMs: 0, running: 0, workspaces: [], providers: [] })
  await range.getByRole("button", { name: "7 days", exact: true }).click()
  await expect(sandbox.getByText("Last 7 days", { exact: true })).toBeVisible()
  await sandbox.getByRole("group", { name: "Show" }).getByRole("button", { name: "Running", exact: true }).click()
  await expect(sandbox.getByText("No sandbox is running.", { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("sandbox-usage-empty.png") })

  await openSection(page, isMobile, "AI usage")
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

  await integrations.locator('[data-integration="github"]').getByRole("button", { name: /^(Connect…|Add another…)$/ }).click()
  const connect = page.getByRole("dialog", { name: "Connect GitHub" })
  await expect(connect.getByText("Lets agents clone your repositories into cloud workspaces and read the issues you give them.", { exact: true })).toBeVisible()
  await expect(connect.getByRole("tablist")).toHaveCount(0)
  await expect(connect.getByLabel("Fine-grained personal access token")).toBeVisible()
  await expect(connect.getByRole("button", { name: "Connect", exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("connect-github.png") })
  await connect.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(connect).toHaveCount(0)

  await openSection(page, isMobile, "Projects")
  await page.getByRole("link", { name: /Settings project/ }).click()
  const settings = page.getByTestId("settings-page")
  await expect(settings.getByRole("heading", { name: "Settings project" })).toBeVisible()
  await expect(settings.getByRole("heading", { level: 2, name: "Settings", exact: true })).toHaveCount(0)
  const where = settings.getByRole("group", { name: "Where it runs" })
  await expect(where.getByText("settings-web", { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("project-where-it-runs.png") })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  const environment = settings.getByRole("group", { name: "Environment" })
  await environment.getByRole("button", { name: "Edit…" }).click()
  const drawer = page.getByRole("dialog", { name: "Environment" })
  await drawer.getByRole("textbox", { name: "Variable name" }).fill("API_URL")
  await drawer.getByLabel("Variable value", { exact: true }).fill("https://secret.example.test")
  await drawer.getByRole("button", { name: "Save" }).click()
  await expect(drawer).toHaveCount(0)
  await expect(environment.getByText("API_URL", { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath("project-environment.png") })
  const projectId = new URL(page.url()).searchParams.get("project") ?? ""
  const listed = await hostedFetch(signed.hosted, `/api/claxedo/projects/${encodeURIComponent(projectId)}/environment`, {}, signed.owner.person)
  const text = await listed.text()
  expect(JSON.parse(text)).toEqual({ names: ["API_URL"], editable: true })
  expect(text).not.toContain("secret.example.test")
})
