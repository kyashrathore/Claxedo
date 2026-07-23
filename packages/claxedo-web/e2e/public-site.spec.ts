import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"
import { claims } from "../src/content/claims"

const assertNoSeriousAccessibilityViolations = async (page: Page) => {
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual([])
}

const assertNoHorizontalOverflow = async (page: Page) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true)
}

const xmlLocations = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1])

const localPath = (value: string, base: string) => {
  if (/^(?:data:|mailto:|tel:|javascript:)/.test(value)) return
  const url = new URL(value, base)
  if (url.origin !== "https://claxedo.com" && url.origin !== "http://127.0.0.1:4321") return
  return `${url.pathname}${url.search}${url.hash}`
}

const localResponse = (request: APIRequestContext, path: string) => request.get(path.replace(/#.*$/, ""))

test("commercial homepage preserves the product narrative and two conversion classes", async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()))
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.resolve() } })
  })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/")

  await expect(page.getByRole("heading", { level: 1, name: "The open cloud workspace for coding agents." })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Work that outlives the session." })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Use the chat UI. Or use the terminal." })).toBeVisible()
  const narrative = [
    "The whole product is open.",
    "Move between desktop, browser, and mobile web.",
    "Keep the harnesses you already use.",
    "Use the chat UI. Or use the terminal.",
    "Work that outlives the session.",
    "Sync your tools automatically.",
  ]
  expect(await page.locator("main h2").allTextContents()).toEqual(expect.arrayContaining(narrative))
  expect(await page.locator("main h2").evaluateAll((headings, expected) =>
    expected.map((text) => headings.findIndex((heading) => heading.textContent?.trim() === text)), narrative,
  )).toEqual([...narrative.keys()])
  const events = await page.locator("[data-analytics-event]").evaluateAll((items) => [...new Set(items.map((item) => item.getAttribute("data-analytics-event")))].sort())
  expect(events).toEqual(["deploy_cloudflare", "open_claxedo"])
  await expect(page.locator('img[src="/screenshots/marketing-workspace.png"]')).toBeVisible()
  await expect(page.locator('img[src="/screenshots/marketing-session-terminal.png"]')).toBeVisible()
  await expect(page.locator('img[src="/screenshots/marketing-workgraph.png"]')).toBeVisible()
  await expect(page.locator("a.zoomable-image")).toHaveCount(3)
  expect(await page.locator("a.zoomable-image").evaluateAll((links) => links.every((link) => link.getAttribute("target") === "_blank"))).toBe(true)
  await expect(page.getByRole("heading", { name: "Bring ACP-compatible agents into the chat UI." })).toHaveCount(0)
  await expect(page.getByText("A real Claxedo workspace.", { exact: true })).toHaveCount(0)
  await expect(page.locator(".continuity-grid article")).toHaveCount(3)
  await expect(page.locator(".harness-grid article")).toHaveCount(6)
  await expect(page.getByRole("tab", { name: /Platform/ })).toHaveAttribute("aria-selected", "true")
  await page.getByRole("tab", { name: /Deployment/ }).click()
  await expect(page.locator('[data-architecture-panel="deployment"]')).toBeVisible()
  await expect(page).toHaveURL(/#architecture-deployment$/)
  const deploymentButton = page.locator('button[data-analytics-event="deploy_cloudflare"][data-analytics-placement="hero"]')
  const deploymentButtonWidth = await deploymentButton.evaluate((button) => button.getBoundingClientRect().width)
  await deploymentButton.click()
  await expect(page.getByRole("button", { name: /Prompt copied/ }).first()).toBeVisible()
  expect(await deploymentButton.evaluate((button) => button.getBoundingClientRect().width)).toBe(deploymentButtonWidth)
  await expect(page.getByText("Cloudflare deployment prompt copied.").first()).toBeAttached()

  await page.evaluate(() => document.addEventListener("click", (event) => event.preventDefault(), { capture: true }))
  await page.locator('a[data-analytics-event="open_claxedo"][data-analytics-placement="hero"]').click()
  expect(await page.evaluate(() => window.__claxedoAnalyticsEvents?.at(-1))).toEqual({ name: "open_claxedo", route: "/", placement: "hero" })

  await assertNoHorizontalOverflow(page)
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe("auto")
  await (await page.context().newCDPSession(page)).send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 })
  expect(await page.evaluate(() => visualViewport?.scale)).toBe(2)
  await assertNoHorizontalOverflow(page)
  await assertNoSeriousAccessibilityViolations(page)
  expect(errors).toEqual([])
  await page.screenshot({ path: testInfo.outputPath("homepage.png"), fullPage: true })
})

