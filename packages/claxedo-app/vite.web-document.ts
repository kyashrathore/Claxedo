import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { transformWithEsbuild, type HtmlTagDescriptor, type IndexHtmlTransformResult, type Plugin } from "vite"
import { browserPreviewPolicy, contentSecurityPolicy, policyOrigin } from "./content-security-policy"
import { FRAME_BOOTSTRAP } from "./src/plugins/frame/document"

export const WEB_DOCUMENT_PLUGIN = "claxedo:web-document"

const THEME_PRELOAD_FILE = fileURLToPath(new URL("./public/oc-theme-preload.js", import.meta.url))
const THEME_PRELOAD_TAG = `<script id="oc-theme-preload-script" src="/oc-theme-preload.js"></script>`

function relayOrigins(): string[] {
  return (process.env.CLAXEDO_RELAY_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean)
}

function scriptSource(script: string): string {
  return `'sha256-${createHash("sha256").update(script).digest("base64")}'`
}

export function webContentSecurityPolicy(serverUrl: string | undefined, inlineScripts: readonly string[]): string {
  const server = serverUrl?.trim() || undefined
  return contentSecurityPolicy({
    servers: [...(server ? [server] : []), ...relayOrigins()],
    scripts: [FRAME_BOOTSTRAP, ...inlineScripts].map(scriptSource),
    frames: "self",
  })
}

export async function themePreloadScript(): Promise<string> {
  const source = await readFile(THEME_PRELOAD_FILE, "utf8")
  const { code } = await transformWithEsbuild(source, THEME_PRELOAD_FILE, { minify: true })
  return code.trimEnd()
}

function serverConnection(serverUrl: string | undefined): HtmlTagDescriptor[] {
  const server = serverUrl?.trim()
  if (!server) return []
  return [{ tag: "link", attrs: { rel: "preconnect", href: policyOrigin(server), crossorigin: "use-credentials" }, injectTo: "head-prepend" }]
}

function documentTags(policy: string): HtmlTagDescriptor[] {
  return [
    { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: policy }, injectTo: "head-prepend" },
    { tag: "meta", attrs: { "http-equiv": "x-dns-prefetch-control", content: "off" }, injectTo: "head-prepend" },
  ]
}

export async function webAppDocument(html: string, serverUrl: string | undefined): Promise<IndexHtmlTransformResult> {
  if (!html.includes(THEME_PRELOAD_TAG)) throw new Error(`index.html no longer loads the theme preload as ${THEME_PRELOAD_TAG}`)
  const theme = await themePreloadScript()
  return {
    html: html.replace(THEME_PRELOAD_TAG, () => `<script>${theme}</script>`),
    tags: [...documentTags(webContentSecurityPolicy(serverUrl, [theme])), ...serverConnection(serverUrl)],
  }
}

export function webDocumentPlugin(serverUrl: string | undefined): Plugin {
  return {
    name: WEB_DOCUMENT_PLUGIN,
    apply: "build",
    transformIndexHtml: {
      order: "pre",
      handler: (html, context) => {
        const document = path.basename(context.filename)
        if (document === "index.html") return webAppDocument(html, serverUrl)
        if (document === "browser-preview.html") return documentTags(browserPreviewPolicy())
        throw new Error(`${context.filename} has no Content-Security-Policy; name one in vite.web-document.ts`)
      },
    },
  }
}
