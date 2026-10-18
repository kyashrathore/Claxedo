import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { HtmlTagDescriptor } from "vite"
import { webAppDocument } from "./vite.web-document"

const INDEX_HTML = new URL("./index.html", import.meta.url)

async function document(serverUrl: string | undefined) {
  const result = await webAppDocument(await readFile(INDEX_HTML, "utf8"), serverUrl)
  if (typeof result !== "object" || Array.isArray(result)) throw new Error("the web document transform returns html and tags")
  return result
}

function attribute(tags: readonly HtmlTagDescriptor[], tag: string, name: string): string[] {
  return tags.filter((descriptor) => descriptor.tag === tag).map((descriptor) => String(descriptor.attrs?.[name] ?? ""))
}

describe("webAppDocument", () => {
  test("runs the theme preload inline, allowed by its hash in the policy, instead of fetching it", async () => {
    const { html, tags } = await document("https://api.example.com")
    expect(html).not.toContain("/oc-theme-preload.js")
    const inline = /<script>([\s\S]+?)<\/script>/.exec(html)?.[1]
    expect(inline).toContain("opencode-theme-id")
    const hash = createHash("sha256").update(inline ?? "").digest("base64")
    const policy = tags.find((tag) => tag.attrs?.["http-equiv"] === "Content-Security-Policy")?.attrs?.content
    expect(String(policy)).toContain(`'sha256-${hash}'`)
  })

  test("opens the credentialed connection to the server origin while the scripts download", async () => {
    const { tags } = await document("https://api.example.com/base/")
    expect(attribute(tags, "link", "rel")).toEqual(["preconnect"])
    expect(attribute(tags, "link", "href")).toEqual(["https://api.example.com"])
    expect(attribute(tags, "link", "crossorigin")).toEqual(["use-credentials"])
  })

  test("a build served by its own server preconnects to nothing", async () => {
    const { tags } = await document(undefined)
    expect(attribute(tags, "link", "rel")).toEqual([])
  })

  test("refuses an index.html that no longer loads the theme preload it inlines", async () => {
    await expect(webAppDocument("<!doctype html><html><head></head></html>", "https://api.example.com")).rejects.toThrow("theme preload")
  })
})
