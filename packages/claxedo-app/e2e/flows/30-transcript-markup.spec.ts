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
