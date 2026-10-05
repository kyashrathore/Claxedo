import { expect, interceptSystemBrowser, test } from "../harness"
import { chooseSettings } from "./15-settings.navigation"

const PLUGINS_REPOSITORY = "https://github.com/kyashrathore/plugins"

for (const renderer of ["file", "http"] as const) {
  test.describe(`${renderer} renderer`, () => {
    test.use({ desktopRenderer: renderer })

    test("42 desktop links: settings rows and Back stay in the app, an external link opens in the system browser", { tag: "@desktop" }, async ({ desktop }) => {
      const browser = await interceptSystemBrowser(desktop.electron)
      await desktop.makeWorkspace("desktop-links", "Links")
      const window = desktop.window
      await window.reload()
      const document = window.url()

      await chooseSettings(window)
      for (const section of ["Keyboard shortcuts", "Appearance"]) {
        await window.getByRole("link", { name: section, exact: true }).click()
        await expect(window.getByRole("heading", { level: 1, name: section })).toBeVisible()
      }
      await window.getByRole("link", { name: "Models", exact: true }).click()
      const claude = window.getByRole("radiogroup", { name: "Claude Code" })
      await expect(claude.getByRole("radio", { name: /^Login on / })).toBeVisible()
      await expect(window.getByText("Couldn't read this machine")).toHaveCount(0)
      await window.getByRole("link", { name: "Back", exact: true }).click()
      await expect(window.getByTestId("settings-sidebar")).toHaveCount(0)
      expect(await browser.opened()).toEqual([])
      expect(window.url()).toBe(document)

      await window.getByTestId("sidebar-marketplace-entry").click()
      await window.getByRole("button", { name: "Add source" }).click()
      await window.getByRole("link", { name: "kyashrathore/plugins" }).click()
      await expect.poll(() => browser.opened()).toEqual([PLUGINS_REPOSITORY])
      expect(window.url()).toBe(document)
    })
  })
}
