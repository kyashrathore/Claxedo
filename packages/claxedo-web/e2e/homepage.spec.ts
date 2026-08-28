import { expect, test } from "@playwright/test"

test("renders the real Claxedo shell and five focused feature crops", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("heading", { level: 1, name: "Your coding agents, finally in one place." })).toBeVisible()
  const hero = page.locator("[data-app-replica]").first()
  await expect(hero.getByRole("complementary", { name: "Projects and sessions" })).toBeHidden()
  await expect(hero.getByRole("complementary", { name: "Workspace panel" })).toBeHidden()
  if (page.viewportSize()!.width >= 768) await expect(hero.getByRole("complementary", { name: "Session environment" })).toBeVisible()
  await expect(hero.getByRole("region", { name: "Claxedo graphical session" })).toBeVisible()
  await expect(page.locator("[data-story-step]")).toHaveCount(5)
  await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0)
  await expect(page.getByRole("link", { name: "Why Claxedo" })).toHaveCount(0)
  await expect(page.locator(".faq-list details")).toHaveCount(5)
  await expect(page.getByRole("link", { name: "Framework" })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
})

test("presents every feature as editorial copy plus focused evidence", async ({ page }) => {
  await page.goto("/#performance")
  for (const [id, heading] of [
    ["performance", "Claxedo is faster than T3 Code."],
    ["sandboxes", "Your sandbox is a setting, not a platform decision."],
    ["chat", "One chat surface. Every harness underneath."],
    ["terminal", "Prefer the real CLI? Keep the real CLI."],
    ["control-plane", "Deploy once. Put every workspace within reach."],
  ] as const) {
    const feature = page.locator(`[data-story-step="${id}"]`)
    await feature.scrollIntoViewIfNeeded()
    await expect(feature.getByRole("heading", { name: heading })).toBeVisible()
    await expect(feature.locator(".feature-canvas, [data-app-replica]")).toHaveCount(1)
  }
})

test("shows only published benchmark evidence in the fast panel", async ({ page }) => {
  await page.goto("/#performance")
  const panel = page.getByLabel("Claxedo versus T3 Code benchmark results")
  await expect(panel.getByText("90%", { exact: true })).toBeVisible()
  await expect(panel.getByText("of measurements won", { exact: true })).toBeVisible()
  await expect(panel.getByText("3.47×", { exact: true })).toBeVisible()
  await expect(panel.getByText("6.6×", { exact: true })).toBeVisible()
  await expect(panel.getByText("Switch session", { exact: true })).toHaveCount(0)
  await expect(page.locator("[data-story-step=performance] [data-app-replica]")).toHaveCount(0)
})

test("configures a supported sandbox provider in the real settings crop", async ({ page }) => {
  await page.goto("/#sandboxes")
  const settings = page.getByRole("region", { name: "Claxedo Sandbox Provider settings" })
  await settings.getByRole("button", { name: "Sandbox provider", exact: true }).click()
  const exeOption = settings.locator("[data-provider-option=exe]")
  await expect(exeOption.locator(".provider-monogram")).toHaveText("E")
  await expect(exeOption.locator("svg")).toHaveCount(0)
  const providerRow = await exeOption.evaluate((row) => {
    const icon = row.children[0].getBoundingClientRect()
    const label = row.children[1].getBoundingClientRect()
    const check = row.children[2].getBoundingClientRect()
    const bounds = row.getBoundingClientRect()
    return {
      iconBeforeLabel: icon.right < label.left,
      labelAlign: getComputedStyle(row.children[1]).textAlign,
      checkPinnedRight: bounds.right - check.right < 12,
    }
  })
  expect(providerRow).toEqual({ iconBeforeLabel: true, labelAlign: "left", checkPinnedRight: true })
  await settings.getByRole("option", { name: "Cloudflare" }).click()
  await expect(settings.locator("[data-provider-name]")).toHaveText("Cloudflare")
  const cloudflare = settings.locator("[data-driver-fields=cloudflare]")
  await cloudflare.getByLabel("API Token").fill("test-token")
  await cloudflare.getByLabel("Worker URL").fill("https://sandbox.example.workers.dev")
  await settings.getByRole("button", { name: "Save" }).click()
  await expect(settings.getByText("Credentials configured")).toBeVisible()
  await expect(settings.getByRole("button", { name: "Remove" })).toBeVisible()
})

