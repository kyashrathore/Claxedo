import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { HtmlTagDescriptor } from "vite"
import { startupFrameStyle, stylesheetsAfterRoot, webAppDocument } from "./vite.web-document"

const INDEX_HTML = new URL("./index.html", import.meta.url)
const LOGIN_HTML = new URL("./login.html", import.meta.url)

async function document(source: URL = INDEX_HTML) {
  const result = await webAppDocument(await readFile(source, "utf8"), source === LOGIN_HTML ? "login.html" : "index.html")
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
    expect(login.tags).toEqual(shell.tags.filter((tag) => tag.tag === "meta"))
    expect(login.html).not.toContain("/oc-theme-preload.js")
    expect(login.html).toContain('<link rel="preload" href="/api/auth/get-session" as="fetch" crossorigin="use-credentials" />')
    expect(login.html).toContain('src="/src/login.tsx"')
    expect(shell.html).not.toContain('rel="preload"')
  })

  test("refuses a document that no longer loads the theme preload it inlines", async () => {
    await expect(webAppDocument("<!doctype html><html><head></head></html>", "index.html")).rejects.toThrow("theme preload")
  })

  test("the shell carries the startup frame in its head, from the sheet the app's bundle takes it from, and the signed-out document does not", async () => {
    const shell = await document()
    const frame = shell.tags.find((tag) => tag.attrs?.id === "claxedo-startup-frame")
    expect(frame?.tag).toBe("style")
    expect(frame?.injectTo).toBe("head")
    const sheet = typeof frame?.children === "string" ? frame.children : ""
    expect(sheet).toBe(await startupFrameStyle())
    expect(sheet).toContain("#root:empty:before")
    expect(sheet).toContain(":root[data-startup=plain] #root:empty:before{content:none}")
    expect(await readFile(new URL("./src/styles.css", import.meta.url), "utf8")).toContain('@import "./shell/styles/startup.css";')
    expect((await document(LOGIN_HTML)).tags.some((tag) => tag.tag === "style")).toBe(false)
  })

  test("the shell's stylesheets follow its root, so the root's startup frame paints while they load, and its head preloads them", async () => {
    const built = [
      "<head>",
      '<script type="module" crossorigin src="/assets/main-a.js"></script>',
      '<link rel="stylesheet" crossorigin href="/assets/preferences-b.css">',
      '<link rel="stylesheet" crossorigin href="/assets/main-c.css">',
      "</head><body>",
      '<div id="root" class="flex flex-col h-dvh p-px"></div>',
      "</body>",
    ].join("\n")
    const moved = stylesheetsAfterRoot(built)
    const head = moved.slice(0, moved.indexOf("</head>"))
    expect(head).not.toContain('rel="stylesheet"')
    expect(head).toContain("/assets/main-a.js")
    expect([...head.matchAll(/<link rel="preload" as="style" crossorigin href="([^"]+)">/g)].map((match) => match[1]), "the head still asks for every sheet at once").toEqual(["/assets/preferences-b.css", "/assets/main-c.css"])
    const body = moved.slice(moved.indexOf('<div id="root"'))
    expect([...body.matchAll(/href="([^"]+\.css)"/g)].map((match) => match[1])).toEqual(["/assets/preferences-b.css", "/assets/main-c.css"])
    expect(() => stylesheetsAfterRoot(built.replace('<div id="root" class="flex flex-col h-dvh p-px"></div>', '<main id="root"></main>'))).toThrow("root")
    expect(() => stylesheetsAfterRoot(built.replace(/<link rel="stylesheet"[^>]*>/g, ""))).toThrow("stylesheet")
  })
})
