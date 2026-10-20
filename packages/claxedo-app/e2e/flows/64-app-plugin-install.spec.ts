import type { Page, TestInfo } from "@playwright/test"
import { COUNTER_PLUGIN, expect, ownersColleague, sessionCookie, test, UI, type Account, type SignedStack } from "../harness"
import { hostedFetch } from "../../../harness/e2e/harness/hosted-auth"

test.use({ signedAppPluginRegistry: true })

async function readAs(signed: SignedStack, account: Account, path: string) {
  const response = await hostedFetch(signed.hosted, path, {}, account.person)
  return { status: response.status, body: await response.json() as unknown }
}

async function openRail(page: Page, isMobile: boolean) {
  if (!isMobile) return
  const open = page.getByRole("button", { name: UI.openRail })
  if (await open.isVisible()) await open.click()
}

async function actAs(signed: SignedStack, page: Page, account: Account) {
  await page.context().clearCookies()
  await page.context().addCookies([sessionCookie(signed.url, account)])
}

function appPlugins(page: Page) {
  return page.getByRole("region", { name: "App plugins" })
}

async function openMarketplace(signed: SignedStack, page: Page) {
  await page.goto(`${signed.url}/marketplace`)
  await expect(appPlugins(page).getByRole("button", { name: COUNTER_PLUGIN.name, exact: true })).toBeVisible()
}

async function snapshot(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, { body: await page.screenshot({ path: testInfo.outputPath(`${name}.png`) }), contentType: "image/png" })
}

async function counterRow(page: Page, isMobile: boolean) {
  await openRail(page, isMobile)
  return page.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: COUNTER_PLUGIN.name, exact: true })
}

async function expectNoCounter(signed: SignedStack, page: Page, member: Account, isMobile: boolean, refusal: "plugin_not_activated" | "plugin_not_enabled") {
  await openMarketplace(signed, page)
  await expect(await counterRow(page, isMobile)).toHaveCount(0)
  await page.goto(`${signed.url}/counter`)
  await expect(page.getByTitle(COUNTER_PLUGIN.name, { exact: true })).toHaveCount(0)
  expect(await readAs(signed, member, "/api/claxedo/app-plugins")).toEqual({ status: 200, body: [] })
  expect(await readAs(signed, member, "/api/plugins/counter/count")).toEqual({ status: 404, body: { error: expect.objectContaining({ code: refusal }) } })
}

async function installAsAdmin(signed: SignedStack, page: Page, isMobile: boolean, testInfo: TestInfo) {
  await actAs(signed, page, signed.owner)
  await openMarketplace(signed, page)
  await snapshot(page, testInfo, "marketplace-app-plugins-available")
  await appPlugins(page).getByRole("button", { name: "Install", exact: true }).click()
  const drawer = page.getByRole("dialog", { name: `Install ${COUNTER_PLUGIN.name}` })
  const access = drawer.getByRole("region", { name: "What it can do" })
  await expect(access).toContainText("Runs a backend for your organization that keeps its own data")
  await expect(access).toContainText("Its backend may connect to allowed.example.com")
  await snapshot(page, testInfo, "marketplace-app-plugins-install")
  await drawer.getByRole("button", { name: "Install", exact: true }).click()
  await expect(drawer).toHaveCount(0)
  await expect(appPlugins(page).getByRole("button", { name: "Turn on", exact: true })).toBeVisible()
  await snapshot(page, testInfo, "marketplace-app-plugins-installed")
  await appPlugins(page).getByRole("button", { name: COUNTER_PLUGIN.name, exact: true }).click()
  const details = page.getByRole("complementary", { name: `${COUNTER_PLUGIN.name} details` })
  await expect(details).toContainText("Installed · off for you")
  await details.getByRole("button", { name: `More actions for ${COUNTER_PLUGIN.name}` }).click()
  await expect(page.getByRole("menuitem", { name: /Uninstall/ })).toBeVisible()
  await snapshot(page, testInfo, "marketplace-app-plugins-admin-details")
  await page.keyboard.press("Escape")
}

test("64 an organization's admin installs an app plugin from the registry, a member turns it on and counts on its page, and turning it off removes its row and its route, at phone width too", async ({ signed, page, isMobile }, testInfo) => {
  await signed.appPluginRegistry?.publish(COUNTER_PLUGIN.directory)
  const member = await ownersColleague(signed, "Grace Member")
  expect(await readAs(signed, signed.owner, "/api/claxedo/app-plugins/installed")).toEqual({ status: 200, body: [] })

  await actAs(signed, page, member)
  await expectNoCounter(signed, page, member, isMobile, "plugin_not_activated")

  await installAsAdmin(signed, page, isMobile, testInfo)
  expect(await readAs(signed, signed.owner, "/api/claxedo/app-plugins/installed")).toMatchObject({ status: 200, body: [{ id: "counter", version: "0.1.0", active: true }] })

  await actAs(signed, page, member)
  await expectNoCounter(signed, page, member, isMobile, "plugin_not_enabled")
  await openMarketplace(signed, page)
  await expect(appPlugins(page).getByRole("button", { name: "Install", exact: true })).toHaveCount(0)
  await appPlugins(page).getByRole("button", { name: "Turn on", exact: true }).click()
  const drawer = page.getByRole("dialog", { name: `Turn on ${COUNTER_PLUGIN.name}` })
  await expect(drawer.getByRole("region", { name: "What it can do" })).toContainText("Runs a backend for your organization")
  await drawer.getByRole("button", { name: "Turn on", exact: true }).click()
  await expect(appPlugins(page)).toContainText("On for you")
  await snapshot(page, testInfo, "marketplace-app-plugins-member")

  await (await counterRow(page, isMobile)).click()
  await expect(page).toHaveURL(/\/counter$/)
  const counter = page.getByTitle(COUNTER_PLUGIN.name, { exact: true }).contentFrame()
  await expect(counter.getByRole("status")).toHaveText("Count: 0")
  await counter.getByRole("button", { name: "Count", exact: true }).click()
  await expect(counter.getByRole("status")).toHaveText("Count: 1")
  expect(await readAs(signed, member, "/api/plugins/counter/count")).toMatchObject({ status: 200, body: { value: 1 } })

  await openMarketplace(signed, page)
  await appPlugins(page).getByRole("button", { name: COUNTER_PLUGIN.name, exact: true }).click()
  const details = page.getByRole("complementary", { name: `${COUNTER_PLUGIN.name} details` })
  await details.getByRole("button", { name: "Turn off", exact: true }).click()
  await expect(details).toContainText("Installed · off for you")
  await expectNoCounter(signed, page, member, isMobile, "plugin_not_enabled")
})
