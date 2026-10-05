import { expect, makeCloudWorkspace, signInDesktop, test, UI, type Account } from "../harness"

type Consent = { clientId?: string; client_id?: string }

async function consentedClients(account: Account, url: string) {
  const reply = await account.transport({ method: "GET", url: `${url}/api/auth/oauth2/get-consents` })
  if (reply.status !== 200) throw new Error(`Reading the owner's consents failed: ${reply.status} ${reply.body}`)
  return (JSON.parse(reply.body) as Consent[]).map((consent) => consent.clientId ?? consent.client_id)
}

test("21 desktop sign-in: main signs in through the system browser, the card names the account, the account's cloud and machine workspaces join the rail, and log out ends it", { tag: "@desktop" }, async ({ signedCloud: signed, signedDesktop, page }) => {
  await signed.makeWorkspace("remote-app", "Remote App")
  await makeCloudWorkspace(signed, "main")
  await signedDesktop.makeWorkspace("local-app", "Local App")
  const window = signedDesktop.window
  await window.reload()
  const rail = window.getByRole("navigation", { name: UI.rail })
  const machineProject = rail.getByText("Remote App")
  const cloudProject = rail.getByText("main", { exact: true })
  await expect(rail.getByText("Local App")).toBeVisible()
  await expect(machineProject).toHaveCount(0)
  await expect(cloudProject).toHaveCount(0)

  const authorize = await signInDesktop(signed, signedDesktop, page)
  expect(new URL(authorize).origin).toBe(signed.url)

  const card = window.getByRole("button", { name: signed.owner.name, exact: true })
  await expect(machineProject).toBeVisible()
  await expect(cloudProject).toBeVisible()
  await expect(rail.getByText("Local App")).toBeVisible()
  expect(await consentedClients(signed.owner, signed.hosted.workerUrl)).toContain("claxedo-desktop")

  await card.click()
  await window.getByRole("menuitem", { name: "Log out" }).click()
  await expect(window.getByRole("button", { name: UI.signInAccount, exact: true })).toBeVisible()
  await expect(machineProject).toHaveCount(0)
  await expect(cloudProject).toHaveCount(0)
  await expect(rail.getByText("Local App")).toBeVisible()
})

test("21 desktop account switch: a draft written signed in as one account is gone once it logs out, and the next account starts with an empty draft", { tag: "@desktop" }, async ({ signedCloud: signed, signedDesktop, page }) => {
  const colleague = await signed.signUp("Grace Colleague")
  await signedDesktop.makeWorkspace("switch-app", "Switch App")
  const window = signedDesktop.window
  await window.reload()
  await signInDesktop(signed, signedDesktop, page)
  const prompt = window.getByRole("textbox", { name: UI.composer })
  await prompt.fill("Only in Ada's draft")

  const logOut = async (name: string) => {
    await window.getByRole("button", { name, exact: true }).click()
    await window.getByRole("menuitem", { name: "Log out" }).click()
    await expect(window.getByRole("button", { name: UI.signInAccount, exact: true })).toBeVisible()
  }
  await logOut(signed.owner.name)
  await expect(prompt).toHaveText("")

  await signInDesktop(signed, signedDesktop, page, colleague)
  await expect(prompt).toHaveText("")
  await prompt.fill("Only in Grace's draft")
  await logOut(colleague.name)
  await expect(prompt).toHaveText("")
})
