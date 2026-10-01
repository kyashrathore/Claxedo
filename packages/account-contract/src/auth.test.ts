import { expect, test } from "bun:test"
import { bindNativeClient, decodeAuthDescriptor } from "./auth"

const raw = {
  adapter: "better-auth",
  deploymentId: "deployment-1",
  configurationVersion: "auth-v1",
  expiresAt: 1800000060000,
  issuer: "https://core.example.com/api/auth",
  native: {
    desktop: {
      flow: "authorization-code-pkce",
      clientId: "claxedo-desktop",
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
} as const
const policy = { now: 1800000000000, clients: ["desktop"] as const, url: (value: string) => value }

test("native descriptor decoding preserves advertised strings and binding field order", () => {
  const decoded = decodeAuthDescriptor(raw, policy)
  expect(decoded).toEqual(raw)
  expect(JSON.stringify(bindNativeClient(decoded, "desktop"))).toBe(
    '{"id":"claxedo-desktop","resource":"https://core.example.com/control-plane","scopes":["offline_access","workspace:read","workspace:write"],"kind":"desktop","tokenKind":"access-token","deploymentId":"deployment-1","adapter":"better-auth","issuer":"https://core.example.com/api/auth","tokenEndpointOrigin":"https://core.example.com","controlPlaneOrigin":"https://core.example.com"}',
  )
})

test("native codec refuses missing metadata, expiry and malformed scopes", () => {
  for (const patch of [
    { deploymentId: "" },
    { configurationVersion: "" },
    { expiresAt: NaN },
    { expiresAt: policy.now },
    { native: {} },
  ])
    expect(() => decodeAuthDescriptor({ ...raw, ...patch }, policy)).toThrow()
  for (const scopes of [[], ["openid", "openid"], ["openid", 7], ["openid", " "]])
    expect(() =>
      decodeAuthDescriptor({ ...raw, native: { desktop: { ...raw.native.desktop, scopes } } }, policy),
    ).toThrow(/scopes/)
})

test("URL transport and native flow checks are supplied by the caller", () => {
  expect(() =>
    decodeAuthDescriptor(raw, {
      ...policy,
      url: () => {
        throw new Error("transport refused")
      },
    }),
  ).toThrow("transport refused")
  expect(() =>
    decodeAuthDescriptor(raw, {
      ...policy,
      client: () => {
        throw new Error("flow refused")
      },
    }),
  ).toThrow("flow refused")
})
