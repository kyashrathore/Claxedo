import { apiRequests, expect, expectNothingAnimating, holdEveryRequest, sessionRoute, test, UI } from "../harness"
import { seedTurns } from "./12-switch-paint.seed"

test.skip(({ isMobile }) => isMobile, "flow 12 runs at desktop width; flow 33 covers the phone")

test("12 opening a finished turn's fold on a first visit keeps its terminal text row mounted", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("keep", "Keep")
  const session = await seedTurns(stack, api, workspace.directory, "Keep", 2)
  const settled = apiRequests(app, stack.url)
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  const fold = app.getByRole("button", { name: UI.workedFor }).last()
  const reply = app.getByText("Keep reply line 6.").last()
  await expect(fold).toBeVisible()
  await expect(reply).toBeVisible()
  await settled()
  await expectNothingAnimating(app)
  await reply.evaluate((element) => Reflect.set(window, "__claxedoTerminalText", element))
  await fold.click()
  await expect(app.getByText("Explored", { exact: true }).last()).toBeVisible()
  await expectNothingAnimating(app)
  expect(await reply.evaluate((element) => element === Reflect.get(window, "__claxedoTerminalText")), "the terminal text is the node that painted before the fold opened").toBe(true)
})

test("12 a cold open paints its first page from its first read while every other read of the session is still held", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("first", "First")
  const session = await seedTurns(stack, api, workspace.directory, "First", 3)
  const others = await holdEveryRequest(app, new RegExp(`/session/${session.id}(?!/outline)([/?]|$)`))
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await expect(app.getByText("First reply line 6.").last()).toBeVisible()
  await expect(app.getByRole("button", { name: UI.workedFor }).last()).toBeVisible()
  expect(others.held(), "the session reads the first paint did not wait for").toContainEqual(expect.stringContaining("view=open"))
  others.release()
})
