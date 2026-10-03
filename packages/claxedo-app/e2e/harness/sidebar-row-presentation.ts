import type { Locator, Page, TestInfo } from "@playwright/test"
import { expect, SCRIPTED_ACP_HARNESS, UI, type ClaxedoApi, type Stack } from "./index"
import { sidebarFilter } from "./sidebar-filter"
import { sidebarRowSurfaces } from "./sidebar-row-surface"

const LONG_TITLE = "Investigate the session lifecycle and preserve canonical facts: END OF TITLE"
type CanonicalRow = { readonly sessionId: string; readonly projectName: string; readonly placement: { readonly machineName: string } }

function row(app: Page, title: string, activity = false): Locator {
  return app.getByTestId(activity ? "activity-session-row" : "rail-sidebar-session-row").filter({ has: app.getByRole("button", { name: title, exact: true }) })
}

async function resetEngagement(app: Page): Promise<void> {
  const button = app.getByRole("button", { name: "Session options", exact: true })
  await button.focus()
  await app.mouse.move(900, 500)
}

async function cappedTooltip(app: Page, value: string): Promise<void> {
  const tooltip = app.getByRole("tooltip", { name: value, exact: true })
  await expect(tooltip).toHaveText(value)
  const dimensions = await tooltip.evaluate((element) => {
    const style = getComputedStyle(element)
    return { width: element.getBoundingClientRect().width, maxWidth: style.maxWidth, wrapping: style.whiteSpace, wordWrap: style.overflowWrap }
  })
  expect(dimensions.width).toBeLessThanOrEqual(260)
  expect(dimensions.wrapping).toBe("normal")
  expect(dimensions.wordWrap).toBe("anywhere")
  expect(dimensions.maxWidth).toContain("260px")
}

async function motionOnce(app: Page, target: Locator, fitting: Locator): Promise<void> {
  const clip = target.locator('[data-slot="session-navigation-title"]')
  const text = target.locator('[data-slot="session-title-text"]')
  await resetEngagement(app)
  await expect(clip).toHaveCSS("text-overflow", "ellipsis")
  await expect(clip).not.toHaveAttribute("data-overflow")
  const before = await clip.boundingBox()
  await target.hover()
  await expect(clip).toHaveAttribute("data-overflow", "true")
  expect(await clip.boundingBox()).toEqual(before)
  await expect.poll(() => text.evaluate((element) => element.getAnimations().length)).toBe(1)
  const pace = await text.evaluate((element) => {
    const clip = element.parentElement!
    return { distance: Number.parseFloat(getComputedStyle(clip).getPropertyValue("--session-title-distance")), duration: Number.parseFloat(getComputedStyle(clip).getPropertyValue("--session-title-duration")), timing: getComputedStyle(element).transitionTimingFunction }
  })
  expect(pace.distance / (pace.duration / 1000)).toBeCloseTo(35, 1)
  expect(pace.timing).toBe("linear")
  await text.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)))
  const end = await text.evaluate((element) => {
    const clip = element.parentElement!
    const distance = Number.parseFloat(getComputedStyle(clip).getPropertyValue("--session-title-distance"))
    const x = new DOMMatrixReadOnly(getComputedStyle(element).transform).m41
    return { distance, x, animations: element.getAnimations().length, right: element.getBoundingClientRect().right }
  })
  expect(end.distance).toBeGreaterThan(0)
  expect(end.x).toBeCloseTo(-end.distance, 1)
  expect(end.animations).toBe(0)
  const actionLeft = await target.getByRole("button", { name: `Settle ${LONG_TITLE}`, exact: true }).evaluate((element) => element.parentElement!.parentElement!.getBoundingClientRect().left)
  expect(end.right).toBeLessThanOrEqual(actionLeft)
  await fitting.hover()
  await expect(clip).not.toHaveAttribute("data-overflow")
  expect(await text.evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).m41)).toBe(0)
  await expect(fitting.locator('[data-slot="session-navigation-title"]')).not.toHaveAttribute("data-overflow")
  expect(await fitting.locator('[data-slot="session-title-text"]').evaluate((element) => element.getAnimations().length)).toBe(0)
}

