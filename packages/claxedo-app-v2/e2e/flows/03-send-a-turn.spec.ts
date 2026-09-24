import { acpScriptToken, assistantText, expect, SCRIPTED_ACP_HARNESS, test } from "../harness"

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

  await app.goto(`${stack.url}/w/${workspace.id}/s/${session.id}`)
  const prompt = app.getByRole("textbox", { name: "Prompt" })
  await prompt.fill(`Write the notes. ${acpScriptToken("turn")}`)
  await prompt.press("Enter")

  await expect(app.getByText("Write the notes.", { exact: false }).first()).toBeVisible()
  await expect(app.getByText("Done. The sum is shown below.")).toBeVisible()
  await expect(app.getByRole("math").first()).toBeVisible()
  await expect(app.getByRole("button", { name: "Open diagram full screen" })).toBeVisible()
  await expect(app.getByRole("img", { name: "image.png" })).toBeVisible()
  await expect(app.getByRole("region", { name: "1 of 1 todos completed", exact: true })).toBeVisible()
  const work = app.getByRole("button", { name: "Edited 1 file · ran 1 command · fetched 1 page · search" })
  await work.click()
  await expect(app.getByText("git status").first()).toBeVisible()
  await expect(app.getByText("notes.md").first()).toBeVisible()
  await app.getByRole("button", { name: /^Explored/ }).click()
  await expect(app.getByText("README.md").first()).toBeVisible()
  await expect(app.getByRole("button", { name: "Send", exact: true })).toBeVisible()

  const messages = await api.messages(workspace.directory, session.id)
  expect(assistantText(messages)).toContain("Done. The sum is")
})

test("03 a new session's first send creates the session and its draft pane becomes that session", async ({ stack, api, app, isMobile }) => {
  const workspace = await stack.daemon.makeWorkspace("draft")
  const existing = await api.createSession(workspace.directory, { title: "Existing", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}/w/${workspace.id}/s/${existing.id}`)
  await expect(app.getByRole("textbox", { name: "Prompt" })).toBeVisible()
  if (isMobile) await app.getByRole("button", { name: "Open menu" }).click()
  await app.getByRole("button", { name: "New session" }).click()
  const draft = app.getByRole("region", { name: "New session", exact: true })
  const prompt = draft.getByRole("textbox", { name: "Prompt" })
  await prompt.fill("Start the draft session")
  await prompt.press("Enter")

  await expect(draft).toHaveCount(0)
  if (isMobile) await expect(app.getByRole("button", { name: "Switch pane" })).not.toContainText("New session")
  else await expect(app.getByRole("tab", { name: "New session" })).toHaveCount(0)
  await expect(app.getByText("Start the draft session", { exact: true }).first()).toBeVisible()
  const created = (await api.sessions(workspace.directory)).find((row) => row.id !== existing.id)
  expect(created).toBeDefined()
  await expect(app).toHaveURL(new RegExp(`/s/${created!.id}$`))
  const sent = (await api.messages(workspace.directory, created!.id)).filter((message) => message.info.role === "user")
  expect(JSON.stringify(sent)).toContain("Start the draft session")
})
