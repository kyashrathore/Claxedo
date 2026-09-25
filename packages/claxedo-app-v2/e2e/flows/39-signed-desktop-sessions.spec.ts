import type { Page } from "@playwright/test"
import { expect, SCRIPTED_ACP_HARNESS, signInDesktop, test, UI, type SignedStack } from "../harness"

async function accountOrder(signed: SignedStack, projectId: string): Promise<string[]> {
  const url = new URL("/api/control/session-list", signed.stack.url)
  for (const [key, value] of Object.entries({ scope: "project", projectId, sort: "human_turn_desc", limit: "100" })) url.searchParams.set(key, value)
  const reply = await signed.owner.transport({ method: "GET", url: url.toString() })
  expect(reply.status).toBe(200)
  return (JSON.parse(reply.body) as { items: Array<{ title: string }> }).items.map((item) => item.title)
}

function projectTitles(window: Page, projectId: string): Promise<string[]> {
  return window
    .locator(`[data-testid="project-group"][data-project-id="${projectId}"]`)
    .getByTestId("rail-sidebar-session-row")
    .locator('[data-slot="navigation-row-activate"]')
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label") ?? ""))
}

test("39 signed desktop: the account's project and this machine's list in one rail, and Show more continues the account's page", { tag: "@desktop" }, async ({ signed, signedDesktop, page }) => {
  const remote = await signed.makeWorkspace("remote-list", "Remote List")
  for (let index = 1; index <= 7; index++) {
    await signed.owner.api.createSession(remote.directory, { title: `Remote ${index}`, harness: SCRIPTED_ACP_HARNESS })
  }
  const local = await signedDesktop.makeWorkspace("local-list", "Local List")
  await signedDesktop.api.createSession(local.directory, { title: "Local one", harness: SCRIPTED_ACP_HARNESS })
  const order = await accountOrder(signed, remote.projectId)
  expect(order).toHaveLength(7)

  await signedDesktop.window.reload()
  await signInDesktop(signed, signedDesktop, page)
  const window = signedDesktop.window
  const rail = window.getByRole("navigation", { name: UI.rail })
  await expect(rail.getByRole("button", { name: "Local one", exact: true })).toBeVisible()
  await expect.poll(() => projectTitles(window, remote.projectId)).toEqual(order.slice(0, 5))

  await window.locator(`[data-testid="project-group"][data-project-id="${remote.projectId}"]`).getByTestId("rail-sidebar-session-load-more").click()
  await expect.poll(() => projectTitles(window, remote.projectId)).toEqual(order)
  await expect(rail.getByRole("button", { name: "Local one", exact: true })).toBeVisible()
})
