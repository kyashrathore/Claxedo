import type { BrowserTarget } from "../environment"
import type { fixtureFor } from "../fixtures"
import { workspacePath } from "../state"
import { waitForUsefulScreen, waitForLaunchStable, recordVisualFailure } from "./common"
import type { Page } from "playwright-core"

export async function navigateToTerminalRoute(
  page: Page,
  app: BrowserTarget,
  fixture: ReturnType<typeof fixtureFor>,
  terminal: ReturnType<typeof fixtureFor>["terminals"][number],
  reload: boolean,
) {
  const route = `${workspacePath(fixture.directory)}/terminal/${encodeURIComponent(terminal.id)}`
  if (reload) {
    await page.goto(`${app.baseUrl}${route}`, { waitUntil: "domcontentloaded" })
    await waitForUsefulScreen(page)
    await waitForLaunchStable(page)
  } else {
    await page.evaluate((pathName) => {
      history.pushState({}, "", pathName)
      window.dispatchEvent(new PopStateEvent("popstate"))
    }, route)
  }
  await page.waitForFunction((id) =>
    !!document.querySelector(
      `[data-testid="rail-sidebar-terminal-row"][data-terminal-id="${CSS.escape(id)}"], ` +
      `[data-testid="terminal-pane"][data-terminal-id="${CSS.escape(id)}"]`,
    ),
  terminal.id, { timeout: 10_000 })
  await waitForTerminalSurface(page, fixture)
}

export async function openTerminalSurface(
  page: Page,
  fixture: ReturnType<typeof fixtureFor>,
  terminal?: ReturnType<typeof fixtureFor>["terminals"][number],
) {
  if (await clickTerminalInventoryRow(page, terminal)) {
    await waitForTerminalSurface(page, fixture)
    return
  }

  const toggle = page
    .locator('[aria-label*="terminal" i], [title*="terminal" i]')
    .filter({ hasNotText: /close/i })
    .first()
  if (await toggle.isVisible({ timeout: 100 }).catch(() => false)) {
    await toggle.click()
  } else {
    await page.keyboard.press("Control+`")
  }
  await clickTerminalInventoryRow(page, terminal)
  await waitForTerminalSurface(page, fixture)
}

async function clickTerminalInventoryRow(
  page: Page,
  terminal?: ReturnType<typeof fixtureFor>["terminals"][number],
) {
  const row = terminal
    ? page.locator(
        `[data-testid='terminal-section'] [data-testid='rail-sidebar-terminal-row'][data-terminal-id="${terminal.id}"]`,
      ).first()
    : page.locator("[data-testid='terminal-section'] [data-testid='rail-sidebar-terminal-row']").last()
  if (await row.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await row.scrollIntoViewIfNeeded().catch(() => undefined)
    await row.click({ timeout: 5_000 })
    return true
  }
  return false
}

async function waitForTerminalSurface(page: Page, fixture: ReturnType<typeof fixtureFor>) {
  const visible = await page
    .waitForFunction(() => {
      const fits = (rect: DOMRect) => rect.width > 100 && rect.height > 40
      const panels = document.querySelectorAll("#terminal-panel")
      for (const panel of panels) {
        if (fits(panel.getBoundingClientRect())) return true
      }
      const candidates: NodeListOf<Element> = document.querySelectorAll(
        "[data-component='terminal'], [data-testid='terminal-surface'], .terminal-pane-content",
      )
      for (const candidate of candidates) {
        if (fits(candidate.getBoundingClientRect())) return true
      }
      return false
    }, undefined, { timeout: 10_000 })
    .then(() => true)
    .catch(() => false)
  if (!visible) recordVisualFailure(fixture, "terminal surface did not visibly open")
}