test("download, comparison, and framework journeys resolve", async ({ page, isMobile }, testInfo) => {
  await page.goto("/download")
  await expect(page.getByRole("heading", { level: 1, name: "Start entirely local." })).toBeVisible()
  await expect(page.locator('.download-list a[data-analytics-event="download_app"]')).toHaveCount(5)
  await page.screenshot({ path: testInfo.outputPath("download.png"), fullPage: true })

  await page.goto("/compare")
  await expect(page.locator(".cmp-cards a")).toHaveCount(6)
  await page.getByRole("link", { name: /Claxedo vs. Synara/ }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Claxedo vs. Synara" })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("comparison.png"), fullPage: true })

  await page.addInitScript(() => {
    const mode = new URL(location.href).searchParams.get("clipboard")
    if (mode === "copied") Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.resolve() } })
    if (mode === "denied") Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("denied")) } })
    if (mode === "unavailable") Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined })
  })
  await page.goto("/framework?clipboard=copied")
  await expect(page.getByRole("heading", { name: "The open-source foundation behind Claxedo." })).toBeVisible()
  await expect(page.getByText("Keep credentials in authenticated CLIs or the target platform's secret store.")).toBeVisible()
  await page.getByRole("button", { name: "Copy prompt" }).click()
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible()
  await expect(page.getByText("Prompt copied. Review the plan before the agent creates billable resources.")).toBeVisible()

  await page.goto("/framework?clipboard=denied")
  await page.getByRole("button", { name: "Copy prompt" }).click()
  await expect(page.getByText("Clipboard access was denied. Select the prompt and copy it manually.")).toBeVisible()

  await page.goto("/framework?clipboard=unavailable")
  await page.getByRole("button", { name: "Copy prompt" }).click()
  await expect(page.getByText("Clipboard access is unavailable. Select the prompt and copy it manually.")).toBeVisible()
  await expect(page.getByRole("link", { name: "Open Claxedo" }).first()).toHaveAttribute("href", "https://app.claxedo.com")
  await assertNoHorizontalOverflow(page)
  await assertNoSeriousAccessibilityViolations(page)
  await page.screenshot({ path: testInfo.outputPath("framework.png"), fullPage: true })

  await page.goto("/framework/guides/install")
  if (isMobile) {
    await page.locator("starlight-menu-button button").click()
    await expect(page.locator("#starlight__sidebar")).toBeVisible()
    await expect(page.getByText("On this page", { exact: true }).first()).toBeVisible()
  } else {
    await page.getByRole("button", { name: "Search" }).click()
    await expect(page.locator("dialog[open]")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.locator("#starlight__sidebar")).toBeVisible()
    await expect(page.getByRole("heading", { name: "On this page" })).toBeVisible()
  }
})

test("pricing and app transition publish the promised terms and metadata", async ({ page }) => {
  await page.goto("/pricing")
  await expect(page.getByRole("heading", { level: 1, name: "Free during beta." })).toBeVisible()
  await expect(page.getByText("One product. Your models and infrastructure.")).toBeVisible()
  expect(await page.locator('script[type="application/ld+json"]').evaluate((script) => script.textContent)).toContain('"price":"0"')

  await page.goto("/app")
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow")
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://claxedo.com/")
})

test("analytics failures do not block deployment prompt copying", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto("/")
  await page.evaluate(() => {
    window.claxedoAnalytics = { track: () => Promise.reject(new Error("provider unavailable")) }
  })
  await page.locator('button[data-analytics-event="deploy_cloudflare"][data-analytics-placement="hero"]').click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole("button", { name: /Prompt copied/ }).first()).toBeVisible()
  expect(errors).toEqual([])
})

