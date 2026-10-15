/**
 * What a model vendor's response body is.
 *
 * Only a JSON document is the vendor API's own answer. An HTML document is the
 * edge in front of the API refusing the client: chatgpt.com answers requests
 * from Cloudflare Worker egress with Cloudflare's challenge page (403,
 * text/html, "Please try again later", observed 2026-10-15), and that page says
 * nothing about the credential, the model or the account's limits. Anything
 * else is prose a gateway, SDK or harness wrote.
 */
export type VendorBody =
  | { kind: "api"; document: Record<string, unknown> }
  | { kind: "page" }
  | { kind: "text" }

/** pi-ai writes a body it could not parse as `<status>: <body>` when the SDK error carries both. */
const HTML_DOCUMENT = /^\s*(?:\d{3}:?\s+)?(?:<!doctype\s+html|<html[\s>])/i

export function vendorBody(text: string): VendorBody {
  const document = parseDocument(text)
  if (document) return { kind: "api", document }
  return HTML_DOCUMENT.test(text) ? { kind: "page" } : { kind: "text" }
}

function parseDocument(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return isDocument(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * The turn error a harness reports in place of an edge's page. The page itself
 * never reaches a transcript: it is kilobytes of markup, and its "try again
 * later" reads as a rate limit it is not.
 */
export const EDGE_REFUSED_MESSAGE =
  "The model provider refused the connection from this host and answered with a block page instead of its API; the account itself was not refused"

function isDocument(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
