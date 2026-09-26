import { describe, expect, test } from "vitest"
import { mcpOAuthClientsFromEnv } from "./hosted-composition"

describe("pre-registered MCP OAuth clients", () => {
  test("keys each client by the issuer exactly as the operator wrote it", () => {
    const clients = mcpOAuthClientsFromEnv(JSON.stringify({
      "https://auth.example.test": { clientId: "origin-form" },
      "https://backend.example.test/oauth/": { clientId: "path-form", clientSecret: "s" },
    }))
    expect(clients).toEqual({
      "https://auth.example.test": { clientId: "origin-form" },
      "https://backend.example.test/oauth/": { clientId: "path-form", clientSecret: "s" },
    })
  })

  test("refuses an issuer that is not a URL and a client without an id", () => {
    expect(() => mcpOAuthClientsFromEnv(JSON.stringify({ "not a url": { clientId: "x" } }))).toThrow()
    expect(() => mcpOAuthClientsFromEnv(JSON.stringify({ "https://auth.example.test": {} }))).toThrow("has no clientId")
    expect(mcpOAuthClientsFromEnv(undefined)).toBeUndefined()
  })
})
