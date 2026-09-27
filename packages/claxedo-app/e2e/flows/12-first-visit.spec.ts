import { apiRequests, expect, expectNothingAnimating, holdResponse, sessionRoute, test, UI } from "../harness"
import { seedTurns } from "./12-switch-paint.seed"

test.skip(({ isMobile }) => isMobile, "flow 12 runs at desktop width; flow 33 covers the phone")

const LATEST_TURN_READ = /[?&]view=latest-turn\b/

test("12 a first visit keeps the fold its preview showed when the full latest turn lands in the same update as the fragment reset", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("fold", "Fold")
  const session = await seedTurns(stack, api, workspace.directory, "Fold", 1)
  const fullRead = await holdResponse(app, LATEST_TURN_READ)
  const settled = apiRequests(app, stack.url)
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  const fold = app.getByRole("button", { name: UI.workedFor })
  const tool = app.getByText("Explored", { exact: true })
  await expect(fold).toBeVisible()
  await fullRead.release()
  await settled()
  await expect(fold).toBeVisible()
  await expect(tool).toHaveCount(0)
  await expectNothingAnimating(app)
  await fold.click()
  await expect(tool).toBeVisible()
})

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
