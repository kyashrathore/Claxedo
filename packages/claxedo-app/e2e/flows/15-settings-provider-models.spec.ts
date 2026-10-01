import { expect, test } from "../harness"
import type { Page } from "@playwright/test"
import type { Stack } from "../harness"

async function saveProvider(stack: Stack, providerID: string, name: string, count: number) {
  const models = Object.fromEntries(
    Array.from({ length: count }, (_, index) => {
      const id = `card-model-${String(index + 1).padStart(3, "0")}`
      return [id, { name: `Card Model ${String(index + 1).padStart(3, "0")}` }]
    }),
  )
  const response = await fetch(`${stack.url}/api/claxedo/agent-config/providers/custom?nativeHarness=opencode`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      providerID,
      name,
      baseURL: stack.scripted.url,
      env: [],
      headers: {},
      models,
    }),
  })
  expect(response.status).toBe(200)
}

async function providerCard(stack: Stack, app: Page, count: number, multiple = false) {
  await stack.daemon.makeWorkspace("provider-models", "Provider models")
  await saveProvider(stack, "provider-card", "Provider Card", count)
  if (multiple) {
    await saveProvider(stack, "team-gateway", "Team Gateway", 27)
    await saveProvider(stack, "local-gateway", "Local Gateway", 6)
  }
  await app.goto(`${stack.url}/settings/models`)
  const harness = app
    .locator("section")
    .filter({ has: app.getByRole("heading", { level: 2, name: "OpenCode", exact: true }) })
    .last()
  await harness.getByRole("tab", { name: "Models", exact: true }).click()
  const card = harness.getByRole("region", { name: "Provider Card", exact: true })
  await expect(card).toBeVisible()
  const header = card.locator("header")
  const expand = header.getByRole("button", { name: "Provider Card", exact: true })
  if ((await expand.getAttribute("aria-expanded")) === "false") await expand.click()
  await expect(card.getByRole("switch")).toHaveCount(10)
  return { card, header, expand, harness }
}

