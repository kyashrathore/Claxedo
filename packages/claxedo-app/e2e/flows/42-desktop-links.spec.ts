import { expect, interceptSystemBrowser, test, UI } from "../harness"

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

      await window.getByRole("button", { name: UI.signInAccount, exact: true }).click()
      await window.getByRole("menuitem", { name: "Settings" }).click()
      for (const section of ["Keyboard shortcuts", "Appearance"]) {
        await window.getByRole("link", { name: section, exact: true }).click()
        await expect(window.getByRole("heading", { level: 1, name: section })).toBeVisible()
      }
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
