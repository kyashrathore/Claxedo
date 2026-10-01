import { acpScriptToken, assistantText, expect, SCRIPTED_ACP_HARNESS, test, UI } from "../harness"

test("00 signed smoke: a signed-out reader is sent to /login; the owner signs in, opens their turn and logs out", async ({ signed, page, isMobile }) => {
  test.skip(true, "a browser signed in to the hosted Worker lists no projects until goal/web-hosted-account gives it the account's project source")
  expect((await page.request.get(`${signed.url}/api/workspace?host=provisioner`)).status()).toBe(401)
  const workspace = await signed.makeWorkspace("signed", "Signed")
  await signed.local.acp.write("hello", { steps: [{ kind: "text", text: "Signed hello" }] })
  const session = await signed.owner.api.createSession(workspace.directory, { title: "Signed turn", harness: SCRIPTED_ACP_HARNESS })
  await signed.owner.api.prompt(workspace.directory, session.id, `Say hello. ${acpScriptToken("hello")}`)
  expect(assistantText(await signed.owner.api.messages(workspace.directory, session.id))).toContain("Signed hello")

  await page.goto(`${signed.url}/`)
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole("textbox", { name: "Email" })).toBeVisible()

  await signed.signIn(page, signed.owner)
  if (isMobile) await page.getByRole("button", { name: UI.openRail }).click()
  const rail = page.getByRole("navigation", { name: UI.rail })
  await expect(page.getByRole("button", { name: signed.owner.name, exact: true })).toBeVisible()
  await rail.getByRole("button", { name: "Signed turn" }).click()
  await expect(page.getByText("Signed hello")).toBeVisible()

  if (isMobile) await page.getByRole("button", { name: UI.openRail }).click()
  await page.getByRole("button", { name: signed.owner.name, exact: true }).click()
  await page.getByRole("menuitem", { name: "Log out" }).click()
  await expect(page).toHaveURL(/\/login$/)
})
