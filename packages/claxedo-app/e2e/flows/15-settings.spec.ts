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

test("15 Connections on the desktop's local server says it offers no integrations and asks for none", { tag: "@desktop" }, async ({ desktop }) => {
  await desktop.makeWorkspace("desktop-connections", "Desk")
  const window = desktop.window
  await window.reload()
  const asked: string[] = []
  window.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/claxedo/integrations")) asked.push(request.url())
  })
  await window.getByRole("button", { name: "Settings", exact: true }).click()
  await window.getByRole("link", { name: "Connections", exact: true }).click()
  await expect(window.getByRole("heading", { level: 1, name: "Connections" })).toBeVisible()
  const group = window.getByRole("group", { name: "Integrations" })
  await expect(group.getByText("This server doesn't offer integrations.")).toBeVisible()
  await expect(group.getByText(/\b[45]\d\d\b/)).toHaveCount(0)
  expect(asked).toEqual([])
  const bootstrap = new URL("/api/claxedo/bootstrap?scope=shell", desktop.url).href
  const deployment = await window.evaluate(async (url) => ((await (await fetch(url)).json()) as { deployment?: unknown }).deployment, bootstrap)
  expect(deployment).toMatchObject({ connections: false })
})
