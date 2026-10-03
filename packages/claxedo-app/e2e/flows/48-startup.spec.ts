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

test("48 startup: an approved device sign-in returns to Claxedo; a denied one stays denied", async ({ signed, page }) => {
  await signed.signIn(page, signed.owner)
  const descriptor = await page.request.get(`${signed.url}/api/claxedo/auth/descriptor`)
  expect(descriptor.status()).toBe(200)
  const cli = (await descriptor.json() as { native: { cli: { clientId: string; scopes: string[]; resource: string } } }).native.cli
  const grant = async () => {
    const response = await page.request.post(`${signed.url}/api/auth/device/code`, { headers: { origin: signed.url }, data: { client_id: cli.clientId, scope: cli.scopes.join(" "), resource: cli.resource } })
    expect(response.status(), await response.text()).toBe(200)
    return (await response.json() as { user_code: string }).user_code
  }
  const approved = await grant()
  await page.goto(`${signed.url}/device?user_code=${approved}`)
  await page.getByRole("button", { name: "Approve", exact: true }).click()
  await expect(page).not.toHaveURL(/\/device/)
  const approval = await page.request.get(`${signed.url}/api/auth/device?user_code=${approved}`)
  expect((await approval.json() as { status: string }).status).toBe("approved")
  await page.goto(`${signed.url}/device?user_code=${approved}`)
  await expect(page).not.toHaveURL(/\/device/)
  const denied = await grant()
  await page.goto(`${signed.url}/device?user_code=${denied}`)
  await page.getByRole("button", { name: "Deny", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Device denied", exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("heading", { name: "Device denied", exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
