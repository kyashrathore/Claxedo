import { type CliName, expect, installedCli, sessionRoute, test, UI } from "../harness"

test.skip(({ isMobile }) => isMobile, "flow 7 runs at desktop width")

const GOALS: readonly { readonly cli: CliName; readonly mode: string; readonly controls: boolean }[] = [
  { cli: "codex", mode: "native", controls: true },
  { cli: "claude", mode: "evaluated", controls: false },
]

for (const goal of GOALS) {
  test(`07 goal mode (${goal.mode}, ${goal.cli}): /goal starts a goal that the dock shows and the server records`, async ({ stack, api, app }) => {
    const availability = await installedCli(goal.cli)
    test.skip(!availability.available, availability.available ? "" : availability.reason)
    const workspace = await stack.daemon.makeWorkspace(`goal-${goal.cli}`)
    const model = await api.defaultModel(workspace.directory, goal.cli)
    const session = await api.createSession(workspace.directory, { title: `Goal ${goal.cli}`, harness: { id: goal.cli, access: "native" }, model })
    await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
    await app.getByRole("textbox", { name: UI.composer }).click()
    await app.keyboard.type("/goal")
    await app.keyboard.press("Enter")
    await expect(app.getByRole("textbox", { name: "Describe the outcome this Goal should reach" })).toBeVisible()
    await app.keyboard.type("Write GOALDONE into notes.md")
    await expect(app.getByRole("button", { name: UI.send, exact: true })).toBeEnabled()
    const release = stack.scripted.holdTextReplies("GOALDONE")
    await app.keyboard.press("Enter")

    const dock = app.getByRole("region", { name: "Goal", exact: true })
    await expect(dock).toBeVisible()
    await expect(dock).toContainText("Write GOALDONE into notes.md")
    const opened = await fetch(`${stack.url}/session/${session.id}?view=open&directory=${encodeURIComponent(workspace.directory)}`)
    const recorded = (await opened.json()).goal
    expect(JSON.stringify(recorded)).toContain("Write GOALDONE into notes.md")
    await dock.getByRole("button", { expanded: false }).click()
    if (goal.controls) {
      release()
      await dock.getByRole("button", { name: "Delete", exact: true }).click()
      const confirm = app.getByRole("dialog", { name: "Delete Goal?" })
      const remove = confirm.getByRole("button", { name: "Delete", exact: true })
      await expect(remove).toHaveAttribute("data-variant", "danger")
      await remove.click()
      await expect(dock).toHaveCount(0)
    } else {
      expect(recorded, "Claude Code offers no Goal controls").toMatchObject({ value: { capabilities: { actions: [] } } })
      await expect(dock.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0)
      release()
      await expect(dock, "Claude Code clears its native Goal once its evaluator accepts it").toHaveCount(0, { timeout: 60_000 })
    }
    const cleared = await fetch(`${stack.url}/session/${session.id}?view=open&directory=${encodeURIComponent(workspace.directory)}`)
    expect((await cleared.json()).goal).toMatchObject({ value: { goal: null } })
  })
}

test("07 a session whose harness has no Goals opens normally, with no Goal dock", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("no-goal")
  const session = await api.createSession(workspace.directory, { title: "No Goal", harness: { id: "opencode", access: "native" } })
  const opened = await fetch(`${stack.url}/session/${session.id}?view=open&directory=${encodeURIComponent(workspace.directory)}`)
  expect(opened.status).toBe(200)
  expect((await opened.json()).goal).toMatchObject({ value: { capabilities: { implemented: false }, goal: null } })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
  await expect(app.getByText("Could not load this session")).toHaveCount(0)
  await expect(app.getByRole("region", { name: "Goal", exact: true })).toHaveCount(0)
})
