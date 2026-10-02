import { acpScriptToken, assistantText, expect, SCRIPTED_ACP_HARNESS, sessionRoute, test } from "../harness"

test("03 expanding todos overlays the transcript without moving its viewport or scroll position", async ({ stack, api, app }) => {
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
  await expect(dock.getByRole("button", { name: "Collapse", exact: true })).toBeVisible()
  await expect(app.getByText("Transcript paragraph 70.", { exact: true })).toBeVisible()
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
  for (const position of ["bottom", "top"] as const) {
    await scroller.evaluate((element, position) => element.scrollTo({ top: position === "bottom" ? element.scrollHeight : 0 }), position)
    const before = await geometry()
    await dock.getByRole("button", { name: "Expand", exact: true }).click()
    await expect.poll(dockHeight).toBe(expandedHeight)
    await expect(dock.getByText("Pending task 5", { exact: true }).first()).toBeVisible()
    expect(await geometry()).toEqual(before)
    await dock.getByRole("button", { name: "Collapse", exact: true }).click()
    await expect.poll(dockHeight).toBe(78)
    expect(await geometry()).toEqual(before)
  }
  expect(await app.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await stack.acp.release("todo-overlay")
  await expect.poll(async () => (await api.status(workspace.directory))[session.id]?.type ?? "idle").toBe("idle")
  await expect(dock.getByRole("button", { name: "Expand", exact: true })).toBeVisible()
  await app.reload()
  await expect(dock.getByRole("button", { name: "Expand", exact: true })).toBeVisible()
  await dock.getByRole("button", { name: "Expand", exact: true }).click()
  await expect(dock.getByText("Pending task 5", { exact: true }).first()).toBeVisible()
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
