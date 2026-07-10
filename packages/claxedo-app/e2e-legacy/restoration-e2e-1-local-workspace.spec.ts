/**
 * Restoration E2E-1 — Local workspace, multi-runner, reload-resume.
 *
 * Historical restoration flow. Drives the real UI through:
 *   1. Authenticated load (test-auth bypass via global setup)
 *   2. Sidebar workspace presence (or create-local if missing)
 *   3. +session → runner picker → opencode → prompt → streamed reply
 *   4. Reload → resume
 *   5. Second session with claude → prompt → reply
 *   6. Reload → both resume
 *
 * Screenshots land in `test-results/restoration/e2e-1/`.
 *
 * Requires the dev stack running on :4444 (vite), :3001 (claxedo-server),
 * :4096 (opencode). The Playwright config will auto-start vite via
 * `webServer`; claxedo-server and opencode must be running separately.
 * Set `CLAXEDO_E2E_RESTORATION_LOCAL=1` to opt in.
 */

import path from "path"
import { mkdir } from "fs/promises"
import { fileURLToPath } from "url"
import { expect, test } from "@playwright/test"
import { stampTestAuth } from "./playwright-global-setup"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SHOT_DIR = path.resolve(HERE, "..", "..", "..", "test-results", "restoration", "e2e-1")

/**
 * `CLAXEDO_E2E_LIVE_AGENT=1` enables strict reply assertions that
 * require an actually-responding agent (real API key + runner
 * binary). When unset, the spec runs in "flow-only" mode: it
 * exercises auth → sidebar → +session → prompt submit → reload, but
 * skips the agent-reply assertion. This keeps E2E-1 usable as a
 * smoke test in environments without credentialed agent runtimes.
 */
const liveAgent = process.env.CLAXEDO_E2E_LIVE_AGENT === "1"
const enabled = process.env.CLAXEDO_E2E_RESTORATION_LOCAL === "1"

const shot = async (page: import("@playwright/test").Page, name: string) => {
  await mkdir(SHOT_DIR, { recursive: true })
  return page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: true })
}

