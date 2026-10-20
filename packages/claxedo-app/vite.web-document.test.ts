import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { HtmlTagDescriptor } from "vite"
import { webAppDocument } from "./vite.web-document"

const INDEX_HTML = new URL("./index.html", import.meta.url)
const LOGIN_HTML = new URL("./login.html", import.meta.url)

async function document(source: URL = INDEX_HTML) {
  const result = await webAppDocument(await readFile(source, "utf8"))
  if (typeof result !== "object" || Array.isArray(result)) throw new Error("the web document transform returns html and tags")
  return result
}

function attribute(tags: readonly HtmlTagDescriptor[], tag: string, name: string): string[] {
  return tags.filter((descriptor) => descriptor.tag === tag).map((descriptor) => String(descriptor.attrs?.[name] ?? ""))
}

describe("webAppDocument", () => {
  test("runs the theme preload inline, allowed by its hash in the policy, instead of fetching it", async () => {
    const { html, tags } = await document()
    expect(html).not.toContain("/oc-theme-preload.js")
    const inline = /<script>([\s\S]+?)<\/script>/.exec(html)?.[1]
    expect(inline).toContain("opencode-theme-id")
    const hash = createHash("sha256").update(inline ?? "").digest("base64")
    const policy = tags.find((tag) => tag.attrs?.["http-equiv"] === "Content-Security-Policy")?.attrs?.content
    expect(String(policy)).toContain(`'sha256-${hash}'`)
  })

  test("connects only to its own origin and preconnects to nothing, since the API and the relay are served there", async () => {
    const { tags } = await document()
    const policy = String(tags.find((tag) => tag.attrs?.["http-equiv"] === "Content-Security-Policy")?.attrs?.content)
    expect(policy).toContain("connect-src 'self';")
    expect(attribute(tags, "link", "rel")).toEqual([])
  })

  test("the signed-out document inlines the same theme preload under the same policy and preloads its one read, the session, in its head", async () => {
    const shell = await document()
    const login = await document(LOGIN_HTML)
    expect(login.tags).toEqual(shell.tags)
    expect(login.html).not.toContain("/oc-theme-preload.js")
    expect(login.html).toContain('<link rel="preload" href="/api/auth/get-session" as="fetch" crossorigin="use-credentials" />')
    expect(login.html).toContain('src="/src/login.tsx"')
    expect(shell.html).not.toContain('rel="preload"')
  })

  test("refuses a document that no longer loads the theme preload it inlines", async () => {
    await expect(webAppDocument("<!doctype html><html><head></head></html>")).rejects.toThrow("theme preload")
  })
})
