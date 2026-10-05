import type { Page } from "@playwright/test"
import { acpScriptToken, assistantText, expect, SCRIPTED_ACP_HARNESS, sessionRoute, test, UI } from "../harness"
import { leaveSettings, openSection, revealRail } from "./15-settings.navigation"

const PAGES: Readonly<Record<string, string>> = {
  "/first.html": "<!doctype html><title>First</title><h1>First preview page</h1>",
  "/second.html": '<!doctype html><title>Second</title><h1>Second preview page</h1><input aria-label="Page draft">',
}

async function visitShellPages(app: Page, isMobile: boolean) {
  await revealRail(app, isMobile)
  await app.getByTestId("sidebar-marketplace-entry").click()
  await expect(app.getByRole("searchbox", { name: "Search plugins" })).toBeVisible()
  await expect(app.getByRole("complementary", { name: "Workspace panel" })).toHaveCount(0)
  await app.getByRole("button", { name: "claxedo", exact: true }).click()
  const details = app.getByRole("complementary", { name: "claxedo details", exact: true })
  await expect(details).toBeVisible()
  await expect(app.getByTestId("browser-pane-webview-host")).toHaveCount(1)
  await details.getByRole("button", { name: "Close details", exact: true }).last().click()
  await revealRail(app, isMobile)
  await app.getByRole("button", { name: "Settings", exact: true }).click()
  await openSection(app, isMobile, "Appearance")
  await expect(app.getByRole("complementary", { name: "Workspace panel" })).toHaveCount(0)
  await expect(app.getByTestId("browser-pane-webview-host")).toHaveCount(1)
  await expect(app.getByTestId("browser-pane-webview-host")).toBeHidden()
  await leaveSettings(app, isMobile)
}

test("27 browser tab: a local link from the agent opens in the panel's sandboxed preview, the next one reuses the tab", async ({
  stack,
  api,
  app,
  isMobile,
}) => {
  const pages = await stack.localPages(PAGES)
  const workspace = await stack.daemon.makeWorkspace("browser", "Browser")
  const otherWorkspace = await stack.daemon.makeWorkspace("browser-other", "Other workspace")
  await api.createSession(otherWorkspace.directory, { title: "Other workspace session", harness: SCRIPTED_ACP_HARNESS })
  await stack.acp.write("links", {
    steps: [{ kind: "text", text: `Preview the [first page](${pages.url}/first.html) and the [second page](${pages.url}/second.html).` }],
  })
  const session = await api.createSession(workspace.directory, { title: "Previews", harness: SCRIPTED_ACP_HARNESS })
  await api.createSession(workspace.directory, { title: "Other session", harness: SCRIPTED_ACP_HARNESS })
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
  const draft = preview.contentFrame().getByRole("textbox", { name: "Page draft" })
  await draft.fill("Keep this page state")
  await panel.getByRole("button", { name: "Review", exact: true }).click()
  await panel.getByRole("button", { name: "Browser", exact: true }).click()
  await expect(draft).toHaveValue("Keep this page state")
  await panel.getByRole("button", { name: "Close workspace panel" }).click()
  await expect(panel).toHaveCount(0)
  if (isMobile) await app.getByRole("button", { name: UI.openRail }).click()
  await app.getByRole("button", { name: "Other session", exact: true }).click()
  if (isMobile) await app.getByRole("button", { name: UI.openRail }).click()
  await app.getByRole("button", { name: "Other workspace session", exact: true }).click()
  await visitShellPages(app, isMobile)
  if (isMobile) await app.getByRole("button", { name: UI.openRail }).click()
  await app.getByRole("button", { name: "Previews", exact: true }).click()
  await app.getByRole("button", { name: "Open workspace panel", exact: true }).click()
  await expect(draft).toHaveValue("Keep this page state")
  await expect(panel.getByRole("button", { name: "Browser", exact: true })).toHaveCount(1)
  expect(pages.requested).toEqual(["/first.html", "/second.html"])
  await panel.getByRole("button", { name: "Close browser", exact: true }).click()
  await expect(app.getByTitle("Browser preview")).toHaveCount(0)
})

