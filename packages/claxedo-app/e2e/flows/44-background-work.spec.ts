import { assistantText, expect, installedCli, sendPrompt, sessionRoute, test, UI, watchPageWork } from "../harness"

test.skip(({ isMobile }) => isMobile, "flow 44 runs at desktop width")

test("44 a background agent keeps the session running in background, is counted under the transcript, and stops from its row", async ({ stack, api, app }) => {
  const availability = await installedCli("claude")
  test.skip(!availability.available, availability.available ? "" : availability.reason)
  const workspace = await stack.daemon.makeWorkspace("background-work", "Background")
  const model = await api.defaultModel(workspace.directory, "claude")
  const session = await api.createSession(workspace.directory, { title: "Survey", harness: { id: "claude", access: "native" }, model, permissionMode: "bypassPermissions" })
  stack.scripted.scriptTool({
    name: "Agent",
    whenPromptIncludes: "START_BACKGROUND",
    input: { description: "Background survey", prompt: "Survey the workspace slowly", subagent_type: "general-purpose", run_in_background: true },
  })
  stack.scripted.scriptTool({ name: "Bash", input: { command: "sleep 120", description: "Wait a while" } })

  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await sendPrompt(app, "START_BACKGROUND run a survey in the background")

  const rail = app.getByTestId("rail-sidebar-session-row").filter({ has: app.getByRole("button", { name: "Survey", exact: true }) })
  await expect(rail.locator("[data-sidebar-status]")).toHaveAttribute("data-sidebar-status", "background", { timeout: 60_000 })
  const line = app.locator('[data-slot="session-background-work"]')
  await expect(line).toHaveText("1 background agent running")
  await line.getByText("1 background agent running").hover()
  await expect(app.getByText("Ask Claude about this work, or ask it to stop one.")).toBeVisible()
  await expect(app.getByRole("button", { name: UI.stop, exact: true })).toHaveCount(0)
  await app.getByRole("textbox", { name: UI.composer }).click()
  await app.keyboard.type("x")
  await expect(app.getByRole("button", { name: UI.send, exact: true })).toBeEnabled()
  await app.keyboard.press("Backspace")

  const chip = app.locator('[data-component="subagent-chip"][data-subagent-role="spawn"]')
  await expect(chip).toHaveAttribute("data-status", "running")
  const reported = (await api.messages(workspace.directory, session.id)).length
  const stop = app.locator('[data-action="subagent-stop"]')
  await expect(stop).toHaveCount(1)
  const work = await watchPageWork(app, { nodes: { stopping: '[data-slot="subagent-stop-progress"]' } })
  await stop.click()
  await expect(chip).toHaveAttribute("data-status", "killed", { timeout: 60_000 })
  await expect(stop).toHaveCount(0)
  expect((await work()).added.stopping ?? 0, "Stopping… shown until the row settled").toBeGreaterThan(0)
  await expect(line).toHaveCount(0, { timeout: 60_000 })
  await expect(rail.locator('[data-sidebar-status="background"]')).toHaveCount(0)
  await expect.poll(async () => (await api.status(workspace.directory))[session.id] ?? { type: "idle" }, { timeout: 60_000 }).toEqual({ type: "idle" })
  const after = await api.messages(workspace.directory, session.id)
  expect(after.length, "Claude's turn reporting the stopped agent").toBeGreaterThan(reported)
  expect(assistantText(after.slice(reported))).toContain("ok")
})
