import type { Page, TestInfo } from "@playwright/test"
import { expect } from "@playwright/test"
import { expectNothingAnimating } from "./animations"
import type { Stack } from "./stack"

export async function marketplacePanel(stack: Stack, app: Page, phone: boolean, testInfo: TestInfo): Promise<void> {
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
  for (const id of ["opencode", "claude", "codex", "cursor", "pi", "acp"]) await expect(panel.getByText(id, { exact: true }), "harnesses are named, never shown by id").toHaveCount(0)
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
  await expect(app.getByText("Personal", { exact: true })).toHaveCount(0)
  await app.getByRole("button", { name: builtIn.manifest.name, exact: true }).click()
  await expect(panel).toBeVisible()
  await app.getByRole("complementary", { name: / details$/ }).getByRole("button", { name: "Details", exact: true }).focus()
  await app.keyboard.press("Escape")
  await expect(app.getByRole("complementary", { name: / details$/ })).toHaveCount(0)
  expect((await fetch(`${stack.url}/api/claxedo/plugins/machine-installed`)).status).toBe(404)
  await addSourceDrawer(app, phone, testInfo)
}

async function addSourceDrawer(app: Page, phone: boolean, testInfo: TestInfo): Promise<void> {
  await app.getByRole("button", { name: "Add source…" }).click()
  const drawer = app.getByRole("dialog", { name: "Add source" })
  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole("textbox", { name: "GitHub repository" })).toBeFocused()
  await expect(drawer.getByRole("textbox", { name: "Ref (optional)" })).toBeVisible()
  await expect(drawer.getByRole("button", { name: "Add source" })).toBeDisabled()
  const box = await drawer.boundingBox()
  const viewport = app.viewportSize()
  if (!box || !viewport) throw new Error("The Add source drawer is not laid out")
  expect(box.x + box.width).toBeCloseTo(viewport.width, 0)
  if (phone) expect(box.width).toBeCloseTo(viewport.width, 0)
  await expectNothingAnimating(app)
  if (testInfo.repeatEachIndex === 0) await app.screenshot({ path: testInfo.outputPath("add-source-drawer.png") })
  await drawer.getByRole("button", { name: "Cancel" }).click()
  await expect(drawer).toHaveCount(0)
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
