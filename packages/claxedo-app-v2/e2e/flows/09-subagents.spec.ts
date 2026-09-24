import { acpScriptToken, assistantText, expect, SCRIPTED_ACP_HARNESS, test } from "../harness"

test.skip(({ isMobile }) => isMobile, "flow 9 runs at desktop width")

test("09 subagents: a subagent the agent creates opens in its own pane and leads back to its parent", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("subagents")
  await stack.acp.write("delegate", {
    steps: [
      { kind: "subagent", name: "researcher", task: "Find the project name", steps: [{ kind: "text", text: "The researcher found the project name" }] },
      { kind: "text", text: "The parent read the researcher's answer" },
    ],
  })
  const session = await api.createSession(workspace.directory, { title: "Delegation", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}/w/${workspace.id}/s/${session.id}`)
  const prompt = app.getByRole("textbox", { name: "Ask anything, / for commands, @ for context..." })
  await prompt.fill(`Delegate the search. ${acpScriptToken("delegate")}`)
  await prompt.press("Enter")
  await expect(app.getByText("The parent read the researcher's answer")).toBeVisible()

  const children = (await api.sessions(workspace.directory)).filter((row) => row.parentID === session.id)
  expect(children).toHaveLength(1)
  const chip = app.getByRole("region", { name: "Background subagents" }).getByRole("link").filter({ hasText: "Find the project name" })
  await expect(chip).toBeVisible()
  await chip.click()
  await expect(app).toHaveURL(new RegExp(`/s/${children[0]!.id}$`))
  await expect(app.getByText("The researcher found the project name")).toBeVisible()
  await expect(app.getByText("Subagent sessions cannot be prompted.")).toBeVisible()

  await app.getByRole("button", { name: "Back to main session." }).click()
  await expect(app).toHaveURL(new RegExp(`/s/${session.id}$`))
  await expect(app.getByText("The parent read the researcher's answer")).toBeVisible()
  expect(assistantText(await api.messages(workspace.directory, children[0]!.id))).toContain("The researcher found the project name")
})