test("uses the same accordion harness, model, and effort flow as Claxedo", async ({ page }) => {
  await page.goto("/#chat")
  const chat = page.getByRole("region", { name: "Claxedo chat harness and model picker" })
  await chat.locator("[data-picker-section=harness]").click()
  await chat.locator("[data-harness=Codex]").click()
  await expect(chat.locator("[data-current-harness]")).toHaveText("Codex")
  await chat.locator("[data-model='GPT-5.6-Sol']").click()
  await expect(chat.locator("[data-current-model]")).toHaveText("GPT-5.6-Sol")
  await chat.locator("[data-picker-section=effort]").click()
  await chat.locator("[data-effort=High]").click()
  await expect(chat.locator("[data-current-effort]")).toHaveText("High")
})

test("reuses the app canvas for terminal tabs and keeps deployment interactive", async ({ page }) => {
  await page.goto("/#terminal")
  const terminal = page.locator("[data-story-step=terminal] [data-app-replica]")
  await expect(terminal).toHaveAttribute("data-sidebar", "closed")
  await expect(terminal).toHaveAttribute("data-panel", "closed")
  await expect(terminal.getByRole("tablist", { name: "Workbench panes" })).toBeVisible()
  await expect(terminal.getByRole("tab", { name: "Codex", exact: true })).toBeVisible()
  await expect(terminal.locator("[data-terminal-session=terminal-codex]").getByText("OpenAI Codex")).toBeVisible()
  await terminal.getByRole("tab", { name: "Claude", exact: true }).click()
  await expect(terminal.locator("[data-terminal-session=terminal-claude]").getByText("Claude Code")).toBeVisible()
  await terminal.getByRole("tab", { name: "Codex", exact: true }).click()
  await expect(terminal.locator("[data-terminal-session=terminal-codex]").getByText("OpenAI Codex")).toBeVisible()
  await terminal.getByRole("button", { name: "Show Sidebar" }).click()
  await expect(terminal.getByRole("complementary", { name: "Projects and sessions" })).toBeVisible()
  await terminal.getByRole("button", { name: "Hide Sidebar" }).click()
  await expect(terminal).toHaveAttribute("data-sidebar", "closed")

  const deploy = page.getByRole("region", { name: "Deploy Claxedo control plane" })
  await deploy.getByRole("button", { name: /Deploy control plane/ }).click()
  await expect(deploy).toHaveAttribute("data-state", "online", { timeout: 2_000 })
  await expect(deploy.getByText("Control plane online")).toBeVisible()
})

test("keeps terminal session tabs usable on mobile", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium")
  await page.goto("/#terminal")
  const terminal = page.locator("[data-story-step=terminal] [data-app-replica]")
  await expect(terminal.getByRole("tab", { name: "Codex", exact: true })).toBeVisible()
  await terminal.getByRole("tab", { name: "Claude", exact: true }).click()
  await expect(terminal.locator("[data-terminal-session=terminal-claude]").getByText("Claude Code")).toBeVisible()
})

