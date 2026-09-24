import { acpScriptToken, assistantText, expect, frameType, SCRIPTED_ACP_HARNESS, test } from "../harness"

test("00 harness smoke: the stack boots, the app renders, a scripted ACP turn round-trips", async ({ stack, api, app }) => {
  const root = stack.app === "v2" ? app.getByRole("main") : app.locator("[data-claxedo]")
  await expect(root).toBeVisible()

  const workspace = await stack.daemon.makeWorkspace("smoke")
  await stack.acp.write("smoke", { steps: [{ kind: "text", text: "Scripted hello from ACP" }] })
  const stream = await stack.events(workspace.directory)
  const session = await api.createSession(workspace.directory, { title: "Harness smoke", harness: SCRIPTED_ACP_HARNESS })

  await api.prompt(workspace.directory, session.id, `Say hello. ${acpScriptToken("smoke")}`)

  const messages = await api.messages(workspace.directory, session.id)
  expect(assistantText(messages)).toContain("Scripted hello from ACP")
  await stream.waitFor((frame) => frameType(frame) === "session.idle", { label: "session.idle" })
  const health = await api.health()
  expect(health).toBeTruthy()
})
