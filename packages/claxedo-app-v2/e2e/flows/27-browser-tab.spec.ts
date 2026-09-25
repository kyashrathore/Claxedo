import { acpScriptToken, expect, SCRIPTED_ACP_HARNESS, sessionRoute, test } from "../harness"

const PAGES: Readonly<Record<string, string>> = {
  "/first.html": "<!doctype html><title>First</title><h1>First preview page</h1>",
  "/second.html": "<!doctype html><title>Second</title><h1>Second preview page</h1>",
}

test("27 browser tab: a local link from the agent opens in the panel's sandboxed preview, the next one reuses the tab", async ({
  stack,
  api,
  app,
  isMobile,
}) => {
  const pages = await stack.localPages(PAGES)
  const workspace = await stack.daemon.makeWorkspace("browser", "Browser")
  await stack.acp.write("links", {
    steps: [{ kind: "text", text: `Preview the [first page](${pages.url}/first.html) and the [second page](${pages.url}/second.html).` }],
  })
  const session = await api.createSession(workspace.directory, { title: "Previews", harness: SCRIPTED_ACP_HARNESS })
  await api.prompt(workspace.directory, session.id, `Link the previews. ${acpScriptToken("links")}`)
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)

  await app.getByRole("link", { name: "first page" }).click()
  const panel = app.getByRole("complementary", { name: "Workspace panel" })
  const preview = panel.getByTitle("Browser preview").contentFrame().getByTitle("External source preview")
  const address = panel.getByRole("textbox", { name: "Enter URL or search" })
  await expect(preview).toHaveAttribute("sandbox", "")
  await expect(preview.contentFrame().getByRole("heading", { name: "First preview page" })).toBeVisible()
  await expect(address).toHaveValue(`${pages.url}/first.html`)

  if (isMobile) await panel.getByRole("button", { name: "Close workspace panel" }).click()
  await app.getByRole("link", { name: "second page" }).click()
  await expect(preview.contentFrame().getByRole("heading", { name: "Second preview page" })).toBeVisible()
  await expect(address).toHaveValue(`${pages.url}/second.html`)
  await expect(panel.getByRole("button", { name: "Browser", exact: true })).toHaveCount(1)
  expect(pages.requested).toEqual(["/first.html", "/second.html"])
})
