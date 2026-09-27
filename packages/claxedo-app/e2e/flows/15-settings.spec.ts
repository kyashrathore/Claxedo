import { expect, expectNothingAnimating, sessionRoute, test, UI } from "../harness"
import { choose, leaveSettings, openSection, openSettings, picker, SECTIONS } from "./15-settings.navigation"

test("15 settings: color scheme, a rebound shortcut and its reset, every section", async ({ stack, app, isMobile }) => {
  const workspace = await stack.daemon.makeWorkspace("settings", "Settings")
  const draft = `${stack.url}${sessionRoute(workspace.id)}`
  await app.goto(draft)
  await openSettings(app, isMobile)
  const html = app.locator("html")
  await expect(html).toHaveAttribute("data-theme", "codex")
  await expect(picker(app, "Theme")).toHaveText("Codex")
  await choose(app, "Color scheme", "Dark")
  await expect(html).toHaveAttribute("data-color-scheme", "dark")
  await app.goto(draft)
  await expect(html).toHaveAttribute("data-color-scheme", "dark")
  await openSettings(app, isMobile)
  await expect(picker(app, "Color scheme")).toHaveText("Dark")
  await choose(app, "Color scheme", "Light")
  await expect(html).toHaveAttribute("data-color-scheme", "light")

  await openSection(app, isMobile, "Keyboard shortcuts")
  const reset = app.getByRole("button", { name: "Reset to defaults" })
  const binding = app.locator('[data-keybind-id="command.palette"]')
  const original = (await binding.textContent()) ?? ""
  await expect(reset).toBeDisabled()
  await binding.click()
  await expect(binding).toHaveText("Press keys")
  await app.keyboard.press("ControlOrMeta+Alt+KeyK")
  await expect(binding).not.toHaveText("Press keys")
  await expect(binding).not.toHaveText(original)
  const rebound = (await binding.textContent()) ?? ""
  await expect(reset).toBeEnabled()

  await app.goto(draft)
  await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
  const palette = app.getByRole("dialog", { name: UI.palette })
  await app.keyboard.press("ControlOrMeta+Shift+KeyP")
  await expect(palette).toHaveCount(0)
  await app.keyboard.press("ControlOrMeta+Alt+KeyK")
  await expect(palette).toBeVisible()
  await app.keyboard.press("Escape")
  await expect(palette).toHaveCount(0)
  await openSettings(app, isMobile)
  await openSection(app, isMobile, "Keyboard shortcuts")
  await expect(binding).toHaveText(rebound)
  await reset.click()
  await expect(app.getByText("Shortcuts reset")).toBeVisible()
  await expect(binding).toHaveText(original)
  await expect(reset).toBeDisabled()

  for (const section of SECTIONS) {
    await openSection(app, isMobile, section)
    expect(await app.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }

  await app.goto(draft)
  await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
  await app.keyboard.press("ControlOrMeta+Shift+KeyP")
  await expect(palette).toBeVisible()
})

test("15 settings opened and closed again leave nothing animating", async ({ stack, app, isMobile }) => {
  const workspace = await stack.daemon.makeWorkspace("settings", "Settings")
  await app.goto(`${stack.url}${sessionRoute(workspace.id)}`)
  await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
  await openSettings(app, isMobile)
  await expectNothingAnimating(app)
  await leaveSettings(app, isMobile)
  await expectNothingAnimating(app)
})
