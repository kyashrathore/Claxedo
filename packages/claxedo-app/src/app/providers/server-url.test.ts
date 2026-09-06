import { describe, expect, test } from "bun:test"
import { normalizeServerUrl } from "@/app/connection/server"

describe("normalizeServerUrl", () => {
  test("rewrites local web dev frontend ports to the backend", () => {
    expect(normalizeServerUrl("http://localhost:4444")).toBe("http://localhost:2593")
    expect(normalizeServerUrl("127.0.0.1:3000")).toBe("http://127.0.0.1:2593")
  })

  test("leaves non-dev hosts and ports alone", () => {
    expect(normalizeServerUrl("http://localhost:3001")).toBe("http://localhost:3001")
    expect(normalizeServerUrl("https://example.com:4444/")).toBe("https://example.com:4444")
  })
})
