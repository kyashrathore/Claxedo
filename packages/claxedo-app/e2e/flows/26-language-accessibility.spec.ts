import type { Page } from "@playwright/test"
import {
  expect,
  expectWithinBaseline,
  SCRIPTED_ACP_HARNESS,
  test,
  type ClaxedoApi,
  type SessionRow,
  type Stack,
  type Workspace,
  sessionRoute,
  UI,
} from "../harness"
import { openSection, openSettings } from "./15-settings.navigation"

type Arranged = { readonly workspace: Workspace; readonly session: SessionRow }

async function arrange(stack: Stack, api: ClaxedoApi): Promise<Arranged> {
  const workspace = await stack.daemon.makeWorkspace("language", "Language")
  const session = await api.createSession(workspace.directory, { title: "Sprache", harness: SCRIPTED_ACP_HARNESS })
  return { workspace, session }
}

async function expectGerman(app: Page): Promise<void> {
  await expect.poll(() => app.evaluate(() => document.documentElement.lang)).toBe("de")
  await expect(app.getByRole("navigation", { name: "Projekte und Sitzungen" })).toBeVisible()
}

async function expectSessionOpen(stack: Stack, app: Page, rail: string, title: string): Promise<void> {
  await test.step("no session title bar (DECISIONS Owner, 17:15)", async () => {
    await expect(app.getByRole("navigation", { name: rail }).getByRole("button", { name: title, exact: true })).toHaveAttribute("aria-current", "page")
  })
  return
  await expect(app.getByRole("heading", { level: 1, name: title })).toBeVisible()
}

async function openGeneralSettings(stack: Stack, app: Page): Promise<void> {
  await app.getByRole("button", { name: "Settings", exact: true }).click()
  await test.step("no General section; Language is its own section (DECISIONS Owner, 00:55)", async () => {
    await app.getByRole("group", { name: "App" }).getByRole("link", { name: "Language", exact: true }).click()
    await expect(app.getByRole("heading", { level: 1, name: "Language" })).toBeVisible()
  })
  return
  await expect(app.getByRole("heading", { level: 1, name: "General" })).toBeVisible()
}

async function english(stack: Stack, api: ClaxedoApi, app: Page): Promise<Arranged> {
  await expect(app.getByRole("heading", { level: 1, name: "Start with a project" })).toBeVisible()
  await expectWithinBaseline(app, "home")
  const arranged = await arrange(stack, api)
  await app.goto(`${stack.url}/`)
  await app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: "Sprache", exact: true }).click()
  await expect(app).toHaveURL(new RegExp(`/s/${arranged.session.id}$`))
  await expectSessionOpen(stack, app, UI.rail, "Sprache")
  await expectWithinBaseline(app, "session-page")
  await app.keyboard.press("ControlOrMeta+Shift+KeyP")
  await expect(app.getByRole("dialog", { name: UI.palette })).toBeVisible()
  await expectWithinBaseline(app, "command-palette")
  await app.keyboard.press("Escape")
  return arranged
}

async function bind(app: Page, command: string, keys: string): Promise<void> {
  const binding = app.locator(`[data-keybind-id="${command}"]`)
  await binding.click()
  await expect(binding).toHaveText("Press keys")
  await app.keyboard.press(keys)
  await expect(binding).not.toHaveText("Press keys")
}

async function toastStates(app: Page) {
  return app.locator("[data-sonner-toast]").evaluateAll((toasts) =>
    toasts.map((toast) => ({
      role: toast.getAttribute("role"),
      visible: toast.getAttribute("data-visible"),
      inert: (toast as HTMLElement).inert,
      tabIndex: (toast as HTMLElement).tabIndex,
    })),
  )
}

async function german(stack: Stack, api: ClaxedoApi, app: Page, arranged: Arranged): Promise<void> {
  await openGeneralSettings(stack, app)
  await expectWithinBaseline(app, "settings-surface")
  await app.getByRole("group", { name: "Language" }).getByRole("button", { name: "English" }).click()
  await app.getByRole("option", { name: "Deutsch" }).click()
  await expectGerman(app)
  await app.goto(`${stack.url}/`)
  await expectGerman(app)
  const title = (await api.session(arranged.workspace.directory, arranged.session.id)).title
  await app.getByRole("navigation", { name: "Projekte und Sitzungen" }).getByRole("button", { name: title, exact: true }).click()
  await expectSessionOpen(stack, app, "Projekte und Sitzungen", title)
  await expectWithinBaseline(app, "session-page")
}

test.skip(({ isMobile }) => isMobile, "flow 26 runs at desktop width; flow 33 sweeps the phone")

test("26 language switch and an accessibility sweep of the main screens", async ({ stack, api, app }) => {
  await german(stack, api, app, await english(stack, api, app))
})

test("26 toasts are announced and the ones stacked out of view are inert, after the toast region empties and comes back", async ({ stack, app, isMobile }) => {
  const workspace = await stack.daemon.makeWorkspace("toasts", "Toasts")
  const draft = `${stack.url}${sessionRoute(workspace.id)}`
  await app.goto(draft)
  await openSettings(app, isMobile)
  await openSection(app, isMobile, "Keyboard shortcuts")
  await bind(app, "theme.scheme.cycle", "ControlOrMeta+Alt+KeyJ")
  await bind(app, "theme.cycle", "ControlOrMeta+Alt+KeyL")
  await app.goto(draft)
  await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
  const toasts = app.locator("[data-sonner-toast]")

  await app.keyboard.press("ControlOrMeta+Alt+KeyJ")
  await expect(toasts).toHaveCount(1)
  expect(await toastStates(app)).toEqual([{ role: "status", visible: "true", inert: false, tabIndex: 0 }])
  await expect(app.locator("[data-sonner-toaster]")).toHaveCount(0, { timeout: 15_000 })

  await app.keyboard.press("ControlOrMeta+Alt+KeyJ")
  await app.keyboard.press("ControlOrMeta+Alt+KeyJ")
  await app.keyboard.press("ControlOrMeta+Alt+KeyJ")
  await app.keyboard.press("ControlOrMeta+Alt+KeyL")
  await expect(toasts).toHaveCount(4)
  await expect
    .poll(() => toastStates(app), { timeout: 3_000 })
    .toEqual([
      { role: "status", visible: "true", inert: false, tabIndex: 0 },
      { role: "status", visible: "true", inert: false, tabIndex: 0 },
      { role: "status", visible: "true", inert: false, tabIndex: 0 },
      { role: "status", visible: "false", inert: true, tabIndex: -1 },
    ])
})