async function reducedMotionAndFocus(app: Page, target: Locator): Promise<void> {
  await resetEngagement(app)
  await app.emulateMedia({ reducedMotion: "reduce" })
  await target.hover()
  await expect(target.locator('[data-slot="session-navigation-title"]')).not.toHaveAttribute("data-overflow")
  expect(await target.locator('[data-slot="session-title-text"]').evaluate((element) => element.getAnimations().length)).toBe(0)
  await resetEngagement(app)
  await target.getByRole("button", { name: LONG_TITLE, exact: true }).focus()
  await app.keyboard.press("Shift+Tab")
  await app.keyboard.press("Tab")
  await expect(target.getByRole("button", { name: LONG_TITLE, exact: true })).toBeFocused()
  await cappedTooltip(app, LONG_TITLE)
  const tooltip = await app.getByRole("tooltip", { name: LONG_TITLE, exact: true }).boundingBox()
  expect(tooltip!.height).toBeGreaterThan(32)
  await target.getByRole("button", { name: `Settle ${LONG_TITLE}`, exact: true }).focus()
  await cappedTooltip(app, "Settle")
  await app.emulateMedia({ reducedMotion: "no-preference" })
}

async function actionOverlay(app: Page, target: Locator, phone: boolean): Promise<void> {
  const check = target.getByRole("button", { name: `Settle ${LONG_TITLE}`, exact: true })
  const before = await target.locator('[data-slot="session-navigation-title"]').boundingBox()
  if (phone) {
    expect(await check.evaluate((element) => element.checkVisibility({ checkOpacity: true }))).toBe(true)
    const box = await check.boundingBox()
    expect(box!.width).toBeGreaterThanOrEqual(44)
    expect(box!.height).toBeGreaterThanOrEqual(44)
  } else {
    await resetEngagement(app)
    await expect.poll(() => check.evaluate((element) => element.checkVisibility({ checkOpacity: true }))).toBe(false)
    await target.hover()
    await check.hover()
    const overlay = await check.evaluate((element) => {
      const style = getComputedStyle(element.parentElement!.parentElement!)
      const row = element.closest('[data-slot="session-navigation-row"]')!.getBoundingClientRect()
      const overlay = element.parentElement!.parentElement!.getBoundingClientRect()
      return { position: style.position, fill: style.backgroundImage, shadow: style.boxShadow, blur: style.backdropFilter, row: row.toJSON(), overlay: overlay.toJSON() }
    })
    expect(overlay.position).toBe("absolute")
    expect(overlay.fill).toContain("linear-gradient")
    expect(overlay.shadow).toBe("none")
    expect(overlay.blur).toBe("none")
    expect(overlay.fill.match(/linear-gradient/g)).toHaveLength(1)
    expect(overlay.overlay.right).toBe(overlay.row.right)
    expect(overlay.overlay.top).toBe(overlay.row.top)
    expect(overlay.overlay.height).toBe(overlay.row.height)
    await cappedTooltip(app, "Settle")
  }
  expect(await target.locator('[data-slot="session-navigation-title"]').boundingBox()).toEqual(before)
  await check.focus()
  await app.keyboard.press("Shift+Tab")
  await app.keyboard.press("Tab")
  await expect(check).toBeFocused()
  await expect.poll(() => check.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)")
  const surface = await check.evaluate((element) => ({ shadow: getComputedStyle(element).boxShadow, fill: getComputedStyle(element).backgroundColor }))
  expect(surface.shadow).not.toBe("none")
  expect(surface.fill).not.toBe("rgba(0, 0, 0, 0)")
}

