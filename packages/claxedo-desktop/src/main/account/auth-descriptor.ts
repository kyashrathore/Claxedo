import { bindNativeClient, decodeAuthDescriptor, type NativeCredentialBinding } from "@claxedo/account-contract/auth"
import { isRecord } from "@claxedo/helpers/guards"
import type { TokenSet } from "./oauth-flow"

export type DesktopCredentialBinding = Omit<NativeCredentialBinding, "kind" | "adapter"> & {
  kind: "desktop"
  adapter: "better-auth"
  configurationVersion: string
  flow: "authorization-code-pkce"
}

export type BoundDesktopCredential = {
  binding: DesktopCredentialBinding
  tokens: TokenSet & { refreshToken: string }
}

export type DesktopAuthDescriptor = {
  adapter: "better-auth"
  expiresAt: number
  binding: DesktopCredentialBinding
  authorizeUrl: string
  tokenUrl: string
  revocation: {
    protocol: "rfc7009"
    endpoint: string
    tokenEndpointAuthMethod: "none"
  }
}

export class DesktopAuthDescriptorError extends Error {
  constructor(
    public readonly code:
      | "invalid_descriptor"
      | "expired_descriptor"
      | "deployment_mismatch"
      | "unsupported_native_flow"
      | "credential_binding_mismatch"
      | "descriptor_unavailable",
    message: string,
  ) {
    super(message)
    this.name = "DesktopAuthDescriptorError"
  }
}

function fail(code: DesktopAuthDescriptorError["code"], message: string): never {
  throw new DesktopAuthDescriptorError(code, message)
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) return fail("invalid_descriptor", `${name} must be an object`)
  return value
}

function text(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) {
    return fail("invalid_descriptor", `${name} must be non-empty`)
  }
  return value
}

function exactHttpsOrigin(value: unknown, name: string) {
  const raw = text(value, name)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return fail("invalid_descriptor", `${name} must be an exact HTTPS origin`)
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== raw ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password ||
    parsed.hostname.includes("*")
  ) {
    return fail("invalid_descriptor", `${name} must be an exact HTTPS origin`)
  }
  return parsed.origin
}

function exactHttpsUrl(value: unknown, name: string) {
  const raw = text(value, name)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return fail("invalid_descriptor", `${name} must be an exact HTTPS URL`)
  }
  const normalized = `${parsed.origin}${parsed.pathname === "/" ? "" : parsed.pathname}`
  if (
    parsed.protocol !== "https:" ||
    normalized !== raw ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password ||
    parsed.hostname.includes("*")
  ) {
    return fail("invalid_descriptor", `${name} must be an exact HTTPS URL`)
  }
  return normalized
}

function scopes(value: unknown, name: string): string[] {
  const entries = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    entries.length !== value.length ||
    entries.some((entry) => !entry.trim()) ||
    new Set(entries).size !== entries.length
  ) {
    return fail("invalid_descriptor", `${name} must contain unique non-empty scopes`)
  }
  return entries
}

/**
 * Validate the unsigned descriptor against the one HTTPS origin selected by
 * the desktop build/operator. The response may select an adapter only inside
 * that trust boundary; it cannot redirect credentials to another deployment.
 */
