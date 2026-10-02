import { expect, test } from "../harness"
import { hostedFetch, inviteHostedPerson } from "../../../harness/e2e/harness/hosted-auth"

test("48 startup: a signed account without admission sees the failure and retries after the owner invites it", async ({ signed, page }) => {
  const account = await signed.signUp("Grace Invited")
  await signed.signIn(page, account)
  const alert = page.getByRole("alert")
  await expect(alert).toContainText("Application identity mapping is unavailable")
  expect((await page.request.get(`${signed.url}/api/workspace?host=provisioner`)).status()).toBe(503)
  await page.getByRole("button", { name: "Try again", exact: true }).click()
  await expect(alert).toContainText("Application identity mapping is unavailable")
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const orgs = await hostedFetch(signed.hosted, "/api/control/orgs", {}, signed.owner.person)
  expect(orgs.status).toBe(200)
  const [{ org_id: orgId }] = await orgs.json() as Array<{ org_id: string }>
  await inviteHostedPerson(signed.hosted, signed.owner.person, account.person, orgId)
  await page.getByRole("button", { name: "Try again", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Start with a project" })).toBeVisible()
  expect((await page.request.get(`${signed.url}/api/workspace?host=provisioner`)).status()).toBe(200)
  await page.reload()
  await expect(page.getByRole("heading", { name: "Start with a project" })).toBeVisible()
})

test("48 startup: an invitation without a token explains how to recover", async ({ app, stack }) => {
  await app.goto(`${stack.url}/invitations`)
  await expect(app.getByRole("heading", { name: "Invitation link is incomplete" })).toBeVisible()
  await expect(app.getByRole("link", { name: "Continue to Claxedo" })).toHaveAttribute("href", "/")
  expect(await app.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
