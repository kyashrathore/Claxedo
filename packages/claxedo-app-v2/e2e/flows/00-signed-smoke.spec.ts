import { acpScriptToken, assistantText, expect, SCRIPTED_ACP_HARNESS, test, UI } from "../harness"

test("00 signed smoke: a turn runs as the signed owner, who signs in through /login and finds it", async ({ signed, page, isMobile }) => {
  expect((await fetch(new URL("/api/claxedo/projects", signed.stack.url))).status).toBe(401)
  const workspace = await signed.makeWorkspace("signed", "Signed")
  await signed.stack.acp.write("hello", { steps: [{ kind: "text", text: "Signed hello" }] })
  const session = await signed.owner.api.createSession(workspace.directory, { title: "Signed turn", harness: SCRIPTED_ACP_HARNESS })
  await signed.owner.api.prompt(workspace.directory, session.id, `Say hello. ${acpScriptToken("hello")}`)
  expect(assistantText(await signed.owner.api.messages(workspace.directory, session.id))).toContain("Signed hello")

  await signed.signIn(page, signed.owner)
  if (isMobile) await page.getByRole("button", { name: UI.openRail }).click()
  await expect(page.getByRole("button", { name: signed.owner.name, exact: true })).toBeVisible()
  await expect(page.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: "Signed turn" })).toBeVisible()
})
