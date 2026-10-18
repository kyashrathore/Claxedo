import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { transformWithEsbuild, type HtmlTagDescriptor, type IndexHtmlTransformResult, type Plugin } from "vite"
import { browserPreviewPolicy, contentSecurityPolicy } from "./content-security-policy"
import { FRAME_BOOTSTRAP } from "./src/plugins/frame/document"

export const WEB_DOCUMENT_PLUGIN = "claxedo:web-document"

const THEME_PRELOAD_FILE = fileURLToPath(new URL("./public/oc-theme-preload.js", import.meta.url))
const THEME_PRELOAD_TAG = `<script id="oc-theme-preload-script" src="/oc-theme-preload.js"></script>`

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

function documentTags(policy: string): HtmlTagDescriptor[] {
  return [
    { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: policy }, injectTo: "head-prepend" },
    { tag: "meta", attrs: { "http-equiv": "x-dns-prefetch-control", content: "off" }, injectTo: "head-prepend" },
  ]
}

export async function webAppDocument(html: string): Promise<IndexHtmlTransformResult> {
  if (!html.includes(THEME_PRELOAD_TAG)) throw new Error(`index.html no longer loads the theme preload as ${THEME_PRELOAD_TAG}`)
  const theme = await themePreloadScript()
  return {
    html: html.replace(THEME_PRELOAD_TAG, () => `<script>${theme}</script>`),
    tags: documentTags(webContentSecurityPolicy([theme])),
  }
}

export function webDocumentPlugin(): Plugin {
  return {
    name: WEB_DOCUMENT_PLUGIN,
    apply: "build",
    transformIndexHtml: {
      order: "pre",
      handler: (html, context) => {
        const document = path.basename(context.filename)
        if (document === "index.html") return webAppDocument(html)
        if (document === "browser-preview.html") return documentTags(browserPreviewPolicy())
        throw new Error(`${context.filename} has no Content-Security-Policy; name one in vite.web-document.ts`)
      },
    },
  }
}
