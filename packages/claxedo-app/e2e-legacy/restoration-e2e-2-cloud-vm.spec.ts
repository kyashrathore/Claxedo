/**
 * Restoration E2E-2 — Cloud VM via UI, multi-runner, reload-resume.
 *
 * Historical restoration flow. The cloud-create dialog
 * lives at `packages/claxedo-app/src/components/dialog-create-cloud-workspace.tsx`.
 * Provider list comes from `GET /api/workspace/drivers`; SSE
 * provision events stream from `POST /api/workspace/create` and the
 * dialog waits for `step === "ready"` (line 162, hard timeout 120s).
 *
 * This test consumes real cloud resources. Set
 *   `CLAXEDO_E2E_CLOUD=1`
 * to opt in. Otherwise the test is skipped.
 *
 * Screenshots land in `test-results/restoration/e2e-2/`.
 */

import path from "path"
import { mkdir } from "fs/promises"
import { fileURLToPath } from "url"
import { expect, test } from "@playwright/test"
import { stampTestAuth } from "./playwright-global-setup"
import { configuredSandboxCredentialProviders, loadEnvFile, realCloudCredentialReason } from "./playwright/real-provider-preflight"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_DIR = path.resolve(HERE, "..")
const SERVER_DIR = path.resolve(APP_DIR, "..", "claxedo-server")
const SHOT_DIR = path.resolve(HERE, "..", "..", "..", "test-results", "restoration", "e2e-2")

const shot = async (page: import("@playwright/test").Page, name: string) => {
  await mkdir(SHOT_DIR, { recursive: true })
  return page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: true })
}

async function selectRunner(page: import("@playwright/test").Page, runner: RegExp, options: { required?: boolean } = {}) {
  const directOption = page.getByRole("option", { name: runner }).first()
  if (await directOption.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await directOption.click()
    return
  }

  const promptInput = page.locator('[data-component="prompt-input"]').first()
  const promptFooter = promptInput.locator("xpath=ancestor::*[contains(@class, 'flex-col') or contains(@class, 'flex')][1]/..")
  const runnerTrigger = promptFooter.getByRole("combobox").first().or(
    promptFooter.locator("[data-component='runner-select']").first(),
  )
  if (await runnerTrigger.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await runnerTrigger.click()
    await page.getByRole("option", { name: runner }).first().click()
    return
  }
  if (options.required) throw new Error(`Could not select runner ${runner}`)
}

async function submitPrompt(page: import("@playwright/test").Page, prompt: string) {
  const promptInput = page.locator('[data-component="prompt-input"]').first()
  await expect(promptInput).toBeVisible({ timeout: 30_000 })
  await promptInput.click()
  await page.keyboard.type(prompt)
  await page.keyboard.press("Enter")
}

const enabled = process.env.CLAXEDO_E2E_CLOUD === "1"

async function cloudPreflightMissing() {
  const configuredProviders = await configuredSandboxCredentialProviders(SERVER_DIR)
  const provider = process.env.CLAXEDO_E2E_CLOUD_PROVIDER?.trim()
  if (provider) return [realCloudCredentialReason(provider, process.env, configuredProviders)].filter((item): item is string => !!item)
  return ["daytona", "modal", "vercel", "cloudflare"].some((provider) => !realCloudCredentialReason(provider, process.env, configuredProviders))
    ? []
    : ["one sandbox provider credential set (DAYTONA_API_KEY, Modal, Vercel, or Cloudflare)"]
}

test.describe("E2E-2: cloud VM via UI, multi-runner, reload-resume", () => {
  test.skip(!enabled, "set CLAXEDO_E2E_CLOUD=1 to enable (consumes cloud resources, ~3-5 min cold start)")
  test.beforeEach(async ({ context }) => {
    await loadEnvFile(path.join(APP_DIR, ".env.local"))
    await loadEnvFile(path.join(SERVER_DIR, ".env.local"))
    const missing = await cloudPreflightMissing()
    test.skip(missing.length > 0, `cloud VM E2E requires: ${missing.join(", ")}`)
    await stampTestAuth(context)
  })

  test("create cloud VM → opencode + claude sessions stream → reload resumes", async ({ page }) => {
    await page.goto("/")
    await shot(page, "01-authed-load")

    // 2. Open the create-cloud-workspace dialog from the sidebar.
    // The "+ New Project" button opens a flow that includes the
    // cloud variant; pick it.
    const newProject = page.getByRole("button", { name: /new project/i }).first()
    await newProject.click()
    const cloudCard = page.getByRole("button", { name: /cloud|sandbox|vm/i }).first()
    await cloudCard.click()
    await shot(page, "02-create-cloud-dialog")

    // Provider list should populate from /api/workspace/drivers.
    const providerSelect = page.getByRole("combobox").or(page.getByRole("listbox")).first()
    if (await providerSelect.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await providerSelect.click()
      const firstProvider = page.getByRole("option").first()
      await firstProvider.click()
    }

    // 3. Submit. Dialog watches SSE provision events, awaits step="ready".
    const submitBtn = page.getByRole("button", { name: /create|submit|launch/i }).last()
    await submitBtn.click()

    // Hard timeout 120s per dialog logic.
    const readyIndicator = page.getByText(/ready|provisioned/i).first()
    await expect(readyIndicator).toBeVisible({ timeout: 120_000 })
    await shot(page, "03-provisioned")

    // 4. +session with opencode.
    const wsHeader = page.getByTestId("workspace-header").last()
    await wsHeader.hover()
    await wsHeader.getByRole("button", { name: /^new session in/i }).click()
    await selectRunner(page, /opencode/i)
    await submitPrompt(page, "Reply with the word 'e2e2opencode'.")
    await expect(page.getByText(/e2e2opencode/i).first()).toBeVisible({ timeout: 90_000 })
    await shot(page, "04-opencode-reply")

    // 5. Reload → resume.
    await page.reload()
    await expect(page.getByText(/e2e2opencode/i).first()).toBeVisible({ timeout: 30_000 })
    await shot(page, "05-reload-resumed")

    // 6. Second session with claude.
    await wsHeader.hover()
    await wsHeader.getByRole("button", { name: /^new session in/i }).click()
    await selectRunner(page, /claude/i, { required: true })
    await submitPrompt(page, "Reply with the word 'e2e2claude'.")
    await expect(page.getByText(/e2e2claude/i).first()).toBeVisible({ timeout: 120_000 })
    await shot(page, "06-claude-reply")

    // 7. Reload → both resume.
    await page.reload()
    await expect(page.getByText(/e2e2opencode/i).first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/e2e2claude/i).first()).toBeVisible({ timeout: 30_000 })
    await shot(page, "07-both-resumed")
  })
})
