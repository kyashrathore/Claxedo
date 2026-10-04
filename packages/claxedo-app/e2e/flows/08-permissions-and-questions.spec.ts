import { acpScriptToken, assistantText, expect, installedCli, SCRIPTED_ACP_HARNESS, sendPrompt, sessionRoute, test, UI, watchPageWork } from "../harness"

test("08 a permission prompt blocks the composer until it is allowed from its dock", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("permission")
  await stack.acp.write("permission", {
    steps: [
      { kind: "permission", tool: "edit", title: "Edit notes.md", path: `${workspace.directory}/notes.md` },
      { kind: "text", text: "Edited notes.md after the permission" },
    ],
  })
  const session = await api.createSession(workspace.directory, { title: "Permission", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  const prompt = app.getByRole("textbox", { name: UI.composer })
  await sendPrompt(app, `Edit the notes. ${acpScriptToken("permission")}`)

  await expect(app.getByText("Permission required")).toBeVisible()
  await expect(prompt).toHaveCount(0)
  expect((await api.permissions(workspace.directory)).filter((row) => row.sessionID === session.id)).toHaveLength(1)
  await app.getByRole("button", { name: "Allow once", exact: true }).click()

  await expect(app.getByText("Edited notes.md after the permission")).toBeVisible()
  await expect(app.getByText("Permission required")).toHaveCount(0)
  await expect(prompt).toBeVisible()
  expect((await api.permissions(workspace.directory)).filter((row) => row.sessionID === session.id)).toHaveLength(0)
  expect(assistantText(await api.messages(workspace.directory, session.id))).toContain("Edited notes.md after the permission")
})

test("08 a question is answered from its dock and the agent receives the answer", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("question")
  await stack.acp.write("question", { steps: [{ kind: "question", message: "Which color should the button be?", options: ["Red", "Blue"] }] })
  const session = await api.createSession(workspace.directory, { title: "Question", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  const prompt = app.getByRole("textbox", { name: UI.composer })
  await sendPrompt(app, `Pick a color. ${acpScriptToken("question")}`)

  await expect(app.getByText("Which color should the button be?")).toBeVisible()
  await expect(prompt).toHaveCount(0)
  expect((await api.questions(workspace.directory)).filter((row) => row.sessionID === session.id)).toHaveLength(1)
  await app.getByRole("radio", { name: /Type your own answer/ }).click()
  await app.getByRole("textbox", { name: "Type your answer..." }).fill('{"answer":"Blue"}')
  await app.getByRole("button", { name: "Submit", exact: true }).click()

  await expect(app.getByText("Answer: Blue")).toBeVisible()
  await expect(prompt).toBeVisible()
  expect(assistantText(await api.messages(workspace.directory, session.id))).toContain("Answer: Blue")
  expect((await api.questions(workspace.directory)).filter((row) => row.sessionID === session.id)).toHaveLength(0)
})

test("08 the permission chip shows the mode the harness reports and delivers a pick to the session", async ({ stack, api, app, isMobile }) => {
  test.skip(isMobile, "the chip collapses to its shield on phone")
  const availability = await installedCli("claude")
  test.skip(!availability.available, availability.available ? "" : availability.reason)
  const workspace = await stack.daemon.makeWorkspace("permission-mode")
  const session = await api.createSession(workspace.directory, { title: "Permission mode", harness: { id: "claude", access: "native" } })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)

  const chip = app.locator('[data-action="prompt-permission-mode"]').filter({ visible: true })
  await expect(chip).toHaveText("Auto")
  await chip.click()
  const menu = app.getByRole("menu")
  await expect(menu.getByText("Claude", { exact: true })).toBeVisible()
  await expect(menu.getByText("Use a model classifier to approve/deny permission prompts")).toBeVisible()
  const saved = app.waitForResponse((response) => response.request().method() === "PUT" && response.url().includes("/permission-mode"))
  await menu.getByRole("menuitem", { name: /^Plan/ }).click()
  expect((await saved).ok()).toBe(true)
  await expect(chip).toHaveText("Plan")
})

test("08 a cold switch to a session names its permission mode from the session row, with no mode or config read", async ({ stack, api, app, isMobile }) => {
  test.skip(isMobile, "the switch goes through the desktop rail")
  const availability = await installedCli("claude")
  test.skip(!availability.available, availability.available ? "" : availability.reason)
  const workspace = await stack.daemon.makeWorkspace("permission-row")
  const planned = await api.createSession(workspace.directory, { title: "Planned", harness: { id: "claude", access: "native" }, permissionMode: "plan" })
  const other = await api.createSession(workspace.directory, { title: "Elsewhere", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, other.id)}`)
  await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
  const reads: string[] = []
  app.on("request", (request) => {
    const path = new URL(request.url()).pathname
    if (request.method() === "GET" && (/\/permission-mode$|\/permission\/modes$/.test(path) || path.endsWith(`/session/${planned.id}/config`))) reads.push(path)
  })

  await app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: "Planned", exact: true }).click()
  await expect(app.locator(`[data-testid="session-page-root"][data-session-id="${planned.id}"]`)).toBeVisible()
  const chip = app.locator('[data-action="prompt-permission-mode"]').filter({ visible: true })
  await expect(chip).toHaveText("Plan")
  await expect(chip).toHaveAttribute("data-mode", "plan")
  expect(reads).toEqual([])
})

test("08 a permission mode picked in one browser reaches the chip of another browser on the same session", async ({ stack, api, app, browser, isMobile }) => {
  test.skip(isMobile, "the chip collapses to its shield on phone")
  const availability = await installedCli("claude")
  test.skip(!availability.available, availability.available ? "" : availability.reason)
  const workspace = await stack.daemon.makeWorkspace("permission-two-clients")
  const session = await api.createSession(workspace.directory, { title: "Shared mode", harness: { id: "claude", access: "native" } })
  const other = await (await browser.newContext()).newPage()
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await other.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  const chip = (page: typeof app) => page.locator('[data-action="prompt-permission-mode"]').filter({ visible: true })
  await expect(chip(app)).toHaveText("Auto")
  await expect(chip(other)).toHaveText("Auto")

  await chip(app).click()
  const saved = app.waitForResponse((response) => response.request().method() === "PUT" && response.url().includes("/permission-mode"))
  await app.getByRole("menu").getByRole("menuitem", { name: /^Plan/ }).click()
  expect((await saved).ok()).toBe(true)
  await expect(chip(app)).toHaveText("Plan")
  await expect(chip(other)).toHaveText("Plan")
  await other.context().close()
})

test("08 a harness switch mid-session moves the chip to the new harness, whose modes are read when it opens", async ({ stack, api, app, isMobile }) => {
  test.skip(isMobile, "the chip collapses to its shield on phone")
  const availability = await installedCli("claude")
  test.skip(!availability.available, availability.available ? "" : availability.reason)
  const workspace = await stack.daemon.makeWorkspace("permission-harness-switch")
  const session = await api.createSession(workspace.directory, { title: "Switching", harness: { id: "claude", access: "native" }, permissionMode: "plan" })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  const chip = app.locator('[data-action="prompt-permission-mode"]').filter({ visible: true })
  const picker = app.locator('[data-action="prompt-harness-model"]').filter({ visible: true })
  await expect(chip).toHaveText("Plan")

  await picker.click()
  await app.getByRole("button", { name: /^Harness/ }).click()
  await app.getByRole("button", { name: "Scripted ACP" }).click()
  await expect(picker).toHaveAttribute("data-harness", "scripted-acp")
  await app.keyboard.press("Escape")
  await sendPrompt(app, "Continue on the scripted agent")
  await expect.poll(async () => JSON.stringify(await api.session(workspace.directory, session.id))).toContain('"harness":{"id":"scripted-acp","access":"connection"}')
  await expect(chip).not.toHaveText("Plan")

  const listed = app.waitForResponse((response) => response.request().method() === "GET" && response.url().includes(`/session/${session.id}/permission-mode`))
  await chip.click()
  expect((await listed).ok()).toBe(true)
  await expect(app.getByRole("menu").getByRole("menuitem", { name: /^Default/ })).toBeVisible()
})

test("08 Stop settles a pending question: the dock goes away and nothing is left to dismiss", async ({ stack, api, app, isMobile }) => {
  test.skip(isMobile, "flow 8's question cases run at desktop width")
  const availability = await installedCli("claude")
  test.skip(!availability.available, availability.available ? "" : availability.reason)
  const workspace = await stack.daemon.makeWorkspace("question-stop")
  const model = await api.defaultModel(workspace.directory, "claude")
  const session = await api.createSession(workspace.directory, { title: "Question stop", harness: { id: "claude", access: "native" }, model })
  stack.scripted.scriptTool({
    name: "AskUserQuestion",
    whenPromptIncludes: "ASKME",
    input: {
      questions: [
        { question: "Which color should the button be?", header: "Color", multiSelect: false, options: [{ label: "Red", description: "Warm" }, { label: "Blue", description: "Cool" }] },
      ],
    },
  })
  const pending = async () => (await api.questions(workspace.directory)).filter((row) => row.sessionID === session.id).length

  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await sendPrompt(app, "ASKME pick a color")
  await expect(app.getByText("Which color should the button be?").first()).toBeVisible({ timeout: 30_000 })
  await expect.poll(pending).toBe(1)

  await app.getByRole("button", { name: UI.stop, exact: true }).click()
  await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
  await expect(app.getByRole("button", { name: "Dismiss", exact: true })).toHaveCount(0)
  await expect.poll(pending).toBe(0)
})

test("08 a question dock and a permission dock mount alone: the composer and the todo dock stay mounted behind them", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("docks-alone")
  await stack.acp.write("docks", {
    steps: [
      { kind: "plan", entries: [{ content: "Pick a color", priority: "medium", status: "in_progress" }, { content: "Edit the notes", priority: "medium", status: "pending" }] },
      { kind: "question", message: "Which color should the notes use?", options: ["Red", "Blue"] },
      { kind: "permission", tool: "edit", title: "Edit notes.md", path: `${workspace.directory}/notes.md` },
      { kind: "text", text: "Used the answer and the permission." },
    ],
  })
  const session = await api.createSession(workspace.directory, { title: "Docks alone", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  const prompt = app.getByRole("textbox", { name: UI.composer })
  await expect(prompt).toBeVisible()
  const work = await watchPageWork(app, { nodes: { composer: '[data-component="composer-frame"]', todoDock: '[data-component="session-todo-dock"]' } })
  await sendPrompt(app, `Pick a color, then edit the notes. ${acpScriptToken("docks")}`)

  await expect(app.getByText("Which color should the notes use?")).toBeVisible()
  await expect(prompt).toHaveCount(0)
  await app.getByRole("radio", { name: /Type your own answer/ }).click()
  await app.getByRole("textbox", { name: "Type your answer..." }).fill('{"answer":"Blue"}')
  await app.getByRole("button", { name: "Submit", exact: true }).click()
  await expect(app.getByText("Permission required")).toBeVisible()
  await expect(prompt).toHaveCount(0)
  await app.getByRole("button", { name: "Allow once", exact: true }).click()
  await expect(app.getByText("Used the answer and the permission.")).toBeVisible()
  await expect(prompt).toBeVisible()

  const seen = await work()
  expect(seen.removed.composer ?? 0, "composer frames removed").toBe(0)
  expect(seen.added.composer ?? 0, "composer frames added").toBe(0)
  expect(seen.added.todoDock ?? 0, "todo docks added").toBeLessThanOrEqual(1)
  expect(assistantText(await api.messages(workspace.directory, session.id))).toContain("Used the answer and the permission.")
})

