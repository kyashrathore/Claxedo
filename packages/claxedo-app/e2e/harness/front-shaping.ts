import { createHash } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"

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

/** Cloudflare Pages' answer for the app's `public/_headers`: hashed assets immutable, everything else revalidated. */
export function pagesCacheControl(pathname: string) {
  return pathname.startsWith("/assets/") ? "no-transform, public, max-age=31536000, immutable" : "no-transform, public, max-age=0, must-revalidate"
}

function acceptedEncoding(request: IncomingMessage, encoded: EncodedAsset | undefined): { encoding: "br" | "gzip"; body: Buffer } | undefined {
  const accepted = (request.headers["accept-encoding"] ?? "").split(",").map((token) => token.trim().split(";")[0])
  if (encoded?.br && accepted.includes("br")) return { encoding: "br", body: encoded.br }
  if (encoded?.gzip && accepted.includes("gzip")) return { encoding: "gzip", body: encoded.gzip }
  return undefined
}

export async function respondShaped(request: IncomingMessage, response: ServerResponse, pathname: string, asset: Response, shaping: FrontShaping) {
  const identity = Buffer.from(await asset.arrayBuffer())
  const etag = `"${createHash("sha1").update(identity).digest("base64url")}"`
  const headers: Record<string, string> = {
    "content-type": asset.headers.get("content-type") ?? "application/octet-stream",
    "cache-control": pagesCacheControl(pathname),
    etag,
    vary: "accept-encoding",
  }
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, headers).end()
    return
  }
  const chosen = acceptedEncoding(request, shaping.encoded(pathname))
  if (chosen) headers["content-encoding"] = chosen.encoding
  const body = chosen?.body ?? identity
  headers["content-length"] = String(body.byteLength)
  response.writeHead(asset.status, headers).end(body)
}
