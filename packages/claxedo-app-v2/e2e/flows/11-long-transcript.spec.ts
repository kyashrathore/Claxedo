import { acpScriptToken, assistantText, expect, SCRIPTED_ACP_HARNESS, test } from "../harness"

test.skip(({ isMobile }) => isMobile, "flow 11 runs at desktop width")

const TURNS = 30

test("11 long transcript: older turns page in above the reader and the nav rail jumps back to the first turn", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("long")
  const session = await api.createSession(workspace.directory, { title: "Long", harness: SCRIPTED_ACP_HARNESS })
  for (let turn = 1; turn <= TURNS; turn += 1) {
    await api.prompt(workspace.directory, session.id, `Turn ${turn}: Reply with exactly this one token: T${String(turn).padStart(2, "0")}X`)
  }
  await app.goto(`${stack.url}/w/${workspace.id}/s/${session.id}`)
  const latest = app.getByText(`Turn ${TURNS}:`, { exact: false }).first()
  await expect(latest).toBeVisible()
  await expect(app.getByText("Turn 1:", { exact: false })).toHaveCount(0)

  await app.getByRole("region", { name: "scrollable content" }).hover()
  await app.mouse.wheel(0, -120)
  await expect(app.getByText(`Turn ${TURNS - 1}:`, { exact: false }).first()).toBeAttached()
  await expect(latest).toBeInViewport()

  await expect
    .poll(
      async () => {
        await app.mouse.wheel(0, -3000)
        return app.getByText("Turn 1:", { exact: false }).count()
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0)
  await app.getByRole("button", { name: `${TURNS}. New message`, exact: true }).click()
  await expect(latest).toBeInViewport()
  await app.getByRole("button", { name: "1. New message", exact: true }).click()
  await expect(app.getByText("Turn 1:", { exact: false }).first()).toBeInViewport()
  await app.getByRole("button", { name: "Scroll to latest message" }).click()
  await expect(latest).toBeInViewport()

  const messages = await api.messages(workspace.directory, session.id)
  expect(messages.filter((message) => message.info.role === "user")).toHaveLength(TURNS)
})

test("11 long transcript: a file path in a reply opens the file in its own tab", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("filelink")
  await stack.acp.write("file", { steps: [{ kind: "text", text: "The project name is written in `README.md`" }] })
  const session = await api.createSession(workspace.directory, { title: "File link", harness: SCRIPTED_ACP_HARNESS })
  await api.prompt(workspace.directory, session.id, `Where is the name? ${acpScriptToken("file")}`)

  await app.goto(`${stack.url}/w/${workspace.id}/s/${session.id}`)
  await expect(app.getByText("The project name is written in", { exact: false })).toBeVisible()
  await app.getByText("README.md", { exact: true }).click()
  await expect(app.getByRole("tab", { name: "README.md" })).toBeVisible()
  await expect(app.getByText("filelink", { exact: true }).first()).toBeVisible()
  expect(assistantText(await api.messages(workspace.directory, session.id))).toContain("README.md")
})
