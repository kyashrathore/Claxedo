import { describe, expect, test } from "bun:test"

import {
  assertDesktopCredentialBinding,
  DesktopAuthDescriptorError,
  parseBoundDesktopCredential,
  parseDesktopAuthDescriptor,
  type DesktopCredentialBinding,
} from "./auth-descriptor"

const NOW = 1_800_000_000_000
const CORE = "https://core.example.com"

function betterAuthDescriptor() {
  const native = {
    flow: "authorization-code-pkce",
    clientId: "claxedo-desktop",
    resource: `${CORE}/control-plane`,
    scopes: ["offline_access", "workspace:read", "workspace:write"],
    tokenEndpointOrigin: CORE,
    controlPlaneOrigin: CORE,
    revocation: {
      protocol: "rfc7009",
      endpoint: `${CORE}/api/auth/oauth2/revoke`,
      tokenEndpointAuthMethod: "none",
    },
  }
  return {
    adapter: "better-auth",
    deploymentId: "deployment-1",
    configurationVersion: "auth-v1",
    expiresAt: NOW + 60_000,
    issuer: `${CORE}/api/auth`,
    methods: ["github"],
    browser: { trustedOrigins: ["https://app.example.com"] },
    native: { cli: {}, desktop: native },
  }
}

function clerkDescriptor() {
  return {
    ...betterAuthDescriptor(),
    adapter: "clerk",
    issuer: "https://clerk.example.com",
    native: {
      cli: {},
      desktop: {
        ...betterAuthDescriptor().native.desktop,
        flow: "adapter-native",
        tokenEndpointOrigin: "https://clerk.example.com",
        revocation: {
          protocol: "adapter-native",
          endpoint: "https://clerk.example.com/native/revoke",
        },
      },
    },
  }
}

describe("desktop authentication descriptor", () => {
  test("derives only the Better Auth OAuth Provider endpoints from the selected core", () => {
    const parsed = parseDesktopAuthDescriptor(betterAuthDescriptor(), CORE, NOW)

    expect(parsed).toMatchObject({
      adapter: "better-auth",
      authorizeUrl: `${CORE}/api/auth/oauth2/authorize`,
      tokenUrl: `${CORE}/api/auth/oauth2/token`,
      binding: {
        adapter: "better-auth",
        deploymentId: "deployment-1",
        configurationVersion: "auth-v1",
        issuer: `${CORE}/api/auth`,
        tokenEndpointOrigin: CORE,
        controlPlaneOrigin: CORE,
        id: "claxedo-desktop",
        resource: `${CORE}/control-plane`,
        scopes: ["offline_access", "workspace:read", "workspace:write"],
        tokenKind: "access-token",
      },
    })
  })

  test("selects Clerk's adapter-native endpoints without a Better Auth fallback", () => {
    const parsed = parseDesktopAuthDescriptor(clerkDescriptor(), CORE, NOW)

    expect(parsed).toMatchObject({
      adapter: "clerk",
      authorizeUrl: "https://clerk.example.com/oauth/authorize",
      tokenUrl: "https://clerk.example.com/oauth/token",
      revocation: { protocol: "adapter-native" },
      binding: { adapter: "clerk", flow: "adapter-native" },
    })
  })

  for (const [name, mutate, code, configuredOrigin] of [
    [
      "non-HTTPS configured origin",
      (value: ReturnType<typeof betterAuthDescriptor>) => value,
      "invalid_descriptor",
      "http://core.example.com",
    ],
    [
      "different control plane",
      (value: ReturnType<typeof betterAuthDescriptor>) => {
        value.native.desktop.controlPlaneOrigin = "https://other.example.com"
        return value
      },
      "deployment_mismatch",
      CORE,
    ],
    [
      "different token origin",
      (value: ReturnType<typeof betterAuthDescriptor>) => {
        value.native.desktop.tokenEndpointOrigin = "https://tokens.example.com"
        return value
      },
      "deployment_mismatch",
      CORE,
    ],
    [
      "different resource origin",
      (value: ReturnType<typeof betterAuthDescriptor>) => {
        value.native.desktop.resource = "https://other.example.com/control-plane"
        return value
      },
      "deployment_mismatch",
      CORE,
    ],
    [
      "expired metadata",
      (value: ReturnType<typeof betterAuthDescriptor>) => {
        value.expiresAt = NOW
        return value
      },
      "expired_descriptor",
      CORE,
    ],
    [
      "duplicate scopes",
      (value: ReturnType<typeof betterAuthDescriptor>) => {
        value.native.desktop.scopes = ["workspace:read", "workspace:read"]
        return value
      },
      "invalid_descriptor",
      CORE,
    ],
    [
      "noncanonical Better Auth issuer",
      (value: ReturnType<typeof betterAuthDescriptor>) => {
        value.issuer = `${CORE}/other`
        return value
      },
      "deployment_mismatch",
      CORE,
    ],
  ] as const) {
    test(`rejects ${name}`, () => {
      try {
        parseDesktopAuthDescriptor(mutate(betterAuthDescriptor()), configuredOrigin, NOW)
        throw new Error("expected rejection")
      } catch (error) {
        expect(error).toBeInstanceOf(DesktopAuthDescriptorError)
        expect((error as DesktopAuthDescriptorError).code).toBe(code)
      }
    })
  }

  test("rejects every immutable binding drift, including config and ordered scopes", () => {
    const first = parseDesktopAuthDescriptor(betterAuthDescriptor(), CORE, NOW)
    const drifts: DesktopCredentialBinding[] = [
      { ...first.binding, kind: "cli" as never },
      { ...first.binding, tokenKind: "browser-session" as never },
      { ...first.binding, adapter: "clerk" },
      { ...first.binding, deploymentId: "deployment-2" },
      { ...first.binding, configurationVersion: "auth-v2" },
      { ...first.binding, issuer: "https://other.example.com" },
      { ...first.binding, flow: "adapter-native" },
      { ...first.binding, tokenEndpointOrigin: "https://tokens.example.com" },
      { ...first.binding, controlPlaneOrigin: "https://other.example.com" },
      { ...first.binding, id: "another-client" },
      { ...first.binding, resource: `${CORE}/another-resource` },
      { ...first.binding, scopes: [...first.binding.scopes].reverse() },
    ]
    for (const stored of drifts) {
      expect(() => assertDesktopCredentialBinding(stored, first)).toThrow(/selected authentication deployment/)
    }
  })

  test("rejects a legacy token-only or incomplete persisted payload", () => {
    expect(() => parseBoundDesktopCredential({ accessToken: "legacy", expiresAt: NOW })).toThrow(
      /Stored credential binding/,
    )
    expect(() =>
      parseBoundDesktopCredential({
        binding: parseDesktopAuthDescriptor(betterAuthDescriptor(), CORE, NOW).binding,
        tokens: { accessToken: "access", expiresAt: NOW },
      }),
    ).toThrow(/refresh token/)
  })
})
