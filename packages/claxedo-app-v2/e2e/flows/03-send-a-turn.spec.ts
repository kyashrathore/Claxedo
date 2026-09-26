import { acpScriptToken, assistantText, expect, SCRIPTED_ACP_HARNESS, sendPrompt, sessionRoute, test, UI } from "../harness"

const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

test("03 send a turn: the reply streams in with its tool groups, diff, todo list, image, math and Mermaid", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("turn")
  await stack.acp.write("turn", {
    steps: [
      { kind: "reasoning", text: "Reading the project first" },
      { kind: "tool", tool: "read", title: "Read README.md", locations: [{ path: `${workspace.directory}/README.md` }], text: "turn\n" },
      { kind: "tool", tool: "search", title: "Search for TODO", input: { pattern: "TODO" }, text: "README.md:1: TODO" },
      { kind: "tool", tool: "execute", title: "git status", input: { command: "git status" }, text: "nothing to commit" },
      { kind: "tool", tool: "fetch", title: "Fetch https://example.com", input: { url: "https://example.com" }, text: "Example Domain" },
      { kind: "diff", path: `${workspace.directory}/notes.md`, oldText: null, newText: "# Notes\n" },
      { kind: "plan", entries: [{ content: "Write the notes", priority: "medium", status: "completed" }] },
      { kind: "image", data: PIXEL, mimeType: "image/png" },
      { kind: "text", text: "Done. The sum is shown below.\n\n$$a+b$$\n\n```mermaid\ngraph TD\n  A-->B\n```\n", chunks: 4 },
    ],
  })
  const session = await api.createSession(workspace.directory, { title: "Send a turn", harness: SCRIPTED_ACP_HARNESS })

  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await sendPrompt(app, `Write the notes. ${acpScriptToken("turn")}`)

  await expect(app.getByText("Write the notes.", { exact: false }).first()).toBeVisible()
  await expect(app.getByText("Done. The sum is shown below.")).toBeVisible()
  await expect(app.getByRole("math").first()).toBeVisible()
  await expect(app.getByRole("button", { name: "Open diagram full screen" })).toBeVisible()
  await expect(app.getByRole("img", { name: "image.png" })).toBeVisible()
  await test.step("a finished todo list goes away (DECISIONS Owner, 20:28)", async () => {
    await expect(app.locator('[data-component="session-todo-dock"]')).toHaveCount(0)
  })
  await app.getByRole("button", { name: UI.workedFor }).click()
  await app.getByRole("button", { name: "Edited 1 file · ran 1 command · fetched 1 page · search" }).click()
  await expect(app.getByText("git status").first()).toBeVisible()
  await expect(app.getByText("notes.md").first()).toBeVisible()
  await app.getByRole("button", { name: UI.explored }).click()
  await expect(app.getByText("README.md").first()).toBeVisible()
  await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()

  const messages = await api.messages(workspace.directory, session.id)
  expect(assistantText(messages)).toContain("Done. The sum is")
})

test("03 a new session's first send creates the session and its draft pane becomes that session", async ({ stack, api, app, isMobile }) => {
  const workspace = await stack.daemon.makeWorkspace("draft")
  const existing = await api.createSession(workspace.directory, { title: "Existing", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, existing.id)}`)
  const prompt = app.getByRole("textbox", { name: UI.composer })
  await expect(prompt).toBeVisible()
  await app.getByRole("button", { name: UI.newSession }).click()
  await expect(app).toHaveURL(new RegExp(`${sessionRoute(workspace.id)}$`))
  await sendPrompt(app, "Start the draft session")

  await expect(app.getByText("Start the draft session", { exact: true }).first()).toBeVisible()
  await expect.poll(async () => (await api.sessions(workspace.directory)).length).toBe(2)
  const created = (await api.sessions(workspace.directory)).find((row) => row.id !== existing.id)
  if (!created) throw new Error("the first send created no session")
  await expect(app).toHaveURL(new RegExp(`${sessionRoute(workspace.id, created.id)}$`))
  if (isMobile) await app.getByRole("button", { name: UI.openRail }).click()
  await expect.poll(async () => (await api.session(workspace.directory, created.id)).title).toBe("Scripted Session")
  await expect(app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: "Scripted Session", exact: true })).toBeVisible()
  const sent = (await api.messages(workspace.directory, created.id)).filter((message) => message.info.role === "user")
  expect(JSON.stringify(sent)).toContain("Start the draft session")
})

test("03 two sessions stream at once: the second's reply shows while the first still runs, in the foreground and after a switch", async ({ stack, api, app, isMobile }) => {
  test.skip(isMobile, "the switch goes through the desktop rail; flow 33 owns the phone rail")
  const workspace = await stack.daemon.makeWorkspace("concurrent", "Concurrent")
  const alpha = await api.createSession(workspace.directory, { title: "Alpha", harness: SCRIPTED_ACP_HARNESS })
  const bravo = await api.createSession(workspace.directory, { title: "Bravo", harness: SCRIPTED_ACP_HARNESS })
  await stack.acp.write("alpha", { steps: [{ kind: "text", text: "Alpha has started." }, { kind: "hold", name: "alpha" }, { kind: "text", text: "Alpha has finished." }] })
  await stack.acp.write("bravo", { steps: [{ kind: "text", text: "Bravo streams in the foreground.", chunks: 4, delayMs: 50 }] })
  await stack.acp.write("bravo-background", {
    steps: [{ kind: "hold", name: "bravo-background" }, { kind: "text", text: "Bravo streamed in the background.", chunks: 4, delayMs: 50 }, { kind: "hold", name: "bravo-end" }],
  })
  const rail = app.getByRole("navigation", { name: UI.rail })
  const alphaText = async () => assistantText(await api.messages(workspace.directory, alpha.id))

  await app.goto(`${stack.url}${sessionRoute(workspace.id, alpha.id)}`)
  await sendPrompt(app, `Start Alpha. ${acpScriptToken("alpha")}`)
  await expect(app.getByText("Alpha has started.")).toBeVisible()

  await rail.getByRole("button", { name: "Bravo", exact: true }).click()
  await expect(app).toHaveURL(new RegExp(bravo.id))
  await sendPrompt(app, `Start Bravo. ${acpScriptToken("bravo")}`)
  await expect(app.getByText("Bravo streams in the foreground.")).toBeVisible()
  expect(await alphaText()).not.toContain("Alpha has finished.")

  await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()
  await sendPrompt(app, `Again. ${acpScriptToken("bravo-background")}`)
  await rail.getByRole("button", { name: "Alpha", exact: true }).click()
  await expect(app).toHaveURL(new RegExp(alpha.id))
  await expect(app.getByText("Alpha has started.")).toBeVisible()
  await stack.acp.release("bravo-background")
  await expect.poll(async () => assistantText(await api.messages(workspace.directory, bravo.id))).toContain("Bravo streamed in the background.")
  await rail.getByRole("button", { name: "Bravo", exact: true }).click()
  await expect(app).toHaveURL(new RegExp(bravo.id))
  await expect(app.getByText("Bravo streamed in the background.")).toBeVisible()
  expect(await alphaText()).not.toContain("Alpha has finished.")

  await stack.acp.release("alpha")
  await stack.acp.release("bravo-end")
  await expect.poll(alphaText).toContain("Alpha has finished.")
})
