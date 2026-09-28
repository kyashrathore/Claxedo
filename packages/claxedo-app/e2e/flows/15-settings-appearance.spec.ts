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
  await openSettings(app, isMobile)
  const toggle = app.locator('[data-action="settings-feed-shell-tool-parts-expanded"]')
  await expect(toggle.getByRole("switch")).not.toBeChecked()
  await toggle.click()
  await expect(toggle.getByRole("switch")).toBeChecked()
  await app.goto(route)
  await expect(app.getByText("The shell ran")).toBeVisible()
  await app.getByRole("button", { name: UI.workedFor }).click()
  await expect(app.getByText("shell-output-clean")).toBeVisible()
})

test("15 settings: a fresh profile wears Codex at light contrast 80 and dark contrast 40, and a moved slider is kept", async ({ stack, app, isMobile }) => {
  const workspace = await stack.daemon.makeWorkspace("appearance-defaults")
  const draft = `${stack.url}${sessionRoute(workspace.id)}`
  const contrast = (scheme: "light" | "dark") => app.evaluate((name) => document.documentElement.style.getPropertyValue(name), `--claxedo-contrast-${scheme}`)
  await app.goto(draft)
  await openSettings(app, isMobile)
  await expect(app.locator('[data-action="settings-theme"]').first()).toContainText("Codex")
  const light = app.getByRole("slider", { name: "Light contrast" })
  await expect(light).toHaveValue("80")
  await expect(app.getByRole("slider", { name: "Dark contrast" })).toHaveValue("40")
  expect([await contrast("light"), await contrast("dark")]).toEqual(["80", "40"])
  await light.focus()
  await app.keyboard.press("ArrowLeft")
  await expect(light).toHaveValue("79")
  await app.goto(draft)
  await openSettings(app, isMobile)
  await expect(light).toHaveValue("79")
  expect([await contrast("light"), await contrast("dark")]).toEqual(["79", "40"])
})

test("15 settings: a code font applies at once, and the files navigator side is kept", async ({ stack, app, isMobile }) => {
  const workspace = await stack.daemon.makeWorkspace("appearance-settings")
  const draft = `${stack.url}${sessionRoute(workspace.id)}`
  await app.goto(draft)
  await openSettings(app, isMobile)
  await app.locator('[data-action="settings-code-font"]').first().fill("Courier New")
  await expect.poll(() => app.evaluate(() => document.documentElement.style.getPropertyValue("--font-family-mono"))).toContain('"Courier New"')
  await app.locator('[data-action="settings-navigator-side"]').first().click()
  await app.getByRole("option", { name: "Left", exact: true }).click()
  await app.goto(draft)
  await openSettings(app, isMobile)
  await expect(app.locator('[data-action="settings-navigator-side"]').first()).toContainText("Left")
  await expect(app.locator('[data-action="settings-code-font"]').first()).toHaveValue("Courier New")
})
