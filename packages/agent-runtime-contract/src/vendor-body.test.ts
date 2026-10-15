import { describe, expect, test } from "bun:test"
import { vendorBody, vendorHttpStatus } from "./vendor-body"

/** What chatgpt.com answered a Cloudflare Worker's request on 2026-10-15 (Ray a4abfe3368bcce65), trimmed. */
const CHALLENGE_PAGE = `<!DOCTYPE html>
<html lang="en-US">
<head><title>Unable to load site</title></head>
<body><h1>Unable to load site</h1><p>Please try again later. If you are using a VPN, try turning it off.</p>
<p>[IP:2a06:98c0:3600::103 | Ray ID:a4abfe3368bcce65]</p></body></html>`

describe("vendor body", () => {
  test("a JSON document is the vendor API's own answer", () => {
    expect(vendorBody('{"error":{"type":"rate_limit_error","message":"slow down"}}'))
      .toEqual({ kind: "api", document: { error: { type: "rate_limit_error", message: "slow down" } } })
  })

  test.each([CHALLENGE_PAGE, "<html><body>bad gateway</body></html>", "  <!doctype HTML><p>blocked</p>", `403: ${CHALLENGE_PAGE}`])(
    "an HTML document is the edge's page, not an answer: %s",
    (text) => {
      expect(vendorBody(text)).toEqual({ kind: "page" })
    },
  )

  test.each(["fetch failed", "Too Many Requests", "[]", "null", '"quoted"', "<b>not a document</b>", "the reply mentioned <html> mid-sentence"])(
    "anything else is prose: %s",
    (text) => {
      expect(vendorBody(text)).toEqual({ kind: "text" })
    },
  )
})

test("the vendor's HTTP status is read from pi-ai's error or a leading status, and from nowhere else", () => {
  expect(vendorHttpStatus("OpenAI API error (401): {\"type\":\"invalid_request_error\"}")).toBe(401)
  expect(vendorHttpStatus("Anthropic API error (403): {\"type\":\"error\"}")).toBe(403)
  expect(vendorHttpStatus("401 Incorrect API key provided")).toBe(401)
  expect(vendorHttpStatus("401: unauthorized")).toBe(401)
  expect(vendorHttpStatus("Your API key was revoked after 401 attempts")).toBeUndefined()
  expect(vendorHttpStatus("billing problem with this key")).toBeUndefined()
})
