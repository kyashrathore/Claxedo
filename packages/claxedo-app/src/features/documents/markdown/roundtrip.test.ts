import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { JSONContent } from "@tiptap/core"
import { detectMarkdown, serializeMarkdownDocument, type RichMarkdown } from "./detector"

const adversarialDirectory = new URL("./fixtures/adversarial/", import.meta.url)
const curatedDirectory = new URL("./fixtures/curated/", import.meta.url)
const supportedDirectory = new URL("./fixtures/supported/", import.meta.url)
const docsDirectory = resolve(import.meta.dir, "../../../../../../docs")

describe("Markdown adversarial corpus", () => {
  test("routes every unsupported construct to source mode before rich parsing", () => {
    for (const name of readdirSync(adversarialDirectory).sort()) {
      const result = detectMarkdown(readFileSync(new URL(name, adversarialDirectory), "utf8"))

      expect(result.status, name).toBe("source")
      if (result.status !== "source") continue
      expect(result.reason.code, name).toBe("unsupported_syntax")
    }
  })

  test("keeps the supported CommonMark, GFM, and Mermaid subset byte-stable", () => {
    for (const name of readdirSync(supportedDirectory).sort()) {
      const markdown = readFileSync(new URL(name, supportedDirectory), "utf8")
      const result = detectMarkdown(markdown)

      expect(result.status, name).toBe("rich")
      if (result.status !== "rich") continue
      expect(serializedMarkdown(result.document, result.envelope), name).toBe(markdown)
    }
  })

  test("routes measured GFM normalizations outside the supported subset to source mode", () => {
    for (const name of readdirSync(curatedDirectory).sort()) {
      const result = detectMarkdown(readFileSync(new URL(name, curatedDirectory), "utf8"))

      expect(result.status, name).toBe("source")
    }
  })

  test("checks every docs Markdown file for byte-stable rich-mode admission", async () => {
    const names = [...new Bun.Glob("**/*.md").scanSync({ cwd: docsDirectory })].sort()
    const counts = { rich: 0, source: 0, rejected: 0, roundtrip_mismatch: 0, unsupported_syntax: 0 }
    expect(names).toHaveLength(52)

    for (const name of names) {
      const bytes = new Uint8Array(await Bun.file(resolve(docsDirectory, name)).arrayBuffer())
      const result = detectMarkdown(bytes)

      counts[result.status] += 1
      if (result.status === "source" && result.reason.code === "roundtrip_mismatch") counts.roundtrip_mismatch += 1
      if (result.status === "source" && result.reason.code === "unsupported_syntax") counts.unsupported_syntax += 1
      if (result.status === "source") expect(new TextEncoder().encode(result.markdown), name).toEqual(bytes)
      if (result.status !== "rich") continue
      expect(new TextEncoder().encode(serializedMarkdown(result.document, result.envelope)), name).toEqual(bytes)
    }

    expect(counts).toEqual({ rich: 0, source: 52, rejected: 0, roundtrip_mismatch: 27, unsupported_syntax: 25 })
  })

  test("keeps a one-paragraph source edit in a representative repository doc local", () => {
    const markdown = readFileSync(resolve(docsDirectory, "README.md"), "utf8")
    const result = detectMarkdown(markdown)
    expect(result.status).toBe("source")
    if (result.status !== "source") return
    const edited = result.markdown.replace(
      "This directory is intentionally small.",
      "This directory is deliberately small.",
    )
    const before = result.markdown.split("\n")
    const after = edited.split("\n")

    expect(before.flatMap((line, index) => (line === after[index] ? [] : [index]))).toEqual([5])
  })

  test("keeps a first rich edit local to one paragraph in a representative repository fixture", () => {
    const path = new URL("representative-repository.rich.md", supportedDirectory)
    const markdown = readFileSync(path, "utf8")
    const result = detectMarkdown(markdown)
    expect(result.status).toBe("rich")
    if (result.status !== "rich") return

    const saved = serializedMarkdown(replaceText(result.document), result.envelope)
    const before = markdown.split("\n")
    const after = saved.split("\n")

    expect(before.flatMap((line, index) => (line === after[index] ? [] : [index]))).toEqual([9])
    expect(after[9]).toBe("The target paragraph records the approved release decision.")
  })
})

function replaceText(node: JSONContent): JSONContent {
  if (node.type === "text" && node.text?.includes("original release decision")) {
    return { ...node, text: node.text.replace("original release decision", "approved release decision") }
  }
  return node.content ? { ...node, content: node.content.map(replaceText) } : node
}

function serializedMarkdown(document: JSONContent, envelope: RichMarkdown["envelope"]) {
  const result = serializeMarkdownDocument(document, envelope)
  expect(result.status).toBe("serialized")
  return result.status === "serialized" ? result.markdown : ""
}
