import { MCP_APP_MAX_BYTES } from "@claxedo/agent-runtime-contract"
import { MCP_APP_BOOTSTRAP, MCP_APP_DOCUMENT_MESSAGE } from "./bootstrap"

const BASE64_DATA_URL = /^data:([^,]*);base64,/i

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")
}

export function appFrameDocument(policy: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}">`
  return `<!doctype html><html><head><meta charset="utf-8">${meta}<script>${MCP_APP_BOOTSTRAP}</script></head><body></body></html>`
}

export function documentMessage(html: string): { readonly type: typeof MCP_APP_DOCUMENT_MESSAGE; readonly html: string } {
  return { type: MCP_APP_DOCUMENT_MESSAGE, html }
}

export function decodeDocumentDataUrl(url: string): string | undefined {
  const header = BASE64_DATA_URL.exec(url)
  if (!header) return undefined
  const encoded = url.slice(header[0].length)
  if (Math.floor((encoded.length * 3) / 4) > MCP_APP_MAX_BYTES + 2) return undefined
  try {
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))
    if (bytes.length > MCP_APP_MAX_BYTES) return undefined
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch (error) {
    console.warn("mcp-apps: the app document is not valid base64 UTF-8", { error })
    return undefined
  }
}
