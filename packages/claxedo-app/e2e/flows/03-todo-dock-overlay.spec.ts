import { acpScriptToken, assistantText, expect, SCRIPTED_ACP_HARNESS, sessionRoute, test, UI, uncovered } from "../harness"

test("03 expanding todos keeps the transcript end in view and leaves a scrolled-up viewport in place", async ({ stack, api, app, isMobile }) => {
  const workspace = await stack.daemon.makeWorkspace("todo-overlay")
  const text = Array.from({ length: 70 }, (_, index) => `Transcript paragraph ${index + 1}.`).join("\n\n")
  await stack.acp.write("todo-overlay", {
    steps: [
      { kind: "plan", entries: Array.from({ length: 5 }, (_, index) => ({ content: `Pending task ${index + 1}`, priority: "medium", status: "pending" })) },
      { kind: "text", text },
      { kind: "hold", name: "todo-overlay" },
    ],
  })
  const session = await api.createSession(workspace.directory, { title: "Todo overlay", harness: SCRIPTED_ACP_HARNESS })
  await api.promptAsync(workspace.directory, session.id, `Write the transcript. ${acpScriptToken("todo-overlay")}`)
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  const dock = app.locator('[data-component="session-todo-dock"]')
  const scroller = app.getByRole("region", { name: "scrollable content" })
  const composer = app.locator('[data-component="composer-frame"]')
  const lastLine = app.getByText("Transcript paragraph 70.", { exact: true })
  await expect(dock.getByRole("button", { name: "Collapse", exact: true })).toBeVisible()
  await expect(lastLine).toBeVisible()
  await expect.poll(() => uncovered(lastLine)).toBe(true)
  const geometry = async () => ({
    viewport: await scroller.boundingBox(),
    scrollTop: await scroller.evaluate((element) => element.scrollTop),
    composer: await composer.boundingBox(),
  })
  const dockHeight = () => dock.evaluate((element) => Math.round(element.getBoundingClientRect().height))
  const expandedHeight = await dockHeight()
  expect(expandedHeight).toBeGreaterThan(78)
  await dock.getByRole("button", { name: "Collapse", exact: true }).click()
  await expect.poll(dockHeight).toBe(78)
  await scroller.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
  const atEnd = await geometry()
  await dock.getByRole("button", { name: "Expand", exact: true }).click()
  await expect.poll(dockHeight).toBe(expandedHeight)
  await expect.poll(() => uncovered(lastLine)).toBe(true)
  expect((await geometry()).viewport).toEqual(atEnd.viewport)
  await dock.getByRole("button", { name: "Collapse", exact: true }).click()
  await expect.poll(dockHeight).toBe(78)
  await expect.poll(() => uncovered(lastLine)).toBe(true)
  await scroller.hover()
  await app.mouse.wheel(0, -100_000)
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0)
  const scrolledUp = await geometry()
  await dock.getByRole("button", { name: "Expand", exact: true }).click()
  await expect.poll(dockHeight).toBe(expandedHeight)
  await expect(dock.getByText("Pending task 5", { exact: true }).first()).toBeVisible()
  expect(await geometry()).toEqual(scrolledUp)
  if (!isMobile) {
    const jump = app.getByRole("button", { name: "Scroll to latest message" })
    await expect.poll(() => uncovered(jump)).toBe(true)
    const jumpBox = await jump.boundingBox()
    expect(jumpBox!.y + jumpBox!.height).toBeLessThanOrEqual((await dock.boundingBox())!.y)
  }
  await dock.getByRole("button", { name: "Collapse", exact: true }).click()
  await expect.poll(dockHeight).toBe(78)
  expect(await geometry()).toEqual(scrolledUp)
  expect(await app.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await stack.acp.release("todo-overlay")
  await expect.poll(async () => (await api.status(workspace.directory))[session.id]?.type ?? "idle").toBe("idle")
  await expect(dock.getByRole("button", { name: "Expand", exact: true })).toBeVisible()
  await app.reload()
  await expect(dock.getByRole("button", { name: "Expand", exact: true })).toBeVisible()
  await dock.getByRole("button", { name: "Expand", exact: true }).click()
  await expect(dock.getByText("Pending task 5", { exact: true }).first()).toBeVisible()
  await expect.poll(() => uncovered(lastLine)).toBe(true)
  await stack.acp.write("todo-complete", {
    steps: [
      { kind: "plan", entries: Array.from({ length: 5 }, (_, index) => ({ content: `Pending task ${index + 1}`, priority: "medium", status: "completed" })) },
      { kind: "text", text: "All tasks completed." },
    ],
  })
  await api.prompt(workspace.directory, session.id, `Finish the tasks. ${acpScriptToken("todo-complete")}`)
  await expect(app.getByText("All tasks completed.", { exact: true })).toBeVisible()
  await expect(dock).toHaveCount(0)
  await app.reload()
  await expect(app.getByText("All tasks completed.", { exact: true })).toBeVisible()
  await expect(dock).toHaveCount(0)
  expect(assistantText(await api.messages(workspace.directory, session.id))).toContain("Transcript paragraph 70.")
})

test("03 todos over a maximized panel stay inside the floating card, below its transcript row", async ({ stack, api, app, isMobile }) => {
  test.skip(isMobile, "the floating composer is the maximized panel's, at desktop width")
  const workspace = await stack.daemon.makeWorkspace("todo-floating")
  await stack.acp.write("todo-floating", {
    steps: [
      { kind: "plan", entries: Array.from({ length: 5 }, (_, index) => ({ content: `Pending task ${index + 1}`, priority: "medium", status: "pending" })) },
      { kind: "text", text: "Planned five tasks." },
    ],
  })
  const session = await api.createSession(workspace.directory, { title: "Todo floating", harness: SCRIPTED_ACP_HARNESS })
  await api.prompt(workspace.directory, session.id, `Plan the tasks. ${acpScriptToken("todo-floating")}`)
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await expect(app.getByText("Planned five tasks.", { exact: true })).toBeVisible()
  await app.getByRole("button", { name: UI.openPanel }).click()
  await app.getByRole("button", { name: "Maximize workspace panel" }).click()
  const dock = app.locator('[data-component="session-todo-dock"]')
  const peek = app.getByTestId("session-transcript-peek")
  await expect(dock.getByRole("button", { name: "Collapse", exact: true })).toBeVisible()
  await expect(dock.getByText("Pending task 5", { exact: true }).first()).toBeVisible()
  await expect.poll(() => uncovered(peek)).toBe(true)
  const peekBox = await peek.boundingBox()
  const dockBox = await dock.boundingBox()
  expect(dockBox!.y).toBeGreaterThanOrEqual(peekBox!.y + peekBox!.height)
  expect(assistantText(await api.messages(workspace.directory, session.id))).toContain("Planned five tasks.")
})
