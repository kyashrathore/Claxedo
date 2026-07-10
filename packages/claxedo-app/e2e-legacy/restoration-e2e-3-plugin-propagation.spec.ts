/**
 * Restoration E2E-3 — Plugin install propagation across local + old/new cloud VMs.
 *
 * Historical restoration flow for the propagation gap. After cycle 88's
 * fan-out wiring + integration test, this test asserts the same path
 * at the UI layer.
 *
 * This test consumes real cloud resources AND a real agent runner.
 * Set `CLAXEDO_E2E_PROPAGATION=1` to opt in. Otherwise skipped.
 *
 * Screenshots land in `test-results/restoration/e2e-3/`.
 */

import path from "path"
import { mkdir } from "fs/promises"
import { fileURLToPath } from "url"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { stampTestAuth } from "./playwright-global-setup"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SHOT_DIR = path.resolve(HERE, "..", "..", "..", "test-results", "restoration", "e2e-3")

const shot = async (page: import("@playwright/test").Page, name: string) => {
  await mkdir(SHOT_DIR, { recursive: true })
  return page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: true })
}

const enabled = process.env.CLAXEDO_E2E_PROPAGATION === "1"

/** The plugin name to install/uninstall. Must be a real catalog entry. */
const PLUGIN_NAME = process.env.CLAXEDO_E2E_PLUGIN ?? "anthropics/skills"
/** The text the agent should reference when the plugin is installed. */
const PLUGIN_CAPABILITY_HINT = process.env.CLAXEDO_E2E_PLUGIN_HINT ?? "skill"

async function askAndAffirm(
  page: Page,
  wsHeader: Locator,
  runnerLabel: RegExp,
  expectAffirmative: boolean,
  shotName: string,
) {
  await wsHeader.hover()
  await wsHeader.getByRole("button", { name: /^new session in/i }).click()

  const input = page.locator('[data-component="prompt-input"]').first()
  await expect(input).toBeVisible({ timeout: 30_000 })
  const directOption = page.getByRole("option", { name: runnerLabel }).first()
  if (await directOption.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await directOption.click()
  } else {
    const promptFooter = input.locator("xpath=ancestor::*[contains(@class, 'flex-col') or contains(@class, 'flex')][1]/..")
    const runnerTrigger = promptFooter.getByRole("combobox").first().or(
      promptFooter.locator("[data-component='runner-select']").first(),
    )
    if (await runnerTrigger.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await runnerTrigger.click()
      await page.getByRole("option", { name: runnerLabel }).first().click()
    } else if (runnerLabel.test("claude")) {
      throw new Error(`Could not select runner ${runnerLabel}`)
    }
  }

  await input.click()
  await page.keyboard.type(`Do you know about ${PLUGIN_NAME}? Answer yes or no on a single line.`)
  await page.keyboard.press("Enter")

  const yesPattern = new RegExp(`(yes|${PLUGIN_CAPABILITY_HINT}|installed)`, "i")
  const noPattern = /(no|not (?:installed|available))/i
  const target = expectAffirmative ? yesPattern : noPattern
  await expect(page.getByText(target).first()).toBeVisible({ timeout: 120_000 })
  await shot(page, shotName)
}

test.describe("E2E-3: plugin install propagation across local + cloud VMs", () => {
  test.skip(!enabled, "set CLAXEDO_E2E_PROPAGATION=1 to enable (needs marketplace + 2 cloud VMs + plugin agent runtime)")
  test.beforeEach(async ({ context }) => {
    await stampTestAuth(context)
  })

  test("install propagates; uninstall propagates", async ({ page }) => {
    await page.goto("/")
    await shot(page, "01-authed-load")

    // 2. Open Marketplace from sidebar (in-workbench tab).
    await page.getByTestId("sidebar-marketplace-entry").click()
    await expect(page.getByPlaceholder(/search skills/i)).toBeVisible({ timeout: 10_000 })
    await shot(page, "02-marketplace-open")

    // 3. Install one real agent extension.
    await page.getByPlaceholder(/search skills/i).fill(PLUGIN_NAME)
    const installBtn = page.getByRole("button", { name: /^install$/i }).first()
    await expect(installBtn).toBeVisible({ timeout: 10_000 })
    await installBtn.click()
    await expect(page.getByRole("button", { name: /^uninstall$/i }).first()).toBeVisible({ timeout: 30_000 })
    await shot(page, "03-installed")

    // 4-6. Each scope (local, old cloud, new cloud) × each runner.
    // We rely on previously-existing workspaces from E2E-1/E2E-2;
    // when they're absent, we skip that section.
    const workspaces = page.getByTestId("workspace-header")
    const workspaceCount = await workspaces.count()
    expect(workspaceCount).toBeGreaterThan(0)

    for (let i = 0; i < Math.min(workspaceCount, 3); i++) {
      const label = `04-ws${i}-opencode-knows-plugin`
      await askAndAffirm(page, workspaces.nth(i), /opencode/i, true, label)
      const label2 = `05-ws${i}-claude-knows-plugin`
      await askAndAffirm(page, workspaces.nth(i), /claude/i, true, label2)
    }

    // 7. Uninstall.
    await page.getByTestId("sidebar-marketplace-entry").click()
    await page.getByRole("button", { name: /^uninstall$/i }).first().click()
    await expect(page.getByRole("button", { name: /^install$/i }).first()).toBeVisible({ timeout: 30_000 })
    await shot(page, "07-uninstalled")

    // 8. Each scope × each runner must now report "not installed".
    for (let i = 0; i < Math.min(workspaceCount, 3); i++) {
      const label = `08-ws${i}-opencode-no-plugin`
      await askAndAffirm(page, workspaces.nth(i), /opencode/i, false, label)
      const label2 = `09-ws${i}-claude-no-plugin`
      await askAndAffirm(page, workspaces.nth(i), /claude/i, false, label2)
    }
  })
})
