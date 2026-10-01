import fs from "node:fs/promises"
import path from "node:path"
import type { Page, TestInfo } from "@playwright/test"
import { expect } from "@playwright/test"
import { expectNothingAnimating } from "./animations"
import type { Stack } from "./stack"

const PERSONAL_SKILL = "panel-skill"

export async function marketplacePanel(stack: Stack, app: Page, phone: boolean, testInfo: TestInfo): Promise<void> {
  const root = path.join(stack.dataDir, ".agents", "skills", PERSONAL_SKILL)
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(
    path.join(root, "SKILL.md"),
    "---\nname: panel-skill\ndescription: Panel acceptance skill\n---\nPanel acceptance skill.\n",
  )
  const response = await fetch(`${stack.url}/api/claxedo/plugins`)
  expect(response.status).toBe(200)
  const catalog = (await response.json()) as { candidates: Array<{ builtIn?: boolean; manifest: { name: string } }> }
  const builtIn = catalog.candidates.find((plugin) => plugin.builtIn)
  if (!builtIn) throw new Error("The real catalog has no built-in plugin")
  await app.goto(`${stack.url}/marketplace`)
  await app.getByRole("button", { name: builtIn.manifest.name, exact: true }).click()
  const panel = app.getByRole("complementary", { name: `${builtIn.manifest.name} details`, exact: true })
  await expect(panel).toBeVisible()
  await expect(panel.getByRole("button", { name: "Details", exact: true })).toHaveCount(1)
  await expect(panel.getByRole("button", { name: "Add workspace tab" })).toHaveCount(0)
  await expect(panel.getByRole("button", { name: /Open (Files|Changes)/ })).toHaveCount(0)
  await expect(panel.getByText("Select a workspace to use this panel.")).toHaveCount(0)
  await expectNothingAnimating(app)
  await fullHeightPanel(app, panel, phone)
  if (testInfo.repeatEachIndex === 0) {
    for (const colorScheme of ["light", "dark"] as const) {
      await app.emulateMedia({ colorScheme })
      await expectNothingAnimating(app)
      await app.screenshot({ path: testInfo.outputPath(`details-${colorScheme}.png`) })
    }
  }
  if (phone) await phonePanel(app, panel)
  else await desktopPanel(app, panel)
  await panel.getByRole("button", { name: "Close details", exact: true }).last().click()
  await expect(panel).toHaveCount(0)
  await app.getByRole("button", { name: PERSONAL_SKILL, exact: true }).click()
  const personal = app.getByRole("complementary", { name: `${PERSONAL_SKILL} details`, exact: true })
  await expect(personal).toBeVisible()
  await expect(personal.getByRole("button", { name: "Details", exact: true })).toHaveCount(1)
  if (!phone) {
    await app.getByRole("button", { name: builtIn.manifest.name, exact: true }).click()
    await expect(panel).toBeVisible()
    await expect(personal).toHaveCount(0)
    await expect(app.getByRole("complementary", { name: / details$/ })).toHaveCount(1)
  }
  await app.getByRole("complementary", { name: / details$/ }).getByRole("button", { name: "Details", exact: true }).focus()
  await app.keyboard.press("Escape")
  await expect(app.getByRole("complementary", { name: / details$/ })).toHaveCount(0)
  const installed = (await (await fetch(`${stack.url}/api/claxedo/plugins/machine-installed`)).json()) as {
    skills: Array<{ name: string; root: string }>
  }
  expect(installed.skills).toContainEqual({ name: PERSONAL_SKILL, harnessId: "agents", root })
}

async function fullHeightPanel(app: Page, panel: ReturnType<Page["getByRole"]>, phone: boolean): Promise<void> {
  const box = await panel.boundingBox()
  const center = await app.getByTestId("shell-center").boundingBox()
  const header = await app.getByTestId("workbench-shell-header").boundingBox()
  const toggle = await panel.getByRole("button", { name: "Close details", exact: true }).last().boundingBox()
  if (!box || !center || !header || !toggle) throw new Error("The panel and shell header are not laid out")
  expect(box.y).toBeCloseTo(center.y, 0)
  expect(box.height).toBeCloseTo(center.height, 0)
  expect(toggle.y).toBeLessThan(header.y + header.height)
  if (!phone) expect(header.x + header.width).toBeCloseTo(box.x, 0)
}

async function phonePanel(app: Page, panel: ReturnType<Page["getByRole"]>): Promise<void> {
  const box = await panel.boundingBox()
  const center = await app.getByTestId("shell-center").boundingBox()
  expect(box?.width).toBeCloseTo(center?.width ?? 0, 0)
  await expect(panel.getByRole("separator")).toHaveCount(0)
  await expect(panel.getByRole("button", { name: "Maximize details panel" })).toHaveCount(0)
  const close = await panel.getByRole("button", { name: "Close details", exact: true }).last().boundingBox()
  expect(close?.width).toBeGreaterThanOrEqual(44)
  expect(close?.height).toBeGreaterThanOrEqual(44)
  const label = await panel.getByText("Details", { exact: true }).boundingBox()
  const tabClose = await panel.getByRole("button", { name: "Close details", exact: true }).first().boundingBox()
  if (!label || !tabClose) throw new Error("The Details tab is not laid out")
  expect(label.x + label.width).toBeLessThanOrEqual(tabClose.x)
  expect(await app.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
}

async function desktopPanel(app: Page, panel: ReturnType<Page["getByRole"]>): Promise<void> {
  const separator = panel.getByRole("separator", { name: "Resize plugin details" })
  await separator.focus()
  const width = Number(await separator.getAttribute("aria-valuenow"))
  await app.keyboard.press("ArrowLeft")
  await expect(separator).toHaveAttribute("aria-valuenow", String(width + 24))
  await panel.getByRole("button", { name: "Maximize details panel" }).click()
  await expect(panel.getByRole("button", { name: "Restore details panel" })).toBeVisible()
  await expect(separator).toHaveCount(0)
  await panel.getByRole("button", { name: "Restore details panel" }).click()
  await expect(separator).toHaveAttribute("aria-valuenow", String(width + 24))
}
