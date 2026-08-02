import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { MarkdownManager } from "@tiptap/markdown"
import { detectMarkdown } from "../markdown/detector"
import { joinMarkdownEnvelope, normalizeSerializedMarkdownBody } from "../markdown/frontmatter"
import { documentRichEditorExtensions } from "./rich-extensions"

const supportedDirectory = new URL("../markdown/fixtures/supported/", import.meta.url)
const docsDirectory = resolve(import.meta.dir, "../../../../../../docs")

describe("production rich editor Markdown parity", () => {
  test("uses the intended production extension configuration", () => {
    expect(documentRichEditorExtensions().map((extension) => extension.name)).toEqual([
      "starterKit",
      "codeBlock",
      "link",
      "underline",
      "textStyle",
      "color",
      "highlight",
      "image",
      "table",
      "tableRow",
      "tableHeader",
      "tableCell",
      "taskList",
      "taskItem",
      "slashCommands",
      "markdown",
    ])
  })

  test("round-trips every detector-admitted supported fixture with the production configuration", () => {
    for (const name of readdirSync(supportedDirectory).sort()) {
      const markdown = readFileSync(new URL(name, supportedDirectory), "utf8")
      const detected = detectMarkdown(markdown)
      expect(detected.status, name).toBe("rich")
      if (detected.status !== "rich") continue
      expect(productionSerializedMarkdown(detected), name).toBe(markdown)
    }
  })

  test("round-trips every repository document admitted by the detector with the production configuration", async () => {
    for (const name of [...new Bun.Glob("**/*.md").scanSync({ cwd: docsDirectory })].sort()) {
      const markdown = await Bun.file(resolve(docsDirectory, name)).text()
      const detected = detectMarkdown(markdown)
      if (detected.status !== "rich") continue
      expect(productionSerializedMarkdown(detected), name).toBe(markdown)
    }
  }, 30000)
})

function productionSerializedMarkdown(detected: Extract<ReturnType<typeof detectMarkdown>, { status: "rich" }>) {
  const manager = new MarkdownManager({ extensions: documentRichEditorExtensions() })
  return joinMarkdownEnvelope(
    detected.envelope,
    normalizeSerializedMarkdownBody(detected.envelope, manager.serialize(manager.parse(detected.envelope.body))),
  )
}
