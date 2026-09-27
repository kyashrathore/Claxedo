import { expect, SCRIPTED_ACP_HARNESS, sessionRoute, test, UI } from "../harness"
import { openSection, openSettings } from "./15-settings.navigation"

test.skip(({ isMobile }) => isMobile, "flow 12 runs at desktop width; flow 33 covers the phone")

test("12 history: back and forward across two switches, reload and a deep link on the new URL, one entry per switch, anchors stay in-app", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("history", "History")
  const first = await api.createSession(workspace.directory, { title: "First", harness: SCRIPTED_ACP_HARNESS })
  const second = await api.createSession(workspace.directory, { title: "Second", harness: SCRIPTED_ACP_HARNESS })
  const third = await api.createSession(workspace.directory, { title: "Third", harness: SCRIPTED_ACP_HARNESS })
  const rail = app.getByRole("navigation", { name: UI.rail })
  const pane = (id: string) => app.locator(`[data-testid="session-page-root"][data-session-id="${id}"]`)
  const mark = () => app.evaluate(() => (window as unknown as { __shellMark?: number }).__shellMark)
  const entries = () => app.evaluate(() => window.history.length)

  await app.goto(`${stack.url}${sessionRoute(workspace.id, first.id)}`)
  await expect(pane(first.id)).toBeVisible()
  await app.evaluate(() => { (window as unknown as { __shellMark?: number }).__shellMark = 1 })
  const before = await entries()

  await rail.getByRole("button", { name: "Second", exact: true }).click()
  await expect(pane(second.id)).toBeVisible()
  await expect(app).toHaveURL(new RegExp(`/${second.id}$`))
  await rail.getByRole("button", { name: "Third", exact: true }).click()
  await expect(pane(third.id)).toBeVisible()
  await expect(app).toHaveURL(new RegExp(`/${third.id}$`))
  await expect.poll(entries).toBe(before + 2)
  expect(await mark()).toBe(1)

  await app.goBack()
  await expect(pane(second.id)).toBeVisible()
  await expect(pane(third.id)).toHaveCount(0)
  await expect(app).toHaveURL(new RegExp(`/${second.id}$`))
  await app.goBack()
  await expect(pane(first.id)).toBeVisible()
  await app.goForward()
  await expect(pane(second.id)).toBeVisible()
  await expect.poll(entries).toBe(before + 2)
  expect(await mark()).toBe(1)

  await app.reload()
  await expect(pane(second.id)).toBeVisible()
  await expect(app).toHaveURL(new RegExp(`/${second.id}$`))

  await app.evaluate(() => { (window as unknown as { __shellMark?: number }).__shellMark = 2 })
  await openSettings(app, false)
  await openSection(app, false, "Keyboard shortcuts")
  expect(await mark()).toBe(2)
  await app.goBack()
  await expect(app.getByRole("heading", { level: 1, name: "Appearance" })).toBeVisible()

  await app.goto(`${stack.url}${sessionRoute(workspace.id, third.id)}`)
  await expect(pane(third.id)).toBeVisible()
})

test("12 history: a view an in-app link opens reads its query from the new URL", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("history-query", "History query")
  const session = await api.createSession(workspace.directory, { title: "First", harness: SCRIPTED_ACP_HARNESS })
  const consent = "/oauth/consent?client_id=probe&scope=openid+claxedo%3Aread"
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await expect(app.locator(`[data-testid="session-page-root"][data-session-id="${session.id}"]`)).toBeVisible()

  await app.evaluate((href) => {
    const link = document.createElement("a")
    link.href = href
    link.textContent = "Consent probe"
    document.body.append(link)
  }, consent)
  await app.getByRole("link", { name: "Consent probe" }).click()
  await expect(app).toHaveURL(`${stack.url}${consent}`)
  await expect(app.getByRole("checkbox", { name: "Read sessions, workspaces and what needs you" })).toBeChecked()
  await expect(app.getByRole("listitem")).toHaveText(["openid"])
})