test("15 settings: provider models stay in one card, bulk actions preserve expansion, search and loading more share its footer", async ({ stack, app, isMobile }) => {
  const { card, header, expand } = await providerCard(stack, app, 50)
  const search = card.getByRole("textbox", { name: "Search Provider Card models…" })
  const footer = card.locator("footer")
  await expect(footer.getByRole("status")).toHaveText("Showing 10 of 50 models.")
  await expect(header.getByRole("textbox")).toHaveCount(0)
  await header.getByRole("button", { name: "Disable all", exact: true }).click()
  await expect(expand).toHaveAttribute("aria-expanded", "true")
  await expect(search).toBeVisible()
  await expect(card.getByRole("switch", { checked: true })).toHaveCount(0)
  await expect(card.getByRole("switch")).toHaveCount(10)
  await footer.getByRole("button", { name: "Load 10 more", exact: true }).click()
  await expect(card.getByRole("switch")).toHaveCount(20)
  await expect(footer.getByRole("status")).toHaveText("Showing 20 of 50 models.")
  await search.fill("050")
  await expect(card.getByRole("switch", { name: "Card Model 050", exact: true })).toBeVisible()
  await expect(footer.getByRole("status")).toHaveText("Showing 1 of 1 models.")
  await expect(footer.getByRole("button")).toHaveCount(0)
  await header.getByRole("button", { name: "Enable all", exact: true }).click()
  await expect(expand).toHaveAttribute("aria-expanded", "true")
  await expect(card.getByRole("switch", { name: "Card Model 050", exact: true })).toBeChecked()
  await search.fill("no matching model")
  await expect(card.getByText("No models match “no matching model”.")).toBeVisible()
  await expect(footer.getByRole("status")).toHaveText("Showing 0 of 0 models.")
  await search.fill("")
  await expect(card.getByRole("switch")).toHaveCount(10)
  await expect(card.getByRole("switch", { checked: true })).toHaveCount(10)
  await expand.click()
  await expect(search).toHaveCount(0)
  await header.getByRole("button", { name: "Disable all", exact: true }).click()
  await expect(expand).toHaveAttribute("aria-expanded", "false")
  await expand.click()
  await expect(card.getByRole("switch")).toHaveCount(10)
  const boxes = await Promise.all([
    header.boundingBox(),
    search.boundingBox(),
    card.getByRole("switch").first().boundingBox(),
    footer.boundingBox(),
  ])
  const [head, field, row, foot] = boxes
  if (!head || !field || !row || !foot) throw new Error("Provider card is not laid out")
  expect(head.y + head.height).toBeLessThanOrEqual(field.y)
  expect(field.y + field.height).toBeLessThanOrEqual(row.y)
  expect(row.y + row.height).toBeLessThanOrEqual(foot.y)
  if (isMobile) {
    for (const button of [
      expand,
      header.getByRole("button", { name: "Enable all" }),
      footer.getByRole("button", { name: "Load 10 more" }),
    ]) {
      const box = await button.boundingBox()
      expect(box?.height).toBeGreaterThanOrEqual(44)
      expect(box?.width).toBeGreaterThanOrEqual(44)
    }
    expect(await app.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(
      0,
    )
  }
})

test("15 settings: loading a large provider virtualizes its model rows and preserves access to the final model", async ({
  stack,
  app,
}) => {
  const { card } = await providerCard(stack, app, 115)
  const footer = card.locator("footer")
  for (let shown = 10; shown < 115; shown += 10) {
    await footer.getByRole("button", { name: `Load ${Math.min(10, 115 - shown)} more`, exact: true }).click()
    await expect(footer.getByRole("status")).toHaveText(`Showing ${Math.min(shown + 10, 115)} of 115 models.`)
  }
  await expect(footer.getByRole("button")).toHaveCount(0)
  expect(await card.getByRole("switch").count()).toBeLessThan(100)
  await card.getByRole("list", { name: "Provider Card", exact: true }).press("End")
  await expect(card.getByRole("switch", { name: "Card Model 115", exact: true })).toBeVisible()
  await card.getByRole("textbox", { name: "Search Provider Card models…" }).fill("115")
  await expect(card.getByRole("switch", { name: "Card Model 115", exact: true })).toBeVisible()
})

test("15 settings: multiple provider cards keep their headers, model bodies, footers and bulk actions separate", async ({ stack, app }) => {
  const { card, header, harness } = await providerCard(stack, app, 50, true)
  const second = harness.getByRole("region", { name: "Team Gateway", exact: true })
  const third = harness.getByRole("region", { name: "Local Gateway", exact: true })
  await expect(second.getByRole("switch")).toHaveCount(10)
  await second.getByRole("button", { name: "Disable all", exact: true }).click()
  await second.getByRole("button", { name: "Enable all", exact: true }).click()
  await expect(second.getByRole("switch", { checked: true })).toHaveCount(10)
  await third.getByRole("button", { name: "Local Gateway", exact: true }).click()
  await header.getByRole("button", { name: "Disable all", exact: true }).click()
  await expect(card.getByRole("switch", { checked: true })).toHaveCount(0)
  await expect(second.getByRole("switch", { checked: true })).toHaveCount(10)
  await expect(second.locator("footer").getByRole("status")).toHaveText("Showing 10 of 27 models.")
  await expect(third.getByRole("button", { name: "Local Gateway", exact: true })).toHaveAttribute("aria-expanded", "false")
  const firstBox = await card.boundingBox()
  const secondBox = await second.boundingBox()
  if (!firstBox || !secondBox) throw new Error("Provider cards are not laid out")
  expect(secondBox.y - firstBox.y - firstBox.height).toBeGreaterThanOrEqual(16)
  await header.getByRole("button", { name: "Provider Card", exact: true }).click()
  await expect(card.getByRole("textbox")).toHaveCount(0)
  await expect(card.getByRole("switch")).toHaveCount(0)
  await expect(card.locator("footer")).toHaveCount(0)
  await expect(second.getByRole("switch", { checked: true })).toHaveCount(10)
})
