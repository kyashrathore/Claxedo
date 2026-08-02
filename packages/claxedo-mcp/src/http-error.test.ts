import { describe, expect, it } from "vitest"
import { McpHttpError, mcpHttpError } from "./http-error"

describe("MCP HTTP errors", () => {
  it("preserves a structured server status and code", () => {
    const error = mcpHttpError(404, {
      error: { code: "not_found", message: "Stream not found", retryable: false },
    })

    expect(error).toBeInstanceOf(McpHttpError)
    expect(error).toMatchObject({ status: 404, code: "not_found", message: "Stream not found", retryable: false })
  })

  it("redacts an unstructured HTTP failure without inventing a code", () => {
    expect(mcpHttpError(502, undefined)).toMatchObject({
      status: 502,
      code: undefined,
      message: "HTTP 502",
    })
  })
})