async function projectContext(app: Page, target: Locator, canonical: CanonicalRow, phone: boolean): Promise<void> {
  const project = target.getByText(canonical.projectName, { exact: true })
  const marker = target.getByRole("img", { name: canonical.placement.machineName, exact: true })
  await resetEngagement(app)
  const resting = await marker.evaluate((element) => element.parentElement!.checkVisibility({ checkOpacity: true }))
  expect(resting).toBe(phone)
  await marker.focus()
  await cappedTooltip(app, canonical.placement.machineName)
  const projectBox = await project.boundingBox()
  const markerBox = await marker.boundingBox()
  const titleBox = await target.locator('[data-slot="session-navigation-title"]').boundingBox()
  expect(projectBox!.y).toBeGreaterThan(titleBox!.y)
  const checkBox = await target.getByRole("button", { name: `Settle ${LONG_TITLE}`, exact: true }).boundingBox()
  expect(markerBox!.x).toBeGreaterThanOrEqual(projectBox!.x + projectBox!.width)
  expect(markerBox!.x + markerBox!.width).toBeLessThanOrEqual(checkBox!.x)
  expect(markerBox!.y + markerBox!.height / 2).toBe(checkBox!.y + checkBox!.height / 2)
  expect(Math.abs(projectBox!.y + projectBox!.height / 2 - checkBox!.y - checkBox!.height / 2)).toBeLessThanOrEqual(1)
  const glyph = await marker.locator("svg").boundingBox()
  expect(glyph!.width).toBe(12)
  expect(glyph!.height).toBe(12)
  expect(await project.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeLessThanOrEqual(12)
  if (phone) {
    expect(markerBox!.width).toBeGreaterThanOrEqual(44)
    expect(markerBox!.height).toBeGreaterThanOrEqual(44)
  } else {
    await resetEngagement(app)
    await target.hover()
    expect(await marker.evaluate((element) => element.parentElement!.checkVisibility({ checkOpacity: true }))).toBe(true)
  }
}

async function headings(app: Page): Promise<void> {
  for (const name of [/^\d+ working$/, /^\d+ settled$/]) {
    const heading = app.getByRole("button", { name })
    const styles = await heading.evaluate((element) => {
      const count = element.querySelector("span")!
      const caret = element.querySelector("svg")!
      return { size: getComputedStyle(element).fontSize, weight: getComputedStyle(element).fontWeight, countSize: Number.parseFloat(getComputedStyle(count).fontSize), caretSize: caret.getBoundingClientRect().width, caretOpacity: Number.parseFloat(getComputedStyle(caret).opacity) }
    })
    expect(styles.size).toBe("13px")
    expect(Number(styles.weight)).toBe(400)
    expect(styles.countSize).toBeLessThan(13)
    expect(styles.caretSize).toBe(12)
    expect(styles.caretOpacity).toBeLessThan(0.7)
  }
}

export async function sessionRowPresentation(stack: Stack, api: ClaxedoApi, app: Page, phone: boolean, testInfo: TestInfo): Promise<void> {
  const workspace = await stack.daemon.makeWorkspace("row-presentation", "Presentation project")
  const long = await api.createSession(workspace.directory, { title: LONG_TITLE, harness: SCRIPTED_ACP_HARNESS })
  await api.createSession(workspace.directory, { title: "Short title", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}/`)
  await app.emulateMedia({ colorScheme: "dark" })
  if (phone) {
    await app.getByRole("button", { name: UI.openRail }).tap()
    await expect(app.getByRole("navigation", { name: UI.rail })).toBeInViewport({ ratio: 1 })
  }
  else await app.setViewportSize({ width: 1512, height: 982 })
  await expect(row(app, LONG_TITLE)).toBeVisible()
  await expect(app.getByTestId("project-header").getByText("Presentation project", { exact: true })).toHaveCSS("font-size", "12px")
  await expect(app.getByTestId("project-header").getByText("Presentation project", { exact: true })).toHaveCSS("font-weight", "400")
  await expect(app.locator('[data-slot="session-sidebar-heading"]').getByRole("heading", { name: "Projects", exact: true })).toHaveCSS("font-size", "12px")
  await expect(app.locator('[data-slot="session-sidebar-heading"]').getByRole("heading", { name: "Projects", exact: true })).toHaveCSS("font-weight", "400")
  if (!phone) {
    await motionOnce(app, row(app, LONG_TITLE), row(app, "Short title"))
    await reducedMotionAndFocus(app, row(app, LONG_TITLE))
  }
  await actionOverlay(app, row(app, LONG_TITLE), phone)
  if (!phone) await sidebarRowSurfaces(app, row(app, LONG_TITLE), row(app, "Short title"), 2)
  await sidebarFilter(app, "Activity", phone)
  await expect(app.locator('[data-slot="session-sidebar-heading"]').getByRole("heading", { name: "Activity", exact: true })).toHaveCSS("font-size", "12px")
  await expect(app.getByRole("button", { name: "0 settled", exact: true })).toBeVisible()
  const response = await fetch(`${stack.url}/api/claxedo/session-list?scope=all&sort=human_turn_desc&settled=active&limit=50`)
  expect(response.status).toBe(200)
  const canonical = ((await response.json()) as { items: CanonicalRow[] }).items.find((item) => item.sessionId === long.id)!
  expect(canonical.projectName).toBe("Presentation project")
  expect(canonical.placement.machineName).toBeTruthy()
  await projectContext(app, row(app, LONG_TITLE, true), canonical, phone)
  await headings(app)
  if (!phone) await motionOnce(app, row(app, LONG_TITLE, true), row(app, "Short title", true))
  await actionOverlay(app, row(app, LONG_TITLE, true), phone)
  if (!phone) await sidebarRowSurfaces(app, row(app, LONG_TITLE, true), row(app, "Short title", true), 4)
  await resetEngagement(app)
  await testInfo.attach(phone ? "row-presentation-phone" : "row-presentation-desktop", { body: await app.screenshot(), contentType: "image/png" })
  expect(await app.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  expect((await api.session(workspace.directory, long.id)).title).toBe(LONG_TITLE)
}
