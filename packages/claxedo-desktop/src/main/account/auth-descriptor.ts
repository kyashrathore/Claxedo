import type { TokenSet } from "./oauth-flow"

/** Structural mirror of the server's provider-neutral native binding. */
export type DesktopCredentialBinding = {
  kind: "desktop"
  tokenKind: "access-token"
  adapter: "better-auth" | "clerk"
  deploymentId: string
  configurationVersion: string
  issuer: string
  flow: "authorization-code-pkce" | "adapter-native"
  tokenEndpointOrigin: string
  controlPlaneOrigin: string
  id: string
  resource: string
  scopes: readonly string[]
}

export type BoundDesktopCredential = {
  binding: DesktopCredentialBinding
  tokens: TokenSet & { refreshToken: string }
}

export type DesktopAuthDescriptor = {
  adapter: "better-auth" | "clerk"
  expiresAt: number
  binding: DesktopCredentialBinding
  authorizeUrl: string
  tokenUrl: string
  revocation:
    | {
        protocol: "rfc7009"
        endpoint: string
        tokenEndpointAuthMethod: "none"
      }
    | {
        protocol: "adapter-native"
        endpoint: string
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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("invalid_descriptor", `${name} must be an object`)
  }
  return value as Record<string, unknown>
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

function scopes(value: unknown, name: string) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || !entry.trim()) ||
    new Set(value).size !== value.length
  ) {
    return fail("invalid_descriptor", `${name} must contain unique non-empty scopes`)
  }
  return [...value] as string[]
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
  const root = object(value, "Authentication descriptor")
  const adapter = root.adapter
  if (adapter !== "better-auth" && adapter !== "clerk") {
    return fail("invalid_descriptor", "Authentication descriptor has an unknown adapter")
  }
  const deploymentId = text(root.deploymentId, "deploymentId")
  const configurationVersion = text(root.configurationVersion, "configurationVersion")
  if (typeof root.expiresAt !== "number" || !Number.isFinite(root.expiresAt)) {
    return fail("invalid_descriptor", "expiresAt must be a finite timestamp")
  }
  if (root.expiresAt <= now) {
    return fail("expired_descriptor", "Authentication descriptor has expired")
  }

  const issuer = exactHttpsUrl(root.issuer, "issuer")
  const native = object(root.native, "native")
  const desktop = object(native.desktop, "native.desktop")
  const controlPlaneOrigin = exactHttpsOrigin(desktop.controlPlaneOrigin, "native.desktop.controlPlaneOrigin")
  if (controlPlaneOrigin !== configuredOrigin) {
    return fail("deployment_mismatch", "Authentication descriptor belongs to a different control-plane origin")
  }
  const tokenEndpointOrigin = exactHttpsOrigin(desktop.tokenEndpointOrigin, "native.desktop.tokenEndpointOrigin")
  if (new URL(issuer).origin !== tokenEndpointOrigin) {
    return fail("deployment_mismatch", "Authentication issuer and token endpoint origins do not match")
  }
  const resource = exactHttpsUrl(desktop.resource, "native.desktop.resource")
  if (new URL(resource).origin !== configuredOrigin) {
    return fail("deployment_mismatch", "Authentication resource belongs to a different control-plane origin")
  }
  const clientId = text(desktop.clientId, "native.desktop.clientId")
  const selectedScopes = scopes(desktop.scopes, "native.desktop.scopes")
  const revocation = object(desktop.revocation, "native.desktop.revocation")
  const revocationEndpoint = exactHttpsUrl(revocation.endpoint, "native.desktop.revocation.endpoint")
  if (new URL(revocationEndpoint).origin !== tokenEndpointOrigin) {
    return fail("deployment_mismatch", "Authentication revocation endpoint belongs to another origin")
  }

  let flow: DesktopCredentialBinding["flow"]
  let authorizeUrl: string
  let tokenUrl: string
  let parsedRevocation: DesktopAuthDescriptor["revocation"]
  if (adapter === "better-auth") {
    if (desktop.flow !== "authorization-code-pkce") {
      return fail("unsupported_native_flow", "Better Auth desktop requires authorization code with PKCE")
    }
    if (issuer !== `${configuredOrigin}/api/auth`) {
      return fail("deployment_mismatch", "Better Auth issuer is not bound to the configured core origin")
    }
    if (
      revocation.protocol !== "rfc7009" ||
      revocation.tokenEndpointAuthMethod !== "none" ||
      revocationEndpoint !== `${issuer}/oauth2/revoke`
    ) {
      return fail("invalid_descriptor", "Better Auth desktop requires issuer-bound public-client revocation")
    }
    flow = "authorization-code-pkce"
    authorizeUrl = `${issuer}/oauth2/authorize`
    tokenUrl = `${issuer}/oauth2/token`
    parsedRevocation = {
      protocol: "rfc7009",
      endpoint: revocationEndpoint,
      tokenEndpointAuthMethod: "none",
    }
  } else {
    if (desktop.flow !== "adapter-native" || revocation.protocol !== "adapter-native") {
      return fail("unsupported_native_flow", "Clerk desktop requires its adapter-native flow and revocation")
    }
    if (issuer !== tokenEndpointOrigin) {
      return fail("deployment_mismatch", "Clerk issuer must be its exact declared token origin")
    }
    flow = "adapter-native"
    authorizeUrl = `${issuer}/oauth/authorize`
    tokenUrl = `${issuer}/oauth/token`
    parsedRevocation = { protocol: "adapter-native", endpoint: revocationEndpoint }
  }

  const binding = {
    kind: "desktop",
    tokenKind: "access-token",
    adapter,
    deploymentId,
    configurationVersion,
    issuer,
    flow,
    tokenEndpointOrigin,
    controlPlaneOrigin,
    id: clientId,
    resource,
    scopes: selectedScopes,
  } as const satisfies DesktopCredentialBinding

  return {
    adapter,
    expiresAt: root.expiresAt,
    binding,
    authorizeUrl,
    tokenUrl,
    revocation: parsedRevocation,
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
      binding.adapter === "better-auth" || binding.adapter === "clerk"
        ? binding.adapter
        : fail("credential_binding_mismatch", "Stored credential adapter is invalid"),
    deploymentId: text(binding.deploymentId, "Stored credential deploymentId"),
    configurationVersion: text(binding.configurationVersion, "Stored credential configurationVersion"),
    issuer: exactHttpsUrl(binding.issuer, "Stored credential issuer"),
    flow:
      binding.flow === "authorization-code-pkce" || binding.flow === "adapter-native"
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
