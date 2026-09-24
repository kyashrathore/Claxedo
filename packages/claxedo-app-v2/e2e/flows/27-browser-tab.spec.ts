import http from "node:http"
import type { Locator, Page } from "@playwright/test"
import { expect, SCRIPTED_ACP_HARNESS, test } from "../harness"

const PAGE_PORTS = { first: 47250, last: 47299 }

const PAGES: Readonly<Record<string, string>> = {
  "/first.html": "<!doctype html><title>First</title><h1>First preview page</h1>",
  "/second.html": "<!doctype html><title>Second</title><h1>Second preview page</h1>",
}

type PageServer = { readonly url: string; readonly requested: readonly string[]; readonly close: () => Promise<void> }

async function listen(server: http.Server): Promise<number> {
  for (let port = PAGE_PORTS.first; port <= PAGE_PORTS.last; port += 1) {
    const bound = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false))
      server.listen(port, "127.0.0.1", () => resolve(true))
    })
    if (bound) return port
  }
  throw new Error(`No free port in ${PAGE_PORTS.first}-${PAGE_PORTS.last}`)
}

async function servePages(): Promise<PageServer> {
  const requested: string[] = []
  const server = http.createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://pages").pathname
    requested.push(path)
    const body = PAGES[path]
    if (body === undefined) return void response.writeHead(404).end()
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body)
  })
  const port = await listen(server)
  return {
    url: `http://127.0.0.1:${port}`,
    requested,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function createServerProject(url: string, name: string, directory: string) {
  const response = await fetch(new URL("/api/claxedo/projects", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, source: { kind: "directory", directory } }),
  })
  expect(response.status).toBe(201)
}

async function openBrowserTab(app: Page): Promise<Locator> {
  const toggle = app.getByRole("button", { name: "Toggle workspace panel" })
  await expect(toggle).toBeVisible()
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
  await app.getByRole("tablist", { name: "Workspace panel tabs" }).getByRole("tab", { name: "Browser" }).click()
  return app.getByRole("tabpanel", { name: "Browser" })
}

async function goTo(browser: Locator, url: string) {
  const address = browser.getByRole("textbox", { name: "Address" })
  await address.fill(url)
  await address.press("Enter")
}

test("27 browser tab: preview a local page in the sandboxed preview, navigate from the address bar", async ({
  stack,
  api,
  app,
}) => {
  const pages = await servePages()
  try {
    const workspace = await stack.daemon.makeWorkspace("browser")
    await createServerProject(stack.url, "Browser", workspace.directory)
    const session = await api.createSession(workspace.directory, { title: "Browser", harness: SCRIPTED_ACP_HARNESS })
    await app.goto(`${stack.url}/w/${encodeURIComponent(workspace.id)}/s/${encodeURIComponent(session.id)}`)

    const browser = await openBrowserTab(app)
    await expect(browser.getByText("No page open")).toBeVisible()
    const preview = browser.getByTitle("Page preview").contentFrame()

    await goTo(browser, `${pages.url}/first.html`)
    await expect(preview.getByRole("heading", { name: "First preview page" })).toBeVisible()
    await goTo(browser, `${pages.url}/second.html`)
    await expect(preview.getByRole("heading", { name: "Second preview page" })).toBeVisible()
    await expect(browser.getByRole("textbox", { name: "Address" })).toHaveValue(`${pages.url}/second.html`)
    expect(pages.requested).toEqual(["/first.html", "/second.html"])
  } finally {
    await pages.close()
  }
})
