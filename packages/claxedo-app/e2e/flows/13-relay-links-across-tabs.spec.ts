import type { Page } from "@playwright/test"
import { acpScriptToken, assistantText, expect, SCRIPTED_ACP_HARNESS, sessionCookie, test } from "../harness"
import { sessionRoute } from "../harness/ui-names"

function connectionReads(page: Page, workspaceId: string) {
  let count = 0
  page.on("request", (request) => {
    if (request.url().includes(`/api/workspace/${workspaceId}/connection`)) count += 1
  })
  return () => count
}

test("13 relay links across tabs: a second tab and a reload of a signed-in person reuse the link the first tab minted, so neither spends the workspace's connection budget", async ({ signed, page }) => {
  const workspace = await signed.makeWorkspace("tabs", "Tabs")
  await signed.local.acp.write("tabs", { steps: [{ kind: "text", text: "Tabs hello" }] })
  const session = await signed.owner.api.createSession(workspace.directory, { title: "Tabs turn", harness: SCRIPTED_ACP_HARNESS })
  await signed.owner.api.prompt(workspace.directory, session.id, `Say hello. ${acpScriptToken("tabs")}`)
  expect(assistantText(await signed.owner.api.messages(workspace.directory, session.id))).toContain("Tabs hello")
  await page.context().addCookies([sessionCookie(signed.url, signed.owner)])
  const route = `${signed.url}${sessionRoute(workspace.id, session.id)}`

  const first = connectionReads(page, workspace.id)
  await page.goto(route)
  await expect(page.getByText("Tabs hello")).toBeVisible()
  expect(first()).toBe(1)

  const second = await page.context().newPage()
  const secondReads = connectionReads(second, workspace.id)
  await second.goto(route)
  await expect(second.getByText("Tabs hello")).toBeVisible()
  expect(secondReads()).toBe(0)

  await second.reload()
  await expect(second.getByText("Tabs hello")).toBeVisible()
  expect(secondReads()).toBe(0)
  await second.close()
})
