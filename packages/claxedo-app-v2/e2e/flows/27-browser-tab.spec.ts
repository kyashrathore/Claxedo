import http from "node:http"
import { acpScriptToken, expect, SCRIPTED_ACP_HARNESS, test } from "../harness"

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

test("27 browser tab: a local link in a reply opens the Browser tab with the page in the sandboxed preview", async ({
  stack,
  api,
  app,
}) => {
  const pages = await servePages()
  try {
    const workspace = await stack.daemon.makeWorkspace("browser", "Browser")
    const reply = `Open [the first page](${pages.url}/first.html) or [the second page](${pages.url}/second.html).`
    await stack.acp.write("links", { steps: [{ kind: "text", text: reply }] })
    const session = await api.createSession(workspace.directory, { title: "Browser", harness: SCRIPTED_ACP_HARNESS })
    await api.prompt(workspace.directory, session.id, `Where are the pages? ${acpScriptToken("links")}`)
    await app.goto(`${stack.url}/w/${encodeURIComponent(workspace.id)}/s/${encodeURIComponent(session.id)}`)

    await app.getByRole("link", { name: "the first page" }).click()
    const panel = app.getByRole("complementary", { name: "Workspace panel" })
    await expect(panel.getByRole("button", { name: "Browser", exact: true })).toHaveAttribute("aria-current", "true")
    const preview = panel.getByTitle("External source preview").contentFrame()
    await expect(preview.getByRole("heading", { name: "First preview page" })).toBeVisible()
    await expect(panel.getByTestId("browser-pane-address-bar")).toHaveValue(`${pages.url}/first.html`)
    await expect(panel.getByTestId("browser-pane-address-bar")).toHaveAttribute("readonly", "")

    await app.getByRole("link", { name: "the second page" }).click()
    await expect(preview.getByRole("heading", { name: "Second preview page" })).toBeVisible()
    expect(pages.requested).toEqual(["/first.html", "/second.html"])
  } finally {
    await pages.close()
  }
})