test("conversion controls retain their meaning without JavaScript", async ({ browser, isMobile }) => {
  test.skip(Boolean(isMobile), "one no-JavaScript navigation check is sufficient")
  const context = await browser.newContext({ javaScriptEnabled: false })
  const page = await context.newPage()
  await page.goto("http://127.0.0.1:4321/")
  await expect(page.locator('button[data-analytics-event="deploy_cloudflare"][data-analytics-placement="hero"]')).toBeVisible()
  await expect(page.locator('a[data-analytics-event="open_claxedo"][data-analytics-placement="hero"]')).toHaveAttribute("href", "https://app.claxedo.com")
  await context.close()
})

test("representative public routes have no serious accessibility violations", async ({ page }) => {
  for (const path of ["/pricing", "/download", "/compare/synara", "/framework/guides/install"]) {
    await page.goto(path)
    await assertNoSeriousAccessibilityViolations(page)
  }
})

test("keyboard navigation and mobile menu keep conversions reachable", async ({ page, isMobile }) => {
  await page.goto("/")
  await page.keyboard.press("Tab")
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused()
  if (isMobile) {
    await page.getByRole("button", { name: "Menu" }).click()
    await expect(page.locator(".nav-actions").getByRole("button", { name: /Deploy to Cloudflare/ })).toBeVisible()
    await expect(page.locator(".nav-actions").getByRole("link", { name: /Open Claxedo/ })).toBeVisible()
  }
  await assertNoHorizontalOverflow(page)
})

test("machine-readable routes, canonicals, and internal references are valid", async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one fresh-build crawl is sufficient")
  const start = await request.get("/start.md")
  expect(start.ok()).toBe(true)
  expect(await start.text()).toContain("Do not expose an unauthenticated instance to the public internet")
  const llms = await request.get("/llms.txt")
  expect(llms.ok()).toBe(true)
  expect(await llms.text()).toContain("Agent entry and deployment safety: https://claxedo.com/start.md")
  const robots = await request.get("/robots.txt")
  expect(robots.ok()).toBe(true)
  expect(await robots.text()).toContain("Sitemap: https://claxedo.com/sitemap-index.xml")

  const sitemapIndex = await request.get("/sitemap-index.xml")
  const sitemapLocations = xmlLocations(await sitemapIndex.text())
  const pageLocations = (await Promise.all(sitemapLocations.map(async (location) =>
    xmlLocations(await (await localResponse(request, new URL(location).pathname)).text()),
  ))).flat()
  expect(pageLocations).not.toContain("https://claxedo.com/app")

  const failures: string[] = []
  const documentCache = new Map<string, string>()
  for (const location of pageLocations) {
    const path = new URL(location).pathname
    const response = await request.get(path)
    if (!response.ok()) {
      failures.push(`${path} returned ${response.status()}`)
      continue
    }
    const html = await response.text()
    documentCache.set(path, html)
    const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1]
    if (canonical !== new URL(location).href) failures.push(`${path} canonical ${canonical ?? "missing"} does not match ${location}`)

    for (const match of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
      const target = localPath(match[1], location)
      if (!target) continue
      const targetResponse = await localResponse(request, target)
      if (!targetResponse.ok()) failures.push(`${path} -> ${target} returned ${targetResponse.status()}`)
      if (!target.includes("#") || !targetResponse.ok()) continue
      const targetPath = target.replace(/#.*$/, "") || "/"
      const targetHtml = documentCache.get(targetPath) ?? await targetResponse.text()
      const id = decodeURIComponent(target.split("#")[1])
      if (!new RegExp(`\\sid=["']${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).test(targetHtml)) {
        failures.push(`${path} -> ${target} has no matching fragment`)
      }
    }
  }

  const home = await request.get("/")
  const graph = JSON.parse((await home.text()).match(/<script type="application\/ld\+json">([^<]+)<\/script>/)?.[1] ?? "null")
  expect(graph["@graph"].map((item: { "@type": string }) => item["@type"])).toEqual(["Organization", "WebSite", "SoftwareApplication", "SoftwareApplication"])
  const publicOutput = [...documentCache.values(), await start.text(), await llms.text()].join("\n")
  for (const withheld of claims.filter((claim) => claim.status === "withheld")) expect(publicOutput).not.toContain(withheld.publicWording)
  expect(publicOutput).not.toMatch(/\/Users\/[A-Za-z0-9._-]+/)
  expect(publicOutput).not.toContain("hero-app.png")
  expect(publicOutput).not.toContain("all-coding-agent-dark.png")
  expect(failures).toEqual([])
})
