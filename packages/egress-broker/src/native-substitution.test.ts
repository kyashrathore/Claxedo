import { describe, expect, test } from "vitest"
import { brokeredSecretFromRegistration, substituteNativeSecrets } from "./native-substitution.js"

const gateway = brokeredSecretFromRegistration({
  name: "CLAXEDO_MCP_ABC",
  header: "Authorization",
  value: "Bearer gateway-token",
  hosts: ["gateway.example"],
  methods: ["GET", "POST", "DELETE"],
  pathPrefixes: ["/api/claxedo/plugins/mcp/i1"],
})
const provider = brokeredSecretFromRegistration({
  name: "CLAXEDO_PROVIDER_OPENAI",
  header: "Authorization",
  value: "Bearer sk-real",
  hosts: ["api.openai.com"],
  methods: ["POST"],
  pathPrefixes: ["/v1"],
})
const apiKey = brokeredSecretFromRegistration({ name: "CLAXEDO_PROVIDER_ANTHROPIC", header: "x-api-key", value: "Bearer-looking value", hosts: ["api.anthropic.com"] })

describe("registration to brokered secret", () => {
  test("splits an Authorization value into scheme and credential, and keeps every other header whole", () => {
    expect(gateway).toEqual({
      name: "CLAXEDO_MCP_ABC", header: "Authorization", scheme: "Bearer", value: "gateway-token",
      hosts: ["gateway.example"], methods: ["GET", "POST", "DELETE"], pathPrefixes: ["/api/claxedo/plugins/mcp/i1"],
    })
    expect(apiKey).toEqual({ name: "CLAXEDO_PROVIDER_ANTHROPIC", header: "x-api-key", value: "Bearer-looking value", hosts: ["api.anthropic.com"] })
  })

  test("a raw placeholder takes the whole registered value", () => {
    const headers = substituteNativeSecrets(new URL("https://gateway.example/api/claxedo/plugins/mcp/i1"), "POST",
      new Headers({ authorization: "claxedo-broker:CLAXEDO_MCP_ABC" }), [gateway, provider])
    expect(headers.get("authorization")).toBe("Bearer gateway-token")
  })

  test("a scheme-prefixed placeholder composes the scheme once", () => {
    const headers = substituteNativeSecrets(new URL("https://api.openai.com/v1/responses"), "POST",
      new Headers({ authorization: "Bearer claxedo-broker:CLAXEDO_PROVIDER_OPENAI" }), [gateway, provider])
    expect(headers.get("authorization")).toBe("Bearer sk-real")
  })

  test("a header without a scheme is written whole either way", () => {
    const headers = substituteNativeSecrets(new URL("https://api.anthropic.com/v1/messages"), "POST",
      new Headers({ "x-api-key": "claxedo-broker:CLAXEDO_PROVIDER_ANTHROPIC" }), [apiKey])
    expect(headers.get("x-api-key")).toBe("Bearer-looking value")
  })

  test("a placeholder outside the registration's policy, or for a withdrawn secret, is refused", () => {
    expect(() => substituteNativeSecrets(new URL("https://gateway.example/other"), "POST",
      new Headers({ authorization: "claxedo-broker:CLAXEDO_MCP_ABC" }), [gateway])).toThrow("brokered_secret_destination_refused")
    expect(() => substituteNativeSecrets(new URL("https://gateway.example/api/claxedo/plugins/mcp/i1"), "PUT",
      new Headers({ authorization: "claxedo-broker:CLAXEDO_MCP_ABC" }), [gateway])).toThrow("brokered_secret_destination_refused")
    expect(() => substituteNativeSecrets(new URL("https://gateway.example/api/claxedo/plugins/mcp/i1"), "POST",
      new Headers({ authorization: "claxedo-broker:CLAXEDO_MCP_ABC" }), [provider])).toThrow("brokered_secret_withdrawn")
  })
})
