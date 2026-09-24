import type { Locator, Page } from "@playwright/test"
import type { AppChoice } from "../harness/app"
import type { SeedData } from "./seed"

export type SizeName = "1280" | "390"
export type Size = { name: SizeName; width: number; height: number; touch: boolean }

export const SIZES: readonly Size[] = [
  { name: "1280", width: 1280, height: 800, touch: false },
  { name: "390", width: 390, height: 844, touch: true },
]

export type ScreenContext = { page: Page; app: AppChoice; seed: SeedData | undefined; size: Size }

export type Screen = {
  id: string
  phase: "fresh" | "seeded"
  sizes?: readonly SizeName[]
  path(context: ScreenContext): string
  steps?(context: ScreenContext): Promise<void>
}

function seeded(context: ScreenContext): SeedData {
  if (!context.seed) throw new Error("this screen needs the seeded stack")
  return context.seed
}

function sessionPath(context: ScreenContext) {
  const seed = seeded(context)
  const route = context.app === "v1" ? "session" : "s"
  return `/w/${seed.workspace.id}/${route}/${seed.sessionId}`
}

function composer({ page, app }: ScreenContext): Locator {
  return app === "v1" ? page.locator('[data-component="prompt-input"]').first() : page.getByRole("textbox", { name: "Prompt" })
}

async function typeInComposer(context: ScreenContext, text: string) {
  const input = composer(context)
  await input.click()
  await context.page.keyboard.type(text)
}

async function openSettings({ page, app, size }: ScreenContext) {
  if (app === "v2") {
    await page.goto(new URL("/settings/general", page.url()).toString())
    return
  }
  if (size.touch) await page.getByRole("button", { name: "Open navigation sidebar" }).click()
  await page.getByTestId("rail-account-trigger").click()
  await page.getByRole("menuitem", { name: "Settings" }).click()
}

async function revealRail({ page, size }: ScreenContext) {
  if (!size.touch) return
  const opener = page.getByRole("button", { name: "Open navigation sidebar" })
  if (await opener.isVisible()) await opener.click()
}

async function openPanel({ page }: ScreenContext) {
  await page.getByRole("button", { name: "Open workspace panel" }).click()
}

async function openTreeFile(context: ScreenContext, ...names: string[]) {
  await openPanel(context)
  for (const name of names) {
    await context.page.getByRole("treeitem", { name: new RegExp(`^${name.replaceAll(".", "\\.")}`) }).click()
  }
}

function settingsSection(id: string, row: string): Screen {
  return {
    id: `settings-${id}`,
    phase: "seeded",
    path: sessionPath,
    steps: async (context) => {
      await openSettings(context)
      if (id === "general") return
      await revealRail(context)
      const { page } = context
      await page.getByRole("link", { name: row, exact: true }).or(page.getByRole("button", { name: row, exact: true })).first().click()
    },
  }
}

export const SCREENS: readonly Screen[] = [
  { id: "welcome-project", phase: "fresh", path: () => "/" },
  { id: "home", phase: "seeded", path: () => "/" },
  { id: "session", phase: "seeded", path: sessionPath },
  {
    id: "sidebar-off",
    phase: "seeded",
    sizes: ["1280"],
    path: sessionPath,
    steps: ({ page }) => page.getByRole("button", { name: "Hide Sidebar" }).click(),
  },
  {
    id: "drawer",
    phase: "seeded",
    sizes: ["390"],
    path: sessionPath,
    steps: ({ page }) => page.getByRole("button", { name: "Open navigation sidebar" }).click(),
  },
  { id: "palette", phase: "seeded", sizes: ["1280"], path: sessionPath, steps: ({ page }) => page.keyboard.press("ControlOrMeta+Shift+P") },
  { id: "at-popover", phase: "seeded", path: sessionPath, steps: (context) => typeInComposer(context, "@") },
  { id: "slash-popover", phase: "seeded", path: sessionPath, steps: (context) => typeInComposer(context, "/") },
  { id: "panel", phase: "seeded", path: sessionPath, steps: openPanel },
  { id: "panel-file", phase: "seeded", path: sessionPath, steps: (context) => openTreeFile(context, "src", "app.ts") },
  { id: "panel-markdown", phase: "seeded", sizes: ["1280"], path: sessionPath, steps: (context) => openTreeFile(context, "README.md") },
  {
    id: "panel-add-menu",
    phase: "seeded",
    sizes: ["1280"],
    path: sessionPath,
    steps: async (context) => {
      await openPanel(context)
      await context.page.getByRole("button", { name: "Add workspace tab" }).click()
    },
  },
  {
    id: "panel-maximized",
    phase: "seeded",
    sizes: ["1280"],
    path: sessionPath,
    steps: async (context) => {
      await openPanel(context)
      await context.page.getByRole("button", { name: "Maximize workspace panel" }).click()
    },
  },
  settingsSection("general", "General"),
  settingsSection("shortcuts", "Shortcuts"),
  settingsSection("terminals", "Terminals"),
  settingsSection("devices", "Machines"),
  settingsSection("orgs", "Orgs & Teams"),
  settingsSection("models", "Models"),
]
