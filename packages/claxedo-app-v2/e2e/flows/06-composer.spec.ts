import { fileURLToPath } from "node:url"
import { acpScriptToken, expect, SCRIPTED_ACP_HARNESS, test } from "../harness"

const IMAGE = fileURLToPath(new URL("../../public/web-app-manifest-192x192.png", import.meta.url))
const IMAGE_NAME = "web-app-manifest-192x192.png"

test("06 composer: a marked image, an @file pill and a slash command popover all reach the sent prompt", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("composer")
  await stack.acp.write("ack", { steps: [{ kind: "text", text: "Received the attachments" }] })
  const session = await api.createSession(workspace.directory, { title: "Composer", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}/w/${workspace.id}/s/${session.id}`)
  const prompt = app.getByRole("textbox", { name: "Prompt" })

  await prompt.click()
  await app.keyboard.type("/")
  await expect(app.getByRole("listbox", { name: "Commands" })).toBeVisible()
  await app.keyboard.press("Escape")
  await expect(app.getByRole("listbox", { name: "Commands" })).toHaveCount(0)
  await app.keyboard.press("Backspace")

  const chooser = app.waitForEvent("filechooser")
  await app.getByRole("button", { name: "Add", exact: true }).click()
  await app.getByRole("menuitem", { name: /Images and files/ }).click()
  await (await chooser).setFiles(IMAGE)
  await app.getByRole("button", { name: "Mark up image" }).click()
  const dialog = app.getByRole("dialog", { name: "Mark up image" })
  const picture = await dialog.getByRole("img", { name: IMAGE_NAME }).boundingBox()
  if (!picture) throw new Error("The image to mark has no box")
  await app.mouse.move(picture.x + picture.width * 0.2, picture.y + picture.height * 0.2)
  await app.mouse.down()
  await app.mouse.move(picture.x + picture.width * 0.6, picture.y + picture.height * 0.6, { steps: 6 })
  await app.mouse.up()
  const comment = dialog.getByRole("textbox")
  await comment.fill("the logo corner")
  await comment.press("Enter")
  await dialog.getByRole("button", { name: "Save", exact: true }).click()
  await expect(dialog).toHaveCount(0)

  await prompt.click()
  await app.keyboard.type("Look at @READ")
  await app.getByRole("option", { name: "README.md" }).click()
  await app.keyboard.type(` ${acpScriptToken("ack")}`)
  await app.keyboard.press("Enter")

  await expect(app.getByText("Received the attachments")).toBeVisible()
  const messages = await api.messages(workspace.directory, session.id)
  const sent = JSON.stringify(messages.find((message) => message.info.role === "user")?.parts ?? [])
  expect(sent).toContain("image/png")
  expect(sent).toContain("README.md")
  expect(sent).toContain("the logo corner")
})
