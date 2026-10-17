import type { Page } from "@playwright/test"
import { expect, MCP_APP_FIXTURE_FORECAST, mcpAppFrameTitle, sendPrompt, sessionRoute, startMcpAppFixture, test, type SessionHarness } from "../harness"

const PI: SessionHarness = { id: "pi", access: "native" }

async function expectAppPainted(app: Page) {
  const frame = app.getByTitle(mcpAppFrameTitle())
  await expect(frame).toBeVisible()
  const view = frame.contentFrame()
  await expect(view.getByText(`Tool result: ${MCP_APP_FIXTURE_FORECAST}`, { exact: true })).toBeVisible()
  return view
}

test("62 a Pi tool with an MCP app draws the app in place of its tool row, replays after a reload and without its server, and runs an app tool only once the reader confirms", async ({ stack, api, app }) => {
  const mcp = await startMcpAppFixture(stack.url)
  let serving = true
  const stopServer = async () => {
    if (!serving) return
    serving = false
    await mcp.close()
  }
  try {
    const workspace = await stack.daemon.makeWorkspace("mcp-app")
    const model = await api.defaultModel(workspace.directory, "pi")
    const session = await api.createSession(workspace.directory, { title: "MCP app", harness: PI, model })
    await api.prompt(workspace.directory, session.id, "Which tools can you use? Reply with exactly this one token: TOOLSLISTED", { model })
    const offered = [...new Set(stack.scripted.requests.flatMap((request) => request.tools.map((tool) => tool.name)))]
    const showApp = offered.find((name) => name.includes("fixture__show_app"))
    expect(showApp, `Pi offered no fixture show_app tool: ${offered.join(", ")}`).toBeDefined()
    expect(offered.filter((name) => name.includes("record_visit"))).toEqual([])

    stack.scripted.scriptTool({ name: showApp!, input: { city: "Lisbon" }, whenPromptIncludes: "APPSHOWN" })
    await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
    await sendPrompt(app, "Show the forecast app. Reply with exactly this one token: APPSHOWN")
    const view = await expectAppPainted(app)
    const scheme = (await app.locator("html").getAttribute("data-color-scheme")) === "dark" ? "dark" : "light"
    await expect(view.locator("body")).toHaveClass(`theme-${scheme}`)

    await app.reload()
    const reloaded = await expectAppPainted(app)

    const consent = app.getByRole("dialog", { name: "Let the app run a tool?" })
    await reloaded.getByRole("button", { name: "Record a visit" }).click()
    await expect(consent).toContainText("record_visit")
    await consent.getByRole("button", { name: "Cancel" }).click()
    await expect(reloaded.getByText("Visit refused: The reader declined the tool call", { exact: true })).toBeVisible()

    await reloaded.getByRole("button", { name: "Record a visit" }).click()
    await consent.getByRole("button", { name: "Run tool" }).click()
    await expect(reloaded.getByText("Visit result: Visit recorded for fixture app", { exact: true })).toBeVisible()
    expect(mcp.calls).toEqual([
      { name: "show_app", arguments: { city: "Lisbon" } },
      { name: "record_visit", arguments: { visitor: "fixture app" } },
    ])

    await stopServer()
    await app.reload()
    await expectAppPainted(app)
  } finally {
    await stopServer()
  }
})
