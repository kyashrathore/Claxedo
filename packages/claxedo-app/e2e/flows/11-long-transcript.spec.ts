import { acpScriptToken, assistantText, expect, SCRIPTED_ACP_HARNESS, sessionRoute, test } from "../harness"

test.skip(({ isMobile }) => isMobile, "flow 11 runs at desktop width")

const TURNS = 30

test("11 long transcript: older turns page in above the reader, the nav rail marks the turn scrolled to, and it jumps back to the first turn", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("long")
  const session = await api.createSession(workspace.directory, { title: "Long", harness: SCRIPTED_ACP_HARNESS })
  for (let turn = 1; turn <= TURNS; turn += 1) {
    await api.prompt(workspace.directory, session.id, `Turn ${turn}: Reply with exactly this one token: T${String(turn).padStart(2, "0")}X`)
  }
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  const latest = app.getByText(`Turn ${TURNS}:`, { exact: false }).first()
  await expect(latest).toBeVisible()
  await expect(app.getByText("Turn 1:", { exact: false })).toHaveCount(0)
  await expect(app.getByRole("button", { name: "1. New message", exact: true }), "the rail lists the first turn from the outline before any scroll").toBeVisible()

  await app.getByRole("region", { name: "scrollable content" }).hover()
  await app.mouse.wheel(0, -120)
  await expect(app.getByText(`Turn ${TURNS - 1}:`, { exact: false }).first()).toBeAttached()
  await expect(latest).toBeInViewport()

  await app.getByRole("button", { name: "1. New message", exact: true }).click()
  await expect(app.getByText("Turn 1:", { exact: false }).first(), "picking an unloaded turn pages it in and lands on it").toBeInViewport()
  await app.getByRole("button", { name: `${TURNS}. New message`, exact: true }).click()
  await expect(latest).toBeInViewport()
  await app.getByRole("region", { name: "scrollable content" }).hover()
  await expect
    .poll(
      async () => {
        await app.mouse.wheel(0, -3000)
        return app.getByRole("button", { name: "1. New message", exact: true }).getAttribute("aria-current")
      },
      { timeout: 30_000 },
    )
    .toBe("step")
  await app.getByRole("button", { name: `${TURNS}. New message`, exact: true }).click()
  await expect(latest).toBeInViewport()
  await app.getByRole("button", { name: "1. New message", exact: true }).click()
  await expect(app.getByText("Turn 1:", { exact: false }).first()).toBeInViewport()
  await app.getByRole("button", { name: "Scroll to latest message" }).click()
  await expect(latest).toBeInViewport()

  const messages = await api.messages(workspace.directory, session.id)
  expect(messages.filter((message) => message.info.role === "user")).toHaveLength(TURNS)
})

test("11 long transcript: a file path in a reply opens the file in the workspace panel", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("filelink")
  await stack.acp.write("file", { steps: [{ kind: "text", text: "The project name is written in `README.md`" }] })
  const session = await api.createSession(workspace.directory, { title: "File link", harness: SCRIPTED_ACP_HARNESS })
  await api.prompt(workspace.directory, session.id, `Where is the name? ${acpScriptToken("file")}`)

  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await expect(app.getByText("The project name is written in", { exact: false })).toBeVisible()
  await app.getByText("README.md", { exact: true }).click()
  const panel = app.getByRole("complementary", { name: "Workspace panel" })
  await expect(panel.getByRole("button", { name: "README.md", exact: true })).toBeVisible()
  await expect(panel.getByText("filelink", { exact: true }).first()).toBeVisible()
  expect(assistantText(await api.messages(workspace.directory, session.id))).toContain("README.md")
})

test("11 long transcript: a #message link opens at that turn and mod+arrows move between turns", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("links")
  const session = await api.createSession(workspace.directory, { title: "Links", harness: SCRIPTED_ACP_HARNESS })
  for (let turn = 1; turn <= 12; turn += 1) {
    await api.prompt(workspace.directory, session.id, `Link turn ${turn}: Reply with exactly this one token: L${String(turn).padStart(2, "0")}X`)
  }
  const users = (await api.messages(workspace.directory, session.id)).filter((message) => message.info.role === "user")
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}#message-${users[1]!.info.id}`)
  await expect(app.getByText("Link turn 2:", { exact: false }).first()).toBeInViewport()
  await app.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  await app.keyboard.press("ControlOrMeta+ArrowDown")
  await expect(app.getByText("Link turn 3:", { exact: false }).first()).toBeInViewport()
})
