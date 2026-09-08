import { describe, expect, test } from "bun:test"
import { acpFirstPartyMcpServer, FIRST_PARTY_MCP_CONFIG_KEY, firstPartyMcpProvider } from "./first-party-mcp"

describe("first-party MCP provider contract", () => {
  test("reads a provider off the config record and hands back the entry for a session", () => {
    const provider = firstPartyMcpProvider({
      mcp: {},
      [FIRST_PARTY_MCP_CONFIG_KEY]: {
        server: (sessionId: string) => ({
          name: "claxedo",
          url: `http://127.0.0.1:2593/api/claxedo/mcp?session=${sessionId}`,
          headers: { Authorization: "Bearer token" },
        }),
      },
    })
    expect(provider?.server("s-1")).toEqual({
      name: "claxedo",
      url: "http://127.0.0.1:2593/api/claxedo/mcp?session=s-1",
      headers: { Authorization: "Bearer token" },
    })
  })

  test("is absent when the config carries no provider or a non-callable one", () => {
    expect(firstPartyMcpProvider({ mcp: {} })).toBeUndefined()
    expect(firstPartyMcpProvider({ [FIRST_PARTY_MCP_CONFIG_KEY]: { server: "nope" } })).toBeUndefined()
    expect(firstPartyMcpProvider({ [FIRST_PARTY_MCP_CONFIG_KEY]: null })).toBeUndefined()
  })

  test("refuses a malformed entry instead of launching a harness with it", () => {
    const provider = firstPartyMcpProvider({
      [FIRST_PARTY_MCP_CONFIG_KEY]: { server: () => ({ name: "claxedo", url: "", headers: {} }) },
    })
    expect(() => provider?.server("s-1")).toThrow("invalid server entry")
    const numericHeader = firstPartyMcpProvider({
      [FIRST_PARTY_MCP_CONFIG_KEY]: { server: () => ({ name: "claxedo", url: "http://x", headers: { a: 1 } }) },
    })
    expect(() => numericHeader?.server("s-1")).toThrow("invalid server entry")
  })

  test("projects the entry into the ACP session/new server shape", () => {
    expect(acpFirstPartyMcpServer({
      name: "claxedo",
      url: "http://127.0.0.1:2593/api/claxedo/mcp?session=s-1",
      headers: { Authorization: "Bearer token" },
    })).toEqual({
      type: "http",
      name: "claxedo",
      url: "http://127.0.0.1:2593/api/claxedo/mcp?session=s-1",
      headers: [{ name: "Authorization", value: "Bearer token" }],
    })
  })
})
