import type { Page } from "@playwright/test"
import {
  expect,
  expectNoAxeViolations,
  expectWithinV1Baseline,
  SCRIPTED_ACP_HARNESS,
  test,
  type ClaxedoApi,
  type SessionRow,
  type Stack,
  type Workspace,
} from "../harness"

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

async function runCommand(app: Page, palette: string, command: string): Promise<void> {
  await app.keyboard.press("ControlOrMeta+Shift+KeyP")
  const dialog = app.getByRole("dialog", { name: palette })
  await dialog.getByRole("combobox", { name: palette }).fill(command)
  await dialog.getByRole("option", { name: command }).click()
}

function openPanes(app: Page, name: string) {
  return app.getByRole("tablist", { name }).getByRole("tab")
}

async function v2English(stack: Stack, api: ClaxedoApi, app: Page): Promise<Arranged> {
  await expect(app.getByRole("heading", { level: 1, name: "Start with a project" })).toBeVisible()
  await expectNoAxeViolations(app, "onboarding")
  const arranged = await arrange(stack, api)
  await app.goto(`${stack.url}/w/${arranged.workspace.id}/s/${arranged.session.id}`)
  await expect(openPanes(app, "Open panes")).toHaveText(["Sprache"])
  await expect(app.getByRole("heading", { level: 1, name: "Sprache" })).toBeVisible()
  await expectNoAxeViolations(app, "session")
  await app.keyboard.press("ControlOrMeta+Shift+KeyP")
  await expect(app.getByRole("dialog", { name: "Command palette" })).toBeVisible()
  await expectNoAxeViolations(app, "palette")
  await app.keyboard.press("Escape")
  return arranged
}

async function v2German(api: ClaxedoApi, app: Page, arranged: Arranged): Promise<void> {
  await runCommand(app, "Command palette", "Set language: Deutsch")
  await expectGerman(app)
  await app.reload()
  await expectGerman(app)
  await expect(openPanes(app, "Offene Bereiche")).toHaveText([(await api.session(arranged.workspace.directory, arranged.session.id)).title])
  await expect(app.getByRole("heading", { level: 1, name: "Sprache" })).toBeVisible()
  await expectNoAxeViolations(app, "session, German")
  await runCommand(app, "Befehlspalette", "Einstellungen öffnen")
  await expect(app.getByRole("main").getByRole("tab", { name: "Einstellungen" })).toHaveAttribute("aria-selected", "true")
  await expectNoAxeViolations(app, "settings, German")
}

async function v1English(stack: Stack, api: ClaxedoApi, app: Page): Promise<Arranged> {
  await expect(app.getByRole("heading", { level: 1, name: "Start with a project" })).toBeVisible()
  await expectWithinV1Baseline(app, "home")
  const arranged = await arrange(stack, api)
  await app.goto(`${stack.url}/`)
  await app.getByRole("navigation", { name: "Projects and sessions" }).getByRole("button", { name: "Sprache" }).click()
  await expect(app).toHaveURL(new RegExp(`/s/${arranged.session.id}$`))
  await expect(app.getByRole("heading", { level: 1, name: "Sprache" })).toBeVisible()
  await expectWithinV1Baseline(app, "session-page")
  await app.keyboard.press("ControlOrMeta+Shift+KeyP")
  await expect(app.getByRole("dialog", { name: "Search files, commands, and sessions" })).toBeVisible()
  await expectWithinV1Baseline(app, "command-palette")
  await app.keyboard.press("Escape")
  return arranged
}

async function v1German(stack: Stack, api: ClaxedoApi, app: Page, arranged: Arranged): Promise<void> {
  await app.goto(`${stack.url}/settings/general`)
  await expect(app.getByRole("heading", { level: 1, name: "General" })).toBeVisible()
  await expectWithinV1Baseline(app, "settings-surface")
  await app.getByRole("group", { name: "Language" }).getByRole("button", { name: "English" }).click()
  await app.getByRole("option", { name: "Deutsch" }).click()
  await expectGerman(app)
  await app.goto(`${stack.url}/`)
  await expectGerman(app)
  const title = (await api.session(arranged.workspace.directory, arranged.session.id)).title
  await app.getByRole("navigation", { name: "Projekte und Sitzungen" }).getByRole("button", { name: title }).click()
  await expect(app.getByRole("heading", { level: 1, name: title })).toBeVisible()
  await expectWithinV1Baseline(app, "session-page")
}

test.skip(({ isMobile }) => isMobile, "flow 26 runs at desktop width; flow 33 sweeps the phone")

test("26 language switch and an accessibility sweep of the main screens", async ({ stack, api, app }) => {
  if (stack.app === "v1") {
    await v1German(stack, api, app, await v1English(stack, api, app))
    return
  }
  await v2German(api, app, await v2English(stack, api, app))
})
