import { acpScriptToken, assistantText, expect, SCRIPTED_ACP_HARNESS, test } from "../harness"

test("08 a permission prompt blocks the composer until it is allowed from its dock", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("permission")
  await stack.acp.write("permission", {
    steps: [
      { kind: "permission", tool: "edit", title: "Edit notes.md", path: `${workspace.directory}/notes.md` },
      { kind: "text", text: "Edited notes.md after the permission" },
    ],
  })
  const session = await api.createSession(workspace.directory, { title: "Permission", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}/w/${workspace.id}/s/${session.id}`)
  const prompt = app.getByRole("textbox", { name: "Ask anything, / for commands, @ for context..." })
  await prompt.fill(`Edit the notes. ${acpScriptToken("permission")}`)
  await prompt.press("Enter")

  await expect(app.getByText("Permission required")).toBeVisible()
  await expect(prompt).toHaveCount(0)
  expect((await api.permissions(workspace.directory)).filter((row) => row.sessionID === session.id)).toHaveLength(1)
  await app.getByRole("button", { name: "Allow once", exact: true }).click()

  await expect(app.getByText("Edited notes.md after the permission")).toBeVisible()
  await expect(app.getByText("Permission required")).toHaveCount(0)
  await expect(prompt).toBeVisible()
  expect((await api.permissions(workspace.directory)).filter((row) => row.sessionID === session.id)).toHaveLength(0)
  expect(assistantText(await api.messages(workspace.directory, session.id))).toContain("Edited notes.md after the permission")
})

test("08 a question is answered from its dock and the agent receives the answer", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("question")
  await stack.acp.write("question", { steps: [{ kind: "question", message: "Which color should the button be?", options: ["Red", "Blue"] }] })
  const session = await api.createSession(workspace.directory, { title: "Question", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}/w/${workspace.id}/s/${session.id}`)
  const prompt = app.getByRole("textbox", { name: "Ask anything, / for commands, @ for context..." })
  await prompt.fill(`Pick a color. ${acpScriptToken("question")}`)
  await prompt.press("Enter")

  await expect(app.getByText("Which color should the button be?")).toBeVisible()
  await expect(prompt).toHaveCount(0)
  expect((await api.questions(workspace.directory)).filter((row) => row.sessionID === session.id)).toHaveLength(1)
  await app.getByRole("radio", { name: /Type your own answer/ }).click()
  await app.getByRole("textbox", { name: "Type your answer..." }).fill('{"answer":"Blue"}')
  await app.getByRole("button", { name: "Submit", exact: true }).click()

  await expect(app.getByText("Answer: Blue")).toBeVisible()
  await expect(prompt).toBeVisible()
  expect(assistantText(await api.messages(workspace.directory, session.id))).toContain("Answer: Blue")
  expect((await api.questions(workspace.directory)).filter((row) => row.sessionID === session.id)).toHaveLength(0)
})