test.describe("E2E-1: local workspace, multi-runner, reload-resume", () => {
  test.skip(
    !enabled,
    "set CLAXEDO_E2E_RESTORATION_LOCAL=1 to run the historical local restoration flow",
  )

  test.beforeEach(async ({ context }) => {
    await stampTestAuth(context)
  })

  test("opencode + claude sessions stream and survive reload", async ({ page }) => {
    await page.goto("/")
    await shot(page, "01-authed-load")

    // 2. Sidebar should expose at least one workspace. If not, click
    // "+ New Project" / the create-local flow first. Detection is
    // tolerant of either the empty state or a populated sidebar.
    const sidebarFirstWorkspace = page.getByTestId("workspace-header").first()
    if ((await sidebarFirstWorkspace.count()) === 0) {
      const newProject = page.getByRole("button", { name: /new project/i })
      await expect(newProject).toBeVisible({ timeout: 10_000 })
      await newProject.click()
      // Create-local flow: workspace-create-flow.tsx:50
      const localCard = page.getByRole("button", { name: /local/i }).first()
      await localCard.click()
      const submitCreate = page.getByRole("button", { name: /create|continue/i }).last()
      await submitCreate.click()
      await expect(sidebarFirstWorkspace).toBeVisible({ timeout: 15_000 })
    }
    await shot(page, "02-sidebar-workspace")

    // 3. +session on the workspace header. The hover-revealed actions
    // become visible when the header gains focus.
    await sidebarFirstWorkspace.hover()
    const newSessionBtn = sidebarFirstWorkspace.getByRole("button", { name: /^new session in/i })
    await newSessionBtn.click()
    await shot(page, "03-new-session-clicked")

    // The default runner is `opencode`, so the runner picker doesn't need to be
    // opened to switch — we already start in opencode mode. We still
    // attempt to select it explicitly when the picker is a dropdown
    // we can find, otherwise we proceed to the prompt directly.
    const explicitOpencode = page.getByRole("option", { name: /opencode|OpenCode/i }).first()
    if (await explicitOpencode.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await explicitOpencode.click()
    }

    // 4. Prompt input → submit → streamed reply.
    // The input is a contentEditable div (`role="textbox"` per
    // packages/app/src/components/prompt-input.tsx:1347), NOT a
    // textarea/input with a placeholder attribute. Use the
    // `data-component="prompt-input"` selector for reliability.
    // The canvas may flash "Loading..." while the session/draft
    // hydrates — give the prompt input up to 30s to mount.
    const promptInput = page.locator('[data-component="prompt-input"]').first()
    await expect(promptInput).toBeVisible({ timeout: 30_000 })
    await promptInput.click()
    const opencodePrompt = "Say the word 'restoration' verbatim."
    await page.keyboard.type(opencodePrompt)
    await page.keyboard.press("Enter")

    // Strict-flow assertion: the prompt input must clear
    // after submit (proves the keystroke was handled and the message
    // was sent to the runner / draft session). The agent reply gate
    // is still live-agent-only because that needs a credentialed
    // runner.
    const messageBubbles = page.locator('[data-message-id]')
    await expect.poll(
      async () => (await promptInput.textContent())?.trim() ?? "",
      { timeout: 15_000 },
    ).not.toContain("restoration")

    if (liveAgent) {
      await expect.poll(() => messageBubbles.count(), { timeout: 60_000 })
        .toBeGreaterThanOrEqual(2)
      await expect(messageBubbles.filter({ hasText: /restoration/i }).first())
        .toBeVisible({ timeout: 60_000 })
    }
    await shot(page, "04-opencode-reply")

    // 5. Reload — UI must come back (sidebar + workspace visible).
    // Live-agent mode also re-asserts the assistant bubble.
    await page.reload()
    await expect(page.getByTestId("workspace-header").first()).toBeVisible({ timeout: 30_000 })
    if (liveAgent) {
      await expect(page.locator('[data-message-id]').filter({ hasText: /restoration/i }).first())
        .toBeVisible({ timeout: 30_000 })
    }
    await shot(page, "05-reload-resumed")

    // 6. Second session with claude. The runner-picker dropdown
    // doesn't auto-open on +session click — we have to click the
    // runner Select trigger, which today reads as a combobox/button
    // showing the current runner label ("OpenCode" by default).
    await sidebarFirstWorkspace.hover()
    await newSessionBtn.click()

    const secondPrompt = page.locator('[data-component="prompt-input"]').first()
    await expect(secondPrompt).toBeVisible({ timeout: 15_000 })

    // Open the runner Select. Scope to the prompt-input footer (the
    // bottom strip below the textbox) so we don't accidentally hit
    // the "C" / "X" terminal launchers in the global L1 header.
    // The Kobalte Select renders as role="combobox".
    const promptFooter = secondPrompt.locator("xpath=ancestor::*[contains(@class, 'flex-col') or contains(@class, 'flex')][1]/..")
    const runnerTrigger = promptFooter.getByRole("combobox").first().or(
      promptFooter.locator("[data-component='runner-select']").first(),
    )
    if (await runnerTrigger.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await runnerTrigger.click()
      const claudeOption = page.getByRole("option", { name: /claude/i }).first()
      if (await claudeOption.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await claudeOption.click()
      }
    }

    await secondPrompt.click()
    await page.keyboard.type("Reply with the single word 'claudereply'.")
    await page.keyboard.press("Enter")
    if (liveAgent) {
      await expect(page.locator('[data-message-id]').filter({ hasText: /claudereply/i }).first())
        .toBeVisible({ timeout: 120_000 })
    } else {
      await page.waitForTimeout(1_500)
    }
    await shot(page, "06-claude-reply")

    // 7. Reload — UI returns; in live-agent mode both bubbles resume.
    await page.reload()
    await expect(page.getByTestId("workspace-header").first()).toBeVisible({ timeout: 30_000 })
    if (liveAgent) {
      await expect(page.locator('[data-message-id]').filter({ hasText: /restoration/i }).first())
        .toBeVisible({ timeout: 30_000 })
      await expect(page.locator('[data-message-id]').filter({ hasText: /claudereply/i }).first())
        .toBeVisible({ timeout: 30_000 })
    }
    await shot(page, "07-both-resumed")
  })
})