export function parseDesktopAuthDescriptor(
  value: unknown,
  configuredCoreOrigin: string,
  now = Date.now(),
): DesktopAuthDescriptor {
  const configuredOrigin = exactHttpsOrigin(configuredCoreOrigin, "Configured core origin")
  const descriptor = decodeAuthDescriptor(value, {
    now,
    adapters: ["better-auth"],
    clients: ["desktop"],
    url: (value, name, kind) => (kind === "origin" ? exactHttpsOrigin(value, name) : exactHttpsUrl(value, name)),
    error: (code, message) => new DesktopAuthDescriptorError(code, message),
    client: (desktop, _kind, issuer) => {
      if (desktop.controlPlaneOrigin !== configuredOrigin)
        fail("deployment_mismatch", "Authentication descriptor belongs to a different control-plane origin")
      if (new URL(issuer).origin !== desktop.tokenEndpointOrigin)
        fail("deployment_mismatch", "Authentication issuer and token endpoint origins do not match")
      if (new URL(desktop.resource).origin !== configuredOrigin)
        fail("deployment_mismatch", "Authentication resource belongs to a different control-plane origin")
      if (new URL(desktop.revocation.endpoint).origin !== desktop.tokenEndpointOrigin)
        fail("deployment_mismatch", "Authentication revocation endpoint belongs to another origin")
      if (desktop.flow !== "authorization-code-pkce")
        fail("unsupported_native_flow", "Better Auth desktop requires authorization code with PKCE")
      if (issuer !== `${configuredOrigin}/api/auth`)
        fail("deployment_mismatch", "Better Auth issuer is not bound to the configured core origin")
      if (desktop.revocation.protocol !== "rfc7009" || desktop.revocation.endpoint !== `${issuer}/oauth2/revoke`)
        fail("invalid_descriptor", "Better Auth desktop requires issuer-bound public-client revocation")
    },
  })
  const binding: DesktopCredentialBinding = {
    ...bindNativeClient(descriptor, "desktop"),
    adapter: "better-auth",
    configurationVersion: descriptor.configurationVersion,
    flow: "authorization-code-pkce",
  }
  return {
    adapter: "better-auth",
    expiresAt: descriptor.expiresAt,
    binding,
    authorizeUrl: `${descriptor.issuer}/oauth2/authorize`,
    tokenUrl: `${descriptor.issuer}/oauth2/token`,
    revocation: {
      protocol: "rfc7009",
      endpoint: `${descriptor.issuer}/oauth2/revoke`,
      tokenEndpointAuthMethod: "none",
    },
  }
}

export function assertDesktopCredentialBinding(stored: DesktopCredentialBinding, descriptor: DesktopAuthDescriptor) {
  const current = descriptor.binding
  const scalarKeys = [
    "kind",
    "tokenKind",
    "adapter",
    "deploymentId",
    "configurationVersion",
    "issuer",
    "flow",
    "tokenEndpointOrigin",
    "controlPlaneOrigin",
    "id",
    "resource",
  ] as const satisfies readonly (keyof DesktopCredentialBinding)[]
  if (
    scalarKeys.some((key) => stored[key] !== current[key]) ||
    stored.scopes.length !== current.scopes.length ||
    stored.scopes.some((scope, index) => scope !== current.scopes[index])
  ) {
    return fail(
      "credential_binding_mismatch",
      "Stored credential does not belong to the selected authentication deployment",
    )
  }
  return stored
}

/** Reject legacy decrypted payloads before they can become live credentials. */
export function parseBoundDesktopCredential(value: unknown): BoundDesktopCredential {
  const root = object(value, "Stored credential")
  const binding = object(root.binding, "Stored credential binding")
  const tokens = object(root.tokens, "Stored token set")
  const parsedBinding: DesktopCredentialBinding = {
    kind:
      binding.kind === "desktop" ? "desktop" : fail("credential_binding_mismatch", "Stored credential kind is invalid"),
    tokenKind:
      binding.tokenKind === "access-token"
        ? "access-token"
        : fail("credential_binding_mismatch", "Stored credential token kind is invalid"),
    adapter:
      binding.adapter === "better-auth"
        ? binding.adapter
        : fail("credential_binding_mismatch", "Stored credential adapter is invalid"),
    deploymentId: text(binding.deploymentId, "Stored credential deploymentId"),
    configurationVersion: text(binding.configurationVersion, "Stored credential configurationVersion"),
    issuer: exactHttpsUrl(binding.issuer, "Stored credential issuer"),
    flow:
      binding.flow === "authorization-code-pkce"
        ? binding.flow
        : fail("credential_binding_mismatch", "Stored credential flow is invalid"),
    tokenEndpointOrigin: exactHttpsOrigin(binding.tokenEndpointOrigin, "Stored credential tokenEndpointOrigin"),
    controlPlaneOrigin: exactHttpsOrigin(binding.controlPlaneOrigin, "Stored credential controlPlaneOrigin"),
    id: text(binding.id, "Stored credential clientId"),
    resource: exactHttpsUrl(binding.resource, "Stored credential resource"),
    scopes: scopes(binding.scopes, "Stored credential scopes"),
  }
  const accessToken = text(tokens.accessToken, "Stored access token")
  const refreshToken = text(tokens.refreshToken, "Stored refresh token")
  if (typeof tokens.expiresAt !== "number" || !Number.isFinite(tokens.expiresAt) || tokens.expiresAt <= 0) {
    return fail("credential_binding_mismatch", "Stored access-token expiry is invalid")
  }
  return {
    binding: parsedBinding,
    tokens: { accessToken, refreshToken, expiresAt: tokens.expiresAt },
  }
}