test("switches the hero between chat, terminal, sidebar, tabs, and environment", async ({ page }) => {
  await page.goto("/")
  const hero = page.locator("[data-app-replica]").first()
  await expect(hero).toHaveAttribute("data-sidebar", "closed")
  await expect(hero).toHaveAttribute("data-panel", "closed")
  if (page.viewportSize()!.width > 920) await expect(hero.getByRole("complementary", { name: "Session environment" })).toBeVisible()
  await hero.getByRole("button", { name: "New Terminal" }).click()
  await expect(hero.getByRole("region", { name: "Claxedo terminal session" })).toBeVisible()
  await hero.getByRole("button", { name: "Show Sidebar" }).click()
  await hero.locator("[data-session-id=sandbox-provider-flag]").click()
  await expect(hero.getByRole("region", { name: "Claxedo graphical session" })).toBeVisible()
  await hero.getByRole("button", { name: "New Terminal" }).click()
  if (await hero.getAttribute("data-sidebar") === "open") await hero.getByRole("button", { name: "Hide Sidebar" }).click()
  await expect(hero.getByRole("complementary", { name: "Projects and sessions" })).toBeHidden()
  await expect(hero.getByRole("tablist", { name: "Workbench panes" })).toBeVisible()
})

test("adds new chat and terminal sessions to both navigation modes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium")
  await page.goto("/")
  const hero = page.locator("[data-app-replica]").first()

  await hero.getByRole("button", { name: "New Session", exact: true }).click()
  const newSessionRow = hero.locator("[data-session-id='created-chat-1']")
  await expect(newSessionRow).toContainText("New Session")
  await expect(hero.getByRole("heading", { name: "New Session" })).toBeVisible()

  await hero.getByRole("button", { name: "New Terminal" }).click()
  const newTerminalRow = hero.locator("[data-session-id='created-terminal-1']")
  await expect(newTerminalRow).toContainText("Terminal 1")
  await expect(hero.getByRole("region", { name: "Claxedo terminal session" })).toBeVisible()

  await expect(hero).toHaveAttribute("data-sidebar", "closed")
  await expect(hero.getByRole("tab", { name: "New Session", exact: true })).toBeVisible()
  await expect(hero.getByRole("tab", { name: "Terminal 1", exact: true })).toBeVisible()
  await hero.getByRole("tab", { name: "New Session", exact: true }).click()
  await expect(hero.getByRole("region", { name: "Claxedo graphical session" })).toBeVisible()
  await hero.getByRole("tab", { name: "Terminal 1", exact: true }).click()
  await expect(hero.getByRole("region", { name: "Claxedo terminal session" })).toBeVisible()
})

test("uses icon-only composer controls when the session pane is narrow", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium")
  await page.setViewportSize({ width: 1024, height: 900 })
  await page.goto("/")
  const hero = page.locator("[data-app-replica]").first()
  await hero.getByRole("button", { name: "Open workspace panel" }).click()
  await expect(hero).toHaveAttribute("data-panel", "open")
  await expect(hero.locator(".permission-control [data-permission-label]")).toBeHidden()
  await expect(hero.locator("[data-hero-model-trigger]")).toBeHidden()
  await expect(hero.locator("[data-hero-effort-trigger]")).toBeHidden()

  await hero.getByRole("button", { name: "Close workspace panel" }).click()
  await expect(hero.locator(".permission-control [data-permission-label]")).toBeVisible()
  await expect(hero.locator("[data-hero-model-trigger]")).toBeVisible()
  await expect(hero.locator("[data-hero-effort-trigger]")).toBeVisible()
})

