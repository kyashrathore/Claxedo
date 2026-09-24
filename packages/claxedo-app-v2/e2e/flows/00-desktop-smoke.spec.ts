import { acpScriptToken, assistantText, expect, SCRIPTED_ACP_HARNESS, test } from "../harness"

test("00 desktop smoke: the desktop boots the app on its embedded server and a scripted ACP turn round-trips", { tag: "@desktop" }, async ({ desktop }) => {
  const root = desktop.app === "v2" ? desktop.window.getByRole("main") : desktop.window.locator("[data-claxedo]")
  await expect(root).toBeVisible()

  const api = desktop.api
  const workspace = await desktop.makeWorkspace("desktop-smoke")
  await desktop.acp.write("desktop-smoke", { steps: [{ kind: "text", text: "Scripted hello from the desktop" }] })
  const session = await api.createSession(workspace.directory, { title: "Desktop smoke", harness: SCRIPTED_ACP_HARNESS })
  await api.prompt(workspace.directory, session.id, `Say hello. ${acpScriptToken("desktop-smoke")}`)

  expect(assistantText(await api.messages(workspace.directory, session.id))).toContain("Scripted hello from the desktop")
})
