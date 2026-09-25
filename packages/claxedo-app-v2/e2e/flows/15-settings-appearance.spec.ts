import { acpScriptToken, expect, SCRIPTED_ACP_HARNESS, sessionRoute, test, UI } from "../harness"
import { openSettings } from "./15-settings.navigation"

test("15 settings: Expand shell tool parts opens a turn's shell output in the transcript", async ({ stack, api, app, isMobile }) => {
  const workspace = await stack.daemon.makeWorkspace("transcript-settings")
  await stack.acp.write("shell", {
    steps: [
      { kind: "tool", tool: "execute", title: "git status", input: { command: "git status" }, text: "shell-output-clean" },
      { kind: "tool", tool: "read", title: "Read README.md", locations: [{ path: `${workspace.directory}/README.md` }], text: "readme\n" },
      { kind: "text", text: "The shell ran" },
    ],
  })
  const session = await api.createSession(workspace.directory, { title: "Shell", harness: SCRIPTED_ACP_HARNESS })
  await api.prompt(workspace.directory, session.id, `Run it. ${acpScriptToken("shell")}`)
  const route = `${stack.url}${sessionRoute(workspace.id, session.id)}`
  await app.goto(route)
  await openSettings(stack, app, isMobile)
  const toggle = app.locator('[data-action="settings-feed-shell-tool-parts-expanded"]')
  await expect(toggle.getByRole("switch")).not.toBeChecked()
  await toggle.click()
  await expect(toggle.getByRole("switch")).toBeChecked()
  await app.goto(route)
  await expect(app.getByText("The shell ran")).toBeVisible()
  await app.getByRole("button", { name: UI.workedFor }).click()
  await expect(app.getByText("shell-output-clean")).toBeVisible()
})

test("15 settings: a code font applies at once, and the files navigator side is kept", async ({ stack, app, isMobile }) => {
  const workspace = await stack.daemon.makeWorkspace("appearance-settings")
  const draft = `${stack.url}${sessionRoute(workspace.id)}`
  await app.goto(draft)
  await openSettings(stack, app, isMobile)
  await app.locator('[data-action="settings-code-font"]').first().fill("Courier New")
  await expect.poll(() => app.evaluate(() => document.documentElement.style.getPropertyValue("--font-family-mono"))).toContain('"Courier New"')
  await app.locator('[data-action="settings-navigator-side"]').first().click()
  await app.getByRole("option", { name: "Left", exact: true }).click()
  await app.goto(draft)
  await openSettings(stack, app, isMobile)
  await expect(app.locator('[data-action="settings-navigator-side"]').first()).toContainText("Left")
  await expect(app.locator('[data-action="settings-code-font"]').first()).toHaveValue("Courier New")
})
