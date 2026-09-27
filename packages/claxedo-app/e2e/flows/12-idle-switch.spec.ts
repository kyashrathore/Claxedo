import type { Page } from "@playwright/test"
import { apiRequests, expect, sessionRoute, test, UI } from "../harness"
import { seedTurns } from "./12-switch-paint.seed"

test.skip(({ isMobile }) => isMobile, "flow 12 runs at desktop width; flow 33 covers the phone")

const PAST_QUERY_COLLECTION = "11:00"

type Seeded = { readonly id: string; readonly title: string }

function emulateVisibility() {
  let hidden = false
  Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") })
  Object.defineProperty(Document.prototype, "hidden", { configurable: true, get: () => hidden })
  Reflect.set(window, "__claxedoSetHidden", (next: boolean) => {
    hidden = next
    document.dispatchEvent(new Event("visibilitychange"))
  })
}

function setHidden(app: Page, hidden: boolean) {
  return app.evaluate((next) => (Reflect.get(window, "__claxedoSetHidden") as (hidden: boolean) => void)(next), hidden)
}

function railRow(app: Page, session: Seeded) {
  return app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: session.title, exact: true })
}

async function expectShown(app: Page, session: Seeded) {
  const pane = app.locator(`[data-testid="session-page-root"][data-session-id="${session.id}"]`)
  await expect(pane.locator('[data-session-timeline-reveal-ready="true"]')).toBeVisible()
  await expect(pane.getByText(`${session.title} reply line 6.`).last()).toBeVisible()
  await expect(app.locator('[data-testid="rail-sidebar-session-row"][data-active="true"]')).toHaveAttribute("data-session-id", session.id)
}

async function idleTab(app: Page, settled: () => Promise<string[]>) {
  await settled()
  await setHidden(app, true)
  await app.clock.fastForward(PAST_QUERY_COLLECTION)
}

test("12 after the tab sits hidden past the query cache's collection time, each of the next two switches shows its session", async ({ stack, api, app }) => {
  const here = await stack.daemon.makeWorkspace("idle", "Idle")
  const first = await seedTurns(stack, api, here.directory, "First", 2)
  const second = await seedTurns(stack, api, here.directory, "Second", 2)
  const third = await seedTurns(stack, api, here.directory, "Third", 2)
  await app.addInitScript(emulateVisibility)
  await app.clock.install()
  const settled = apiRequests(app, stack.url)
  await app.goto(`${stack.url}${sessionRoute(here.id, first.id)}`)
  await expectShown(app, first)

  await idleTab(app, settled)
  await setHidden(app, false)
  await railRow(app, second).click()
  await expectShown(app, second)
  expect(await settled(), "the switch read the session it shows").toContain("/session/:session")
  await railRow(app, third).click()
  await expectShown(app, third)
})

test("12 a switch made while the tab is hidden past the query cache's collection time shows its session once the tab is visible", async ({ stack, api, app }) => {
  const here = await stack.daemon.makeWorkspace("hidden", "Hidden")
  const first = await seedTurns(stack, api, here.directory, "First", 2)
  const second = await seedTurns(stack, api, here.directory, "Second", 2)
  const third = await seedTurns(stack, api, here.directory, "Third", 2)
  await app.addInitScript(emulateVisibility)
  await app.clock.install()
  const settled = apiRequests(app, stack.url)
  await app.goto(`${stack.url}${sessionRoute(here.id, first.id)}`)
  await expectShown(app, first)

  await idleTab(app, settled)
  await railRow(app, second).click()
  await setHidden(app, false)
  await expectShown(app, second)
  await railRow(app, third).click()
  await expectShown(app, third)
})