test("27 browser tab: desktop links reuse the guest across tabs, sessions and workspaces until the browser closes", { tag: "@desktop" }, async ({ desktop, stack }) => {
  const pages = await stack.localPages(PAGES)
  const workspace = await desktop.makeWorkspace("browser-links")
  const otherWorkspace = await desktop.makeWorkspace("browser-other")
  await desktop.api.createSession(otherWorkspace.directory, { title: "Other workspace session", harness: SCRIPTED_ACP_HARNESS })
  await desktop.acp.write("browser-links", {
    steps: [{ kind: "text", text: `[First page](${pages.url}/first.html) and [Second page](${pages.url}/second.html).` }],
  })
  const session = await desktop.api.createSession(workspace.directory, { title: "Browser links", harness: SCRIPTED_ACP_HARNESS })
  await desktop.api.createSession(workspace.directory, { title: "Other browser session", harness: SCRIPTED_ACP_HARNESS })
  await desktop.api.prompt(workspace.directory, session.id, `Show the pages. ${acpScriptToken("browser-links")}`)
  const window = desktop.window
  await window.reload()
  await window.getByRole("button", { name: "Browser links", exact: true }).click()
  const panel = window.getByRole("complementary", { name: "Workspace panel" })
  const address = panel.getByRole("textbox", { name: "Enter URL or search" })
  const heading = () => desktop.electron.evaluate(async ({ webContents }) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getType() === "webview")
    return guest?.executeJavaScript("document.querySelector('h1')?.textContent")
  })

  await window.getByRole("link", { name: "First page", exact: true }).click()
  await expect(panel.getByTestId("browser-pane-webview-host")).toBeVisible()
  await expect.poll(heading).toBe("First preview page")
  await expect(address).toHaveValue(`${pages.url}/first.html`)
  await window.getByRole("link", { name: "Second page", exact: true }).click()
  await expect.poll(heading).toBe("Second preview page")
  await expect(address).toHaveValue(`${pages.url}/second.html`)
  const guestId = () => desktop.electron.evaluate(({ webContents }) => webContents.getAllWebContents().find((contents) => contents.getType() === "webview")?.id)
  const originalGuestId = await guestId()
  await panel.getByRole("button", { name: "Review", exact: true }).click()
  await panel.getByRole("button", { name: "Browser", exact: true }).click()
  await expect.poll(heading).toBe("Second preview page")
  await expect(address).toHaveValue(`${pages.url}/second.html`)
  expect(await guestId()).toBe(originalGuestId)
  await window.getByRole("button", { name: "Other browser session", exact: true }).click()
  await expect(window.getByRole("button", { name: "Open workspace panel", exact: true })).toBeVisible()
  await expect(panel).toHaveCount(0)
  await window.getByRole("button", { name: "Other workspace session", exact: true }).click()
  await expect(window.getByRole("button", { name: "Open workspace panel", exact: true })).toBeVisible()
  await visitShellPages(window, false)
  expect(await guestId()).toBe(originalGuestId)
  await window.getByRole("button", { name: "Browser links", exact: true }).click()
  await expect(address).toHaveValue(`${pages.url}/second.html`)
  expect(await guestId()).toBe(originalGuestId)
  await expect(panel.getByRole("button", { name: "Browser", exact: true })).toHaveCount(1)
  await expect(window.getByText(/no browser pane registered/)).toHaveCount(0)
  expect(assistantText(await desktop.api.messages(workspace.directory, session.id))).toContain(`${pages.url}/first.html`)
  const host = await desktop.electron.browserWindow(window)
  const hostId = await host.evaluate((main) => main.webContents.id)
  const rejected = await window.evaluate((id) => {
    const { api } = globalThis as unknown as { api: { browser: { register(paneId: string, contentsId: number): Promise<{ ok: boolean; error?: string }> } } }
    return api.browser.register("forbidden-host", id)
  }, hostId)
  expect(rejected).toEqual({ ok: false, error: `BrowserRegistry.register: webContents ${hostId} is not an admitted guest` })
  await panel.getByRole("button", { name: "Close browser", exact: true }).click()
  await expect.poll(guestId).toBeUndefined()
})
