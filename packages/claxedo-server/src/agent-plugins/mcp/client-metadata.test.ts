import { describe, expect, test } from "vitest"
import { hostedMcpClientMetadata } from "./client-metadata"

describe("hosted MCP Client ID Metadata", () => {
  test("uses its exact HTTPS document URL as client_id and freezes the hosted callback", () => {
    const value = hostedMcpClientMetadata("https://control.example.com")

    expect(value.clientId).toBe(
      "https://control.example.com/api/claxedo/plugins/oauth/client-metadata.json",
    )
    expect(value.document).toEqual({
      client_id: value.clientId,
      client_name: "Claxedo",
      client_uri: "https://control.example.com/",
      redirect_uris: ["https://control.example.com/api/claxedo/integrations/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    })
  })

  test.each([
    "http://control.example.com",
    "https://user:password@control.example.com",
    "https://control.example.com/base",
    "https://control.example.com?redirect=evil",
    "https://control.example.com#fragment",
  ])("rejects a non-public control-plane URL: %s", (url) => {
    expect(() => hostedMcpClientMetadata(url)).toThrow(/public HTTPS origin/)
  })
})
