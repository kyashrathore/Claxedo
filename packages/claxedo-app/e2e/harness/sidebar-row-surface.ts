import sharp from "sharp"
import type { Locator, Page, TestInfo } from "@playwright/test"
import { expect, SCRIPTED_ACP_HARNESS, UI, type ClaxedoApi, type Stack } from "./index"
import { sidebarFilter } from "./sidebar-filter"

async function surfacePixels(target: Locator): Promise<readonly number[][]> {
  const { data, info } = await sharp(await target.screenshot()).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const pixel = (x: number) => Array.from(data.subarray((5 * info.width + x) * info.channels, (5 * info.width + x) * info.channels + 3))
  return [pixel(100), pixel(info.width - 50), pixel(info.width - 26), pixel(info.width - 12)]
}

async function flatActionSurface(target: Locator): Promise<void> {
  const surface = await target.getByRole("button", { name: /^Settle / }).evaluate((element) => {
    const overlay = getComputedStyle(element.parentElement!.parentElement!)
    const row = getComputedStyle(element.closest('[data-slot="session-navigation-row"]')!)
    return { sameImage: overlay.backgroundImage === row.backgroundImage, sameColor: overlay.backgroundColor === row.backgroundColor, shadow: overlay.boxShadow, blur: overlay.backdropFilter, duration: overlay.transitionDuration }
  })
  expect(surface).toEqual({ sameImage: true, sameColor: true, shadow: "none", blur: "none", duration: "0s" })
}

export async function sidebarRowSurfaces(app: Page, first: Locator, second: Locator, gap: number): Promise<void> {
  const rows = [await first.boundingBox(), await second.boundingBox()].sort((left, right) => left!.y - right!.y)
  expect(rows[1]!.y - rows[0]!.y - rows[0]!.height).toBe(gap)
  for (const colorScheme of ["dark", "light"] as const) {
    await app.emulateMedia({ colorScheme })
    await second.getByRole("button").first().click({ position: { x: 24, y: 10 } })
    await expect(second).toHaveAttribute("data-active", "true")
    await first.hover()
    await expect.poll(() => first.getByRole("button", { name: /^Settle / }).evaluate((element) => getComputedStyle(element.parentElement!.parentElement!).opacity)).toBe("1")
    await flatActionSurface(first)
    const hovered = await surfacePixels(first)
    for (const pixel of hovered) expect(pixel).toEqual(hovered[0])
    await second.hover()
    await expect.poll(() => second.getByRole("button", { name: /^Settle / }).evaluate((element) => getComputedStyle(element.parentElement!.parentElement!).opacity)).toBe("1")
    const selected = await surfacePixels(second)
    for (const pixel of selected) expect(pixel).toEqual(selected[0])
    expect(selected[0]).toEqual(hovered[0])
    await expect(second.locator('[data-slot="session-navigation-title"]')).toHaveCSS("font-weight", "400")
    await app.getByRole("button", { name: "Session options", exact: true }).focus()
    await app.mouse.move(900, 500)
    const resting = await surfacePixels(first)
    expect(hovered[0]).not.toEqual(resting[0])
    for (const pixel of resting) expect(pixel).toEqual(resting[0])
  }
  await app.emulateMedia({ colorScheme: "dark" })
}

async function surfaceGeometry(app: Page, hook: string, gap: number, phone: boolean): Promise<void> {
  const rows = app.getByTestId(hook)
  await expect(rows).toHaveCount(2)
  const first = rows.filter({ has: app.getByRole("button", { name: "Upper", exact: true }) })
  const second = rows.filter({ has: app.getByRole("button", { name: "Lower", exact: true }) })
  if (!phone) return sidebarRowSurfaces(app, first, second, gap)
  const bounds = await rows.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON()))
  expect(bounds[1]!.top - bounds[0]!.bottom).toBe(gap)
  const check = first.getByRole("button", { name: "Settle Upper", exact: true })
  const box = await check.boundingBox()
  expect(box!.width).toBeGreaterThanOrEqual(44)
  expect(box!.height).toBeGreaterThanOrEqual(44)
  expect(await check.evaluate((element) => getComputedStyle(element.parentElement!.parentElement!).boxShadow)).toBe("none")
}

export async function sessionRowSurfaceRefinement(stack: Stack, api: ClaxedoApi, app: Page, phone: boolean, info: TestInfo): Promise<void> {
  const workspace = await stack.daemon.makeWorkspace("row-surfaces", "Row surfaces")
  const first = await api.createSession(workspace.directory, { title: "Upper", harness: SCRIPTED_ACP_HARNESS })
  await api.createSession(workspace.directory, { title: "Lower", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}/`)
  if (phone) {
    await app.getByRole("button", { name: UI.openRail }).tap()
    await expect(app.getByRole("navigation", { name: UI.rail })).toBeInViewport({ ratio: 1 })
  }
  await surfaceGeometry(app, "rail-sidebar-session-row", 2, phone)
  await sidebarFilter(app, "Activity", phone)
  await surfaceGeometry(app, "activity-session-row", 4, phone)
  await info.attach("flat-action-surfaces", { body: await app.screenshot(), contentType: "image/png" })
  expect((await api.session(workspace.directory, first.id)).title).toBe("Upper")
}
