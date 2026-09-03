import { describe, expect, test } from "bun:test"

import {
  assertCredentialBinding,
  authorizationUri,
  betterAuthDeviceEndpoint,
  betterAuthTokenEndpoint,
  credentialBinding,
  NativeAuthDescriptorError,
  parseCliAuthDescriptor,
} from "../../src/account/native-auth"

function descriptor() {
  return {
    adapter: "better-auth",
    deploymentId: "deployment-1",
    configurationVersion: "auth-v1",
    expiresAt: 4_102_444_800_000,
    issuer: "https://core.example.com/api/auth",
    methods: ["google"],
    browser: {
      trustedOrigins: ["https://app.example.com"],
    },
    native: {
      cli: {
        flow: "device-authorization",
        clientId: "claxedo-cli",
        resource: "https://core.example.com/control-plane",
        scopes: ["offline_access", "workspace:read", "workspace:write"],
        tokenEndpointOrigin: "https://core.example.com",
        controlPlaneOrigin: "https://core.example.com",
        revocation: {
          protocol: "rfc7009",
          endpoint: "https://core.example.com/api/auth/oauth2/revoke",
          tokenEndpointAuthMethod: "none",
        },
      },
    },
  }
}

describe("CLI authentication descriptor", () => {
  test("binds Better Auth device endpoints and credentials to the configured deployment", () => {
    const parsed = parseCliAuthDescriptor(descriptor(), "https://core.example.com", 1_800_000_000_000)
    expect(betterAuthDeviceEndpoint(parsed)).toBe("https://core.example.com/api/auth/device/code")
    expect(betterAuthTokenEndpoint(parsed)).toBe("https://core.example.com/api/auth/oauth2/token")
    expect(parsed.revocation).toEqual({
      protocol: "rfc7009",
      endpoint: "https://core.example.com/api/auth/oauth2/revoke",
      tokenEndpointAuthMethod: "none",
    })
    expect(authorizationUri("https://app.example.com/device?user_code=ABCD", parsed)).toBe(
      "https://app.example.com/device?user_code=ABCD",
    )
    expect(assertCredentialBinding(credentialBinding(parsed), parsed)).toEqual(credentialBinding(parsed))
  })

  for (const [name, mutate, code] of [
    [
      "another control plane",
      (value: ReturnType<typeof descriptor>) => {
        value.native.cli.controlPlaneOrigin = "https://other.example.com"
      },
      "deployment_mismatch",
    ],
    [
      "another resource",
      (value: ReturnType<typeof descriptor>) => {
        value.native.cli.resource = "https://other.example.com/control-plane"
      },
      "deployment_mismatch",
    ],
    [
      "another token origin",
      (value: ReturnType<typeof descriptor>) => {
        value.native.cli.tokenEndpointOrigin = "https://tokens.example.com"
      },
      "deployment_mismatch",
    ],
    [
      "an expired descriptor",
      (value: ReturnType<typeof descriptor>) => {
        value.expiresAt = 1
      },
      "expired_descriptor",
    ],
    [
      "duplicate scopes",
      (value: ReturnType<typeof descriptor>) => {
        value.native.cli.scopes = ["workspace:read", "workspace:read"]
      },
      "invalid_descriptor",
    ],
    [
      "a revocation endpoint on another origin",
      (value: ReturnType<typeof descriptor>) => {
        value.native.cli.revocation.endpoint = "https://other.example.com/api/auth/oauth2/revoke"
      },
      "deployment_mismatch",
    ],
    [
      "a non-canonical Better Auth revocation path",
      (value: ReturnType<typeof descriptor>) => {
        value.native.cli.revocation.endpoint = "https://core.example.com/other/revoke"
      },
      "invalid_descriptor",
    ],
    [
      "a confidential native revocation client",
      (value: ReturnType<typeof descriptor>) => {
        value.native.cli.revocation.tokenEndpointAuthMethod = "client_secret_post"
      },
      "invalid_descriptor",
    ],
  ] as const) {
    test(`rejects ${name}`, () => {
      const value = descriptor()
      mutate(value)
      try {
        parseCliAuthDescriptor(value, "https://core.example.com", 1_800_000_000_000)
        throw new Error("expected descriptor rejection")
      } catch (error) {
        expect(error).toBeInstanceOf(NativeAuthDescriptorError)
        expect((error as NativeAuthDescriptorError).code).toBe(code)
      }
    })
  }

  test("rejects authorization pages outside the descriptor's trusted app origins", () => {
    const parsed = parseCliAuthDescriptor(descriptor(), "https://core.example.com", 1_800_000_000_000)
    expect(() => authorizationUri("https://lookalike.example.com/device?user_code=ABCD", parsed)).toThrow(
      /untrusted browser origin/,
    )
  })

  test("rejects a stored credential when any immutable binding field changes", () => {
    const first = parseCliAuthDescriptor(descriptor(), "https://core.example.com", 1_800_000_000_000)
    const nextValue = descriptor()
    nextValue.deploymentId = "deployment-2"
    const next = parseCliAuthDescriptor(nextValue, "https://core.example.com", 1_800_000_000_000)
    expect(() => assertCredentialBinding(credentialBinding(first), next)).toThrow(
      /currently selected authentication deployment/,
    )
  })
})
