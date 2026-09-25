import { expect, signInDesktop, test, UI, type Account } from "../harness"

type Consent = { clientId?: string; client_id?: string }

async function consentedClients(account: Account, url: string) {
  const reply = await account.transport({ method: "GET", url: `${url}/api/auth/oauth2/get-consents` })
  if (reply.status !== 200) throw new Error(`Reading the owner's consents failed: ${reply.status} ${reply.body}`)
  return (JSON.parse(reply.body) as Consent[]).map((consent) => consent.clientId ?? consent.client_id)
}

test("21 desktop sign-in: main signs in through the system browser, the card names the account, the account's workspace joins the rail, and log out ends it", { tag: "@desktop" }, async ({ signed, signedDesktop, page }) => {
  await signed.makeWorkspace("remote-app", "Remote App")
  await signedDesktop.makeWorkspace("local-app", "Local App")
  const window = signedDesktop.window
  await window.reload()
  const rail = window.getByRole("navigation", { name: UI.rail })
  await expect(rail.getByText("Local App")).toBeVisible()
  await expect(rail.getByText("Remote App")).toHaveCount(0)

  const authorize = await signInDesktop(signed, signedDesktop, page)
  expect(new URL(authorize).origin).toBe(signed.url)

  const card = window.getByRole("button", { name: signed.owner.name, exact: true })
  await expect(rail.getByText("Remote App")).toBeVisible()
  await expect(rail.getByText("Local App")).toBeVisible()
  expect(await consentedClients(signed.owner, signed.stack.url)).toContain("claxedo-desktop")

  await card.click()
  await window.getByRole("menuitem", { name: "Log out" }).click()
  await expect(window.getByRole("button", { name: "Sign in", exact: true })).toBeVisible()
  await expect(rail.getByText("Remote App")).toHaveCount(0)
  await expect(rail.getByText("Local App")).toBeVisible()
})
