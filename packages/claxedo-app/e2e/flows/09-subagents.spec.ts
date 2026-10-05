import { acpScriptToken, assistantText, expect, SCRIPTED_ACP_HARNESS, sendPrompt, sessionRoute, test } from "../harness"

test("09 subagents: a subagent link opens its transcript without a file navigator", async ({ stack, api, app, isMobile }) => {
  const workspace = await stack.daemon.makeWorkspace("subagents")
  await stack.acp.write("delegate", {
    steps: [
      { kind: "subagent", name: "researcher", task: "Find the project name", steps: [{ kind: "text", text: "The researcher found the project name" }] },
      { kind: "text", text: "The parent read the researcher's answer" },
    ],
  })
  const session = await api.createSession(workspace.directory, { title: "Delegation", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await sendPrompt(app, `Delegate the search. ${acpScriptToken("delegate")}`)
  await expect(app.getByText("The parent read the researcher's answer")).toBeVisible()

  const children = (await api.sessions(workspace.directory)).filter((row) => row.parentID === session.id)
  expect(children).toHaveLength(1)
  const chip = app.getByRole("region", { name: "Background subagents" }).getByRole("link").filter({ hasText: "Find the project name" })
  await expect(chip).toBeVisible()
  await chip.click()
  if (isMobile) {
    await expect(app.getByText("The researcher found the project name")).toBeVisible()
    await expect(app.getByRole("complementary", { name: "Workspace panel" })).not.toBeVisible()
    expect(assistantText(await api.messages(workspace.directory, children[0].id))).toContain("The researcher found the project name")
    return
  }
  const panel = app.getByRole("complementary", { name: "Workspace panel" })
  await expect(panel.getByText("The researcher found the project name")).toBeVisible()
  await expect(panel.getByTestId("workspace-navigator-overlay")).not.toBeVisible()
  await expect(panel.getByText("Subagent sessions cannot be prompted.")).toBeVisible()
  await expect(app).toHaveURL(new RegExp(`${sessionRoute(workspace.id, session.id)}$`))
  await expect(app.getByText("The parent read the researcher's answer")).toBeVisible()
  for (const navigator of ["Changes", "Files"]) {
    await panel.getByRole("button", { name: `Open ${navigator}`, exact: true }).click()
    await expect(panel.getByTestId("workspace-navigator-overlay")).toHaveAttribute("data-open", "true")
    await panel.getByRole("button", { name: "Close workspace panel", exact: true }).click()
    await chip.click()
    await expect(panel.getByText("The researcher found the project name")).toBeVisible()
    await expect(panel.getByTestId("workspace-navigator-overlay")).toHaveAttribute("data-open", "false")
    await expect(panel.getByRole("button", { name: /^Close (Files|Changes)$/ })).toHaveCount(0)
  }
  expect(assistantText(await api.messages(workspace.directory, children[0].id))).toContain("The researcher found the project name")
})
