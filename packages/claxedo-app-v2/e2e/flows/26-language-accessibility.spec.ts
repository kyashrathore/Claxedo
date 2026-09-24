import AxeBuilder from "@axe-core/playwright"
import type { Page } from "@playwright/test"
import { expect, SCRIPTED_ACP_HARNESS, test } from "../harness"

async function createProject(url: string, name: string, directory: string): Promise<void> {
  const response = await fetch(new URL("/api/claxedo/projects", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, source: { kind: "directory", directory } }),
  })
  expect(response.status).toBe(201)
}

async function settled(app: Page): Promise<void> {
  await app.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.then(() => undefined, () => undefined)),
    ),
  )
}

async function sweep(app: Page, screen: string): Promise<void> {
  await settled(app)
  const results = await new AxeBuilder({ page: app }).analyze()
  const violations = results.violations.map((violation) => `${screen}: ${violation.id} ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`)
  expect(violations).toEqual([])
}

async function runCommand(app: Page, palette: string, command: string): Promise<void> {
  await app.keyboard.press("ControlOrMeta+Shift+KeyP")
  const dialog = app.getByRole("dialog", { name: palette })
  await dialog.getByRole("combobox", { name: palette }).fill(command)
  await dialog.getByRole("option", { name: command }).click()
}

test.skip(({ isMobile }) => isMobile, "flow 26 runs at desktop width; flow 33 sweeps the phone")

test("26 language switch and an accessibility sweep of the main screens", async ({ stack, api, app }) => {
  test.skip(stack.app === "v1", "the v1 path of this baseline flow is not written yet")
  await expect(app.getByRole("heading", { level: 1, name: "Start with a project" })).toBeVisible()
  await sweep(app, "onboarding")

  const workspace = await stack.daemon.makeWorkspace("language")
  await createProject(stack.url, "Language", workspace.directory)
  const session = await api.createSession(workspace.directory, { title: "Sprache", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}/w/${workspace.id}/s/${session.id}`)
  const tabs = (name: string) => app.getByRole("tablist", { name }).getByRole("tab")
  await expect(tabs("Open panes")).toHaveText(["Sprache"])
  await expect(app.getByRole("heading", { level: 1, name: "Sprache" })).toBeVisible()
  await sweep(app, "session")

  await app.keyboard.press("ControlOrMeta+Shift+KeyP")
  await expect(app.getByRole("dialog", { name: "Command palette" })).toBeVisible()
  await sweep(app, "palette")
  await app.keyboard.press("Escape")

  await runCommand(app, "Command palette", "Set language: Deutsch")
  await expect.poll(() => app.evaluate(() => document.documentElement.lang)).toBe("de")
  await expect(app.getByRole("navigation", { name: "Projekte und Sitzungen" })).toBeVisible()
  await app.reload()
  await expect(app.getByRole("navigation", { name: "Projekte und Sitzungen" })).toBeVisible()
  await expect(tabs("Offene Bereiche")).toHaveText([(await api.session(workspace.directory, session.id)).title])
  await expect(app.getByRole("heading", { level: 1, name: "Sprache" })).toBeVisible()
  await sweep(app, "session, German")

  await runCommand(app, "Befehlspalette", "Einstellungen öffnen")
  await expect(app.getByRole("main").getByRole("tab", { name: "Einstellungen" })).toHaveAttribute("aria-selected", "true")
  await sweep(app, "settings, German")
})