test("keeps hero tabs, sessions, transcripts, drafts, context, and selectors in one state", async ({ page }) => {
  await page.goto("/")
  const hero = page.locator("[data-app-replica]").first()
  const composer = hero.getByLabel("Session prompt")

  await composer.fill("provider draft")
  await hero.getByRole("button", { name: "Show Sidebar" }).click()
  await hero.locator("[data-session-id=sandbox-usage-limits]").click()
  await expect(hero.getByRole("heading", { name: "usage limit is not working" })).toBeVisible()
  await expect(hero.getByText("Show the active sandbox quota before starting a cloud workspace")).toBeVisible()
  await composer.fill("sandbox draft")

  if (page.viewportSize()!.width >= 768) await hero.getByRole("button", { name: "Hide Sidebar" }).click()
  await hero.getByRole("tab", { name: "I need to test cloud sandbox usage thing..." }).click()
  await expect(hero.getByRole("heading", { name: "I need to test cloud sandbox usage thing..." })).toBeVisible()
  await expect(hero.getByText("I need to test cloud sandbox usage thing works or not.")).toBeVisible()
  await expect(composer).toHaveValue("provider draft")
  await hero.getByRole("tab", { name: "usage limit is not working" }).click()
  await expect(composer).toHaveValue("sandbox draft")

  await hero.getByRole("button", { name: "Open workspace panel" }).click()
  await expect(hero.getByRole("complementary", { name: "Workspace panel" })).toBeVisible()
  await expect(hero.getByRole("button", { name: "Close workspace panel" })).toBeVisible()
  const maximize = hero.getByRole("button", { name: "Maximize workspace panel" })
  await expect(maximize).toBeVisible()
  await maximize.click()
  await expect(hero).toHaveAttribute("data-panel-width", "full")
  await hero.getByRole("button", { name: "Restore workspace panel width" }).click()
  await expect(hero).toHaveAttribute("data-panel-width", "split")
  await hero.locator(".review-toolbar").getByRole("button", { name: "Open files" }).click()
  await expect(hero.locator("[data-panel-view=files]").getByLabel("Search files")).toBeVisible()
  await hero.locator(".review-toolbar").getByRole("button", { name: "Open review" }).click()
  await expect(hero.getByText(".github/workflows/docs-links.yml")).toBeVisible()
  if (page.viewportSize()!.width >= 768) {
    const folder = hero.locator("[data-repo-folder='.agent-extensions']")
    await folder.click()
    await expect(folder).toHaveAttribute("aria-expanded", "true")
    await expect(hero.locator("[data-repo-children]")).toBeVisible()
  }
  await hero.getByRole("button", { name: "Close workspace panel" }).click()

  if (page.viewportSize()!.width >= 768) {
    await hero.getByRole("button", { name: "Collapse Environment" }).click()
    await expect(hero).toHaveAttribute("data-environment", "collapsed")
    await hero.getByRole("button", { name: "Expand Environment" }).click()
    await expect(hero).toHaveAttribute("data-environment", "expanded")
  }

  await hero.getByRole("button", { name: "Add context" }).click()
  await hero.locator("[data-context-option='Images and files']").click()
  await expect(hero.locator("[data-composer-context-chip]")).toContainText("Images and files")

  await hero.getByRole("button", { name: "Select permission mode" }).click()
  await hero.locator("[data-permission='Full access']").click()
  await expect(hero.locator("[data-permission-label]")).toHaveText("Full access")

  await hero.getByRole("button", { name: "Select harness and model" }).click()
  await hero.locator("[data-harness-section=harness]").click()
  await hero.locator("[data-hero-harness=Claude]").click()
  await expect(hero.locator("[data-hero-model-label]")).toHaveText("Opus 5")
  await expect(hero.locator("[data-current-harness]")).toHaveText("Claude")
})

