import { acpScriptToken, assistantText, expect, SCRIPTED_ACP_HARNESS, sessionRoute, test, UI, uncovered } from "../harness"

test("08 question and permission docks share an overlay that keeps the transcript end in view without resizing it", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("dock-overlay")
  await stack.acp.write("dock-history", {
    steps: [{ kind: "text", text: Array.from({ length: 70 }, (_, index) => `Earlier paragraph ${index + 1}.`).join("\n\n") }],
  })
  const session = await api.createSession(workspace.directory, { title: "Dock overlay", harness: SCRIPTED_ACP_HARNESS })
  await api.prompt(workspace.directory, session.id, `Write the history. ${acpScriptToken("dock-history")}`)
  await stack.acp.write("dock-requests", {
    steps: [
      { kind: "question", message: "Which color should the notes use?", options: ["Red", "Blue"] },
      { kind: "permission", tool: "edit", title: "Edit notes.md", path: `${workspace.directory}/notes.md` },
      { kind: "text", text: "Used the answer and the permission." },
    ],
  })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
  await api.promptAsync(workspace.directory, session.id, `Update the notes. ${acpScriptToken("dock-requests")}`)
  await expect(app.getByText("Which color should the notes use?")).toBeVisible()
  const lastLine = app.getByText(`Update the notes. ${acpScriptToken("dock-requests")}`, { exact: true })
  const scroller = app.getByRole("region", { name: "scrollable content" })
  const viewport = await scroller.boundingBox()
  await expect.poll(() => uncovered(lastLine)).toBe(true)
  await app.getByRole("button", { name: "Collapse question", exact: true }).click()
  await expect(app.getByRole("button", { name: "Expand question", exact: true })).toBeVisible()
  expect(await scroller.boundingBox()).toEqual(viewport)
  await expect.poll(() => uncovered(lastLine)).toBe(true)
  await app.getByRole("button", { name: "Expand question", exact: true }).click()
  await expect(app.getByRole("radio", { name: /Type your own answer/ })).toBeVisible()
  expect(await scroller.boundingBox()).toEqual(viewport)
  await expect.poll(() => uncovered(lastLine)).toBe(true)
  await scroller.hover()
  await app.mouse.wheel(0, -100_000)
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0)
  await app.getByRole("button", { name: "Collapse question", exact: true }).click()
  await expect(app.getByRole("button", { name: "Expand question", exact: true })).toBeVisible()
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0)
  await app.getByRole("button", { name: "Expand question", exact: true }).click()
  await expect(app.getByRole("radio", { name: /Type your own answer/ })).toBeVisible()
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0)
  await scroller.hover()
  await app.mouse.wheel(0, 100_000)
  await expect.poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2)
  await app.getByRole("radio", { name: /Type your own answer/ }).click()
  await app.getByRole("textbox", { name: "Type your answer..." }).fill('{"answer":"Blue"}')
  await app.getByRole("button", { name: "Submit", exact: true }).click()
  await expect(app.getByText("Permission required")).toBeVisible()
  expect(await scroller.boundingBox()).toEqual(viewport)
  await expect.poll(() => uncovered(lastLine)).toBe(true)
  await expect(app.getByRole("textbox", { name: UI.composer })).toHaveCount(0)
  await app.getByRole("button", { name: "Allow once", exact: true }).click()
  await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
  await expect(app.getByText("Used the answer and the permission.")).toBeVisible()
  expect(await scroller.boundingBox()).toEqual(viewport)
  expect(assistantText(await api.messages(workspace.directory, session.id))).toContain("Used the answer and the permission.")
})
