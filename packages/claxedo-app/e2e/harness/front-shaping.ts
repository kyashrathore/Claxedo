import { createHash } from "node:crypto"
import fs from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import path from "node:path"

export type EncodedAsset = { readonly br?: Buffer; readonly gzip?: Buffer }

/**
 * What the e2e front adds on top of serving `dist` as-is, so a measurement
 * sees the shape Cloudflare Pages and the control-plane Worker give the app:
 * `apiDelayMs` is read per request and added before a control-plane answer
 * is relayed (one extra round trip), `encoded` supplies the pre-compressed
 * bodies the front may send for an asset.
 */
export type FrontShaping = {
  readonly apiDelayMs: () => number
  readonly encoded: (pathname: string) => EncodedAsset | undefined
}

export type PagesAnswer = { readonly cacheControl: string; readonly compress: boolean }

const DEFAULT_CACHE_CONTROL = "public, max-age=0, must-revalidate"

function patternToRegExp(pattern: string) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/:[A-Za-z_]+/g, "[^/]+")
  return new RegExp(`^${escaped}$`)
}

/**
 * The dist's `public/_headers` as Cloudflare Pages reads it: every matching
 * block in file order adds its Cache-Control, a repeated header joins with a
 * comma, `! Cache-Control` detaches what earlier blocks set. Pages leaves a
 * `no-transform` response uncompressed; without the file every path gets the
 * publisher's default revalidation and is compressed.
 */
export function pagesHeaders(distDir: string): (pathname: string) => PagesAnswer {
  const file = path.join(distDir, "_headers")
  const blocks: { readonly match: RegExp; detach: boolean; readonly values: string[] }[] = []
  if (fs.existsSync(file)) {
    for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
      const line = raw.replace(/#.*$/, "").trimEnd()
      if (!line.trim()) continue
      if (!/^\s/.test(line)) {
        blocks.push({ match: patternToRegExp(line.trim()), detach: false, values: [] })
        continue
      }
      const current = blocks.at(-1)
      if (!current) continue
      const header = line.trim()
      if (/^!\s*cache-control$/i.test(header)) current.detach = true
      const value = /^cache-control:\s*(.+)$/i.exec(header)?.[1]
      if (value) current.values.push(value)
    }
  }
  return (pathname) => {
    let cacheControl: string | undefined
    for (const block of blocks) {
      if (!block.match.test(pathname)) continue
      if (block.detach) cacheControl = undefined
      for (const value of block.values) cacheControl = cacheControl ? `${cacheControl}, ${value}` : value
    }
    const value = cacheControl ?? DEFAULT_CACHE_CONTROL
    return { cacheControl: value, compress: !/\bno-transform\b/.test(value) }
  }
}

function acceptedEncoding(request: IncomingMessage, encoded: EncodedAsset | undefined): { encoding: "br" | "gzip"; body: Buffer } | undefined {
  const accepted = (request.headers["accept-encoding"] ?? "").split(",").map((token) => token.trim().split(";")[0])
  if (encoded?.br && accepted.includes("br")) return { encoding: "br", body: encoded.br }
  if (encoded?.gzip && accepted.includes("gzip")) return { encoding: "gzip", body: encoded.gzip }
  return undefined
}

export async function respondShaped(request: IncomingMessage, response: ServerResponse, pathname: string, asset: Response, answer: PagesAnswer, shaping: FrontShaping) {
  const identity = Buffer.from(await asset.arrayBuffer())
  const etag = `"${createHash("sha1").update(identity).digest("base64url")}"`
  const headers: Record<string, string> = {
    "content-type": asset.headers.get("content-type") ?? "application/octet-stream",
    "cache-control": answer.cacheControl,
    etag,
    vary: "accept-encoding",
  }
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, headers).end()
    return
  }
  const chosen = answer.compress ? acceptedEncoding(request, shaping.encoded(pathname)) : undefined
  if (chosen) headers["content-encoding"] = chosen.encoding
  const body = chosen?.body ?? identity
  headers["content-length"] = String(body.byteLength)
  response.writeHead(asset.status, headers).end(body)
}
