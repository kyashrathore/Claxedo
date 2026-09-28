import { expect, test } from "bun:test"
import { resolveUserMcp, resolvedMcpServers } from "./resolver"

test("MCP exports only the live user resolver and decoder", async () => {
  expect(Object.keys(await import("./resolver")).sort()).toEqual(["resolveUserMcp", "resolvedMcpServers"])
})

test("resolves configured user servers and omits disabled entries", () => {
  const resolved = resolveUserMcp({
    remote: { type: "remote", url: "https://mcp.example.com", headers: { Authorization: "Bearer test" } },
    process: { type: "stdio", command: "server", args: ["argument"], env: { VALUE: "test" } },
    disabled: { type: "remote", url: "https://disabled.example.com", disabled: true },
  })
  expect(resolved.remote).toMatchObject({ source: "user", transport: "remote", url: "https://mcp.example.com" })
  expect(resolved.process).toMatchObject({ source: "user", transport: "stdio", command: "server", args: ["argument"], env: { VALUE: "test" } })
  expect(resolved.disabled).toBeUndefined()
  expect(resolvedMcpServers(resolved)).toEqual(resolved)
  expect(resolvedMcpServers(null)).toBeUndefined()
  expect(resolvedMcpServers({ malformed: { name: "malformed", transport: "stdio" } })).toEqual({})
})
