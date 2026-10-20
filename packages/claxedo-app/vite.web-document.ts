import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { transformWithEsbuild, type HtmlTagDescriptor, type IndexHtmlTransformResult, type Plugin } from "vite"
import { browserPreviewPolicy, contentSecurityPolicy } from "./content-security-policy"
import { FRAME_BOOTSTRAP } from "./src/plugins/frame/document"

export const WEB_DOCUMENT_PLUGINS = ["claxedo:web-document", "claxedo:web-document-stylesheets"] as const

const THEME_PRELOAD_FILE = fileURLToPath(new URL("./public/oc-theme-preload.js", import.meta.url))
const THEME_PRELOAD_TAG = `<script id="oc-theme-preload-script" src="/oc-theme-preload.js"></script>`
const STARTUP_FRAME_FILE = fileURLToPath(new URL("./src/shell/styles/startup.css", import.meta.url))
const ROOT_TAG = `<div id="root" class="flex flex-col h-dvh p-px"></div>`
const STYLESHEET_TAG = /<link rel="stylesheet"[^>]*>\s*/g

function scriptSource(script: string): string {
  return `'sha256-${createHash("sha256").update(script).digest("base64")}'`
}

/** The app reaches the control plane and the relay on its own origin, so the policy names no other server. */
export function webContentSecurityPolicy(inlineScripts: readonly string[]): string {
  return contentSecurityPolicy({
    servers: [],
    scripts: [FRAME_BOOTSTRAP, ...inlineScripts].map(scriptSource),
    frames: "self",
  })
}

export async function themePreloadScript(): Promise<string> {
  const source = await readFile(THEME_PRELOAD_FILE, "utf8")
  const { code } = await transformWithEsbuild(source, THEME_PRELOAD_FILE, { minify: true })
  return code.trimEnd()
}

export async function startupFrameStyle(): Promise<string> {
  const source = await readFile(STARTUP_FRAME_FILE, "utf8")
  const { code } = await transformWithEsbuild(source, STARTUP_FRAME_FILE, { loader: "css", minify: true })
  return code.trimEnd()
}

function documentTags(policy: string): HtmlTagDescriptor[] {
  return [
    { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: policy }, injectTo: "head-prepend" },
    { tag: "meta", attrs: { "http-equiv": "x-dns-prefetch-control", content: "off" }, injectTo: "head-prepend" },
  ]
}

export async function webAppDocument(html: string, document: "index.html" | "login.html"): Promise<IndexHtmlTransformResult> {
  if (!html.includes(THEME_PRELOAD_TAG)) throw new Error(`the document no longer loads the theme preload as ${THEME_PRELOAD_TAG}`)
  const theme = await themePreloadScript()
  const frame: HtmlTagDescriptor[] = document === "index.html" ? [{ tag: "style", attrs: { id: "claxedo-startup-frame" }, children: await startupFrameStyle(), injectTo: "head" }] : []
  return {
    html: html.replace(THEME_PRELOAD_TAG, () => `<script>${theme}</script>`),
    tags: [...documentTags(webContentSecurityPolicy([theme])), ...frame],
  }
}

export function stylesheetsAfterRoot(html: string): string {
  if (!html.includes(ROOT_TAG)) throw new Error(`the document no longer holds its root as ${ROOT_TAG}`)
  const stylesheets = (html.match(STYLESHEET_TAG) ?? []).map((tag) => tag.trim())
  if (stylesheets.length === 0) throw new Error("the document links no stylesheet to follow its root")
  return html
    .replace(STYLESHEET_TAG, (tag) => `${tag.trim().replace('rel="stylesheet"', 'rel="preload" as="style"')}\n    `)
    .replace(ROOT_TAG, () => `${ROOT_TAG}\n    ${stylesheets.join("\n    ")}`)
}

export function webDocumentPlugins(): Plugin[] {
  return [
    {
      name: WEB_DOCUMENT_PLUGINS[0],
      apply: "build",
      transformIndexHtml: {
        order: "pre",
        handler: (html, context) => {
          const document = path.basename(context.filename)
          if (document === "index.html" || document === "login.html") return webAppDocument(html, document)
          if (document === "browser-preview.html") return documentTags(browserPreviewPolicy())
          throw new Error(`${context.filename} has no Content-Security-Policy; name one in vite.web-document.ts`)
        },
      },
    },
    {
      name: WEB_DOCUMENT_PLUGINS[1],
      apply: "build",
      transformIndexHtml: {
        order: "post",
        handler: (html, context) => (path.basename(context.filename) === "index.html" ? stylesheetsAfterRoot(html) : html),
      },
    },
  ]
}