test("keeps the Claxedo shell and source icons aligned across every responsive band", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium")

  for (const viewport of [
    { width: 1440, height: 1000, sidebar: "closed", panel: "closed" },
    { width: 1024, height: 900, sidebar: "closed", panel: "closed" },
    { width: 768, height: 900, sidebar: "closed", panel: "closed" },
    { width: 767, height: 900, sidebar: "closed", panel: "closed" },
    { width: 390, height: 844, sidebar: "closed", panel: "closed" },
    { width: 320, height: 800, sidebar: "closed", panel: "closed" },
  ] as const) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto("/")
    const hero = page.locator("[data-app-replica]").first()
    await expect(hero).toHaveAttribute("data-sidebar", viewport.sidebar)
    await expect(hero).toHaveAttribute("data-panel", viewport.panel)
    await expect(page.locator("[data-story-step=terminal] [data-app-replica]")).toHaveAttribute("data-sidebar", "closed")
    await page.waitForTimeout(200)

    const audit = await page.evaluate(() => {
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"
      }
      const app = document.querySelector<HTMLElement>("[data-app-replica]")!
      const appRect = app.getBoundingClientRect()
      const iconButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
        .filter(visible)
        .filter((button) => button.children.length === 1 && button.firstElementChild?.tagName === "svg")
        .filter((button) => Array.from(button.childNodes).every((node) => node.nodeType === Node.ELEMENT_NODE || !node.textContent?.trim()))
      const misaligned = iconButtons.flatMap((button) => {
        const icon = button.firstElementChild!.getBoundingClientRect()
        const box = button.getBoundingClientRect()
        const dx = Math.abs(icon.left + icon.width / 2 - (box.left + box.width / 2))
        const dy = Math.abs(icon.top + icon.height / 2 - (box.top + box.height / 2))
        return dx > 1.25 || dy > 1.25 ? [{ label: button.getAttribute("aria-label") ?? button.textContent?.trim(), dx, dy }] : []
      })
      const oversizedMarks = Array.from(document.querySelectorAll<SVGElement>("[data-harness-mark], .harness-logo svg, .provider-logo-stack svg, .provider-option-logo svg"))
        .filter(visible)
        .flatMap((mark) => {
          const rect = mark.getBoundingClientRect()
          return rect.width > 24 || rect.height > 24 ? [{ width: rect.width, height: rect.height }] : []
        })
      return {
        documentOverflow: document.documentElement.scrollWidth - innerWidth,
        appLeft: appRect.left,
        appRightOverflow: appRect.right - innerWidth,
        misaligned,
        oversizedMarks,
      }
    })

    expect(audit.documentOverflow, `${viewport.width}px document overflow`).toBeLessThanOrEqual(0)
    expect(audit.appLeft, `${viewport.width}px app left edge`).toBeGreaterThanOrEqual(0)
    expect(audit.appRightOverflow, `${viewport.width}px app right edge`).toBeLessThanOrEqual(0.5)
    expect(audit.misaligned, `${viewport.width}px icon alignment`).toEqual([])
    expect(audit.oversizedMarks, `${viewport.width}px source mark sizing`).toEqual([])

    const [composerBox, scrollBox] = await Promise.all([
      hero.locator(".composer").boundingBox(),
      hero.getByRole("button", { name: "Scroll to latest message" }).boundingBox(),
    ])
    const composerCenter = composerBox!.x + composerBox!.width / 2
    const scrollCenter = scrollBox!.x + scrollBox!.width / 2
    expect(Math.abs(composerCenter - scrollCenter), `${viewport.width}px scroll control center`).toBeLessThanOrEqual(1.25)
    const scrollGap = composerBox!.y - (scrollBox!.y + scrollBox!.height)
    expect(scrollGap, `${viewport.width}px scroll control top gap`).toBeGreaterThanOrEqual(7.5)
    expect(scrollGap, `${viewport.width}px scroll control top gap`).toBeLessThanOrEqual(12)

    if (viewport.width < 768) {
      await hero.getByRole("button", { name: "Select harness and model" }).click()
      const popover = hero.locator("[data-composer-popover=harness]")
      await expect(popover).toBeVisible()
      const [appBox, popoverBox] = await Promise.all([hero.boundingBox(), popover.boundingBox()])
      expect(popoverBox!.x - appBox!.x, `${viewport.width}px picker left inset`).toBeGreaterThanOrEqual(6)
      expect(appBox!.x + appBox!.width - popoverBox!.x - popoverBox!.width, `${viewport.width}px picker right inset`).toBeGreaterThanOrEqual(6)
      await hero.getByRole("button", { name: "Select harness and model" }).click()
    }
  }
})
