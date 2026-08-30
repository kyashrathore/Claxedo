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

describe("source ownership", () => {
  test("keeps context server health freshness state in the query client", async () => {
    const source = await Bun.file(new URL("../connection/server.tsx", import.meta.url)).text()

    expect(await Bun.file(new URL("../../overrides/context/server.tsx", import.meta.url)).exists()).toBe(false)
    expect(source).not.toContain("healthCache = new Map")
    expect(source).not.toContain("const healthCache")
    expect(source).not.toContain("setInterval(")
    expect(source).toContain("serverHealthQueryKey")
    expect(source).not.toContain("createOpencodeClient")
  })
})
