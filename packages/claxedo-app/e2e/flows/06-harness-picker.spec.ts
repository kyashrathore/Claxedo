import { expect, sessionRoute, showHarnesses, test } from "../harness"

test("06 the harness list ends right above the Model row, with no empty band between them", async ({ stack, app }) => {
  const workspace = await stack.daemon.makeWorkspace("picker-gap")
  await app.goto(`${stack.url}${sessionRoute(workspace.id)}`)
  await app.locator('[data-action="prompt-harness-model"]').filter({ visible: true }).click()
  const picker = app.getByRole("dialog", { name: "Select harness, model and effort" })
  await showHarnesses(picker)
  const header = picker.getByRole("button", { name: /^Model/ })
  await expect(header).toBeVisible()
  const buttons = picker.getByRole("button")
  const lastHarness = buttons.nth((await buttons.allInnerTexts()).findIndex((name) => name.startsWith("Model")) - 1)
  const last = await lastHarness.boundingBox()
  const model = await header.boundingBox()
  expect(model!.y - (last!.y + last!.height)).toBeLessThanOrEqual(8)
})
