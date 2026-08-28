import { Schema } from "effect"

export const NativeAuthAdapter = Schema.Literals(["better-auth", "clerk"])
export type NativeAuthAdapter = Schema.Schema.Type<typeof NativeAuthAdapter>

export const NativeAuthFlow = Schema.Literals(["device-authorization", "adapter-native"])
export type NativeAuthFlow = Schema.Schema.Type<typeof NativeAuthFlow>

const Rfc7009Revocation = Schema.Struct({
  protocol: Schema.Literal("rfc7009"),
  endpoint: Schema.String,
  tokenEndpointAuthMethod: Schema.Literal("none"),
})

const AdapterNativeRevocation = Schema.Struct({
  protocol: Schema.Literal("adapter-native"),
  endpoint: Schema.String,
})

const NativeRevocation = Schema.Union([Rfc7009Revocation, AdapterNativeRevocation])
export type NativeRevocation = Schema.Schema.Type<typeof NativeRevocation>

const CliDescriptor = Schema.Struct({
  flow: NativeAuthFlow,
  clientId: Schema.String,
  resource: Schema.String,
  scopes: Schema.Array(Schema.String),
  tokenEndpointOrigin: Schema.String,
  controlPlaneOrigin: Schema.String,
  revocation: NativeRevocation,
})

const BrowserDescriptor = Schema.Struct({
  trustedOrigins: Schema.Array(Schema.String),
})

const Descriptor = Schema.Struct({
  adapter: NativeAuthAdapter,
  deploymentId: Schema.String,
  configurationVersion: Schema.String,
  expiresAt: Schema.Number,
  issuer: Schema.String,
  browser: BrowserDescriptor,
  native: Schema.Struct({ cli: CliDescriptor }),
})

export type NativeCredentialBinding = {
  adapter: NativeAuthAdapter
  deploymentId: string
  issuer: string
  tokenEndpointOrigin: string
  controlPlaneOrigin: string
  clientId: string
  resource: string
  scopes: readonly string[]
  tokenKind: "access-token"
}

export type CliAuthDescriptor = NativeCredentialBinding & {
  configurationVersion: string
  expiresAt: number
  flow: NativeAuthFlow
  trustedBrowserOrigins: readonly string[]
  revocation: NativeRevocation
}

export type PersistedNativeCredentialBinding = NativeCredentialBinding & {
  configurationVersion: string
}

export type NativeCredentialBindingRow = {
  auth_adapter: string | null
  auth_deployment_id: string | null
  auth_configuration_version: string | null
  auth_issuer: string | null
  auth_token_endpoint_origin: string | null
  auth_control_plane_origin: string | null
  auth_client_id: string | null
  auth_resource: string | null
  auth_scopes: string | null
  auth_token_kind: string | null
}

export class NativeAuthDescriptorError extends Error {
  constructor(
    public readonly code:
      | "invalid_descriptor"
      | "expired_descriptor"
      | "deployment_mismatch"
      | "unsupported_native_flow"
      | "credential_binding_mismatch",
    message: string,
  ) {
    super(message)
    this.name = "NativeAuthDescriptorError"
  }
}

function invalid(message: string): never {
  throw new NativeAuthDescriptorError("invalid_descriptor", message)
}

function exactHttpsOrigin(value: string, name: string) {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return invalid(`${name} must be an exact HTTPS origin`)
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== value ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password ||
    parsed.hostname.includes("*")
  )
    return invalid(`${name} must be an exact HTTPS origin`)
  return parsed.origin
}

function exactHttpsUrl(value: string, name: string) {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return invalid(`${name} must be an exact HTTPS URL`)
  }
  const normalized = `${parsed.origin}${parsed.pathname === "/" ? "" : parsed.pathname}`
  if (
    parsed.protocol !== "https:" ||
    value !== normalized ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password ||
    parsed.hostname.includes("*")
  )
    return invalid(`${name} must be an exact HTTPS URL`)
  return parsed
}

function nonEmpty(value: string, name: string) {
  if (!value.trim()) invalid(`${name} must be non-empty`)
  return value
}

function exactScopes(value: readonly string[]) {
  if (value.length === 0 || value.some((scope) => !scope.trim()) || new Set(value).size !== value.length) {
    invalid("native.cli.scopes must contain unique non-empty scopes")
  }
  return [...value]
}

/**
 * Validate discovery against the URL the operator explicitly selected. An
 * unsigned response may describe only that deployment; it cannot redirect the
 * CLI to a different control plane, issuer origin, or OAuth resource origin.
 */
export function parseCliAuthDescriptor(input: unknown, configuredServer: string, now = Date.now()): CliAuthDescriptor {
  let raw: Schema.Schema.Type<typeof Descriptor>
  try {
    raw = Schema.decodeUnknownSync(Descriptor)(input)
  } catch {
    return invalid("Authentication descriptor has an invalid shape")
  }

  const configuredOrigin = exactHttpsOrigin(configuredServer, "Configured server")
  const controlPlaneOrigin = exactHttpsOrigin(raw.native.cli.controlPlaneOrigin, "native.cli.controlPlaneOrigin")
  if (controlPlaneOrigin !== configuredOrigin) {
    throw new NativeAuthDescriptorError(
      "deployment_mismatch",
      "Authentication descriptor belongs to a different control-plane origin",
    )
  }

  const issuer = exactHttpsUrl(raw.issuer, "issuer")
  const tokenEndpointOrigin = exactHttpsOrigin(raw.native.cli.tokenEndpointOrigin, "native.cli.tokenEndpointOrigin")
  if (tokenEndpointOrigin !== issuer.origin) {
    throw new NativeAuthDescriptorError(
      "deployment_mismatch",
      "Authentication issuer and token endpoint origins do not match",
    )
  }

  const resource = exactHttpsUrl(raw.native.cli.resource, "native.cli.resource")
  if (resource.origin !== configuredOrigin) {
    throw new NativeAuthDescriptorError(
      "deployment_mismatch",
      "Authentication resource belongs to a different control-plane origin",
    )
  }

  const trustedBrowserOrigins = raw.browser.trustedOrigins.map((origin) =>
    exactHttpsOrigin(origin, "browser.trustedOrigins"),
  )
  if (trustedBrowserOrigins.length === 0 || new Set(trustedBrowserOrigins).size !== trustedBrowserOrigins.length) {
    invalid("browser.trustedOrigins must contain unique exact HTTPS origins")
  }
  if (!Number.isFinite(raw.expiresAt) || raw.expiresAt <= now) {
    throw new NativeAuthDescriptorError("expired_descriptor", "Authentication descriptor has expired")
  }
  if (raw.adapter === "better-auth" && raw.native.cli.flow !== "device-authorization") {
    throw new NativeAuthDescriptorError(
      "unsupported_native_flow",
      "Better Auth CLI requires OAuth Device Authorization",
    )
  }
  if (raw.adapter === "clerk" && raw.native.cli.flow !== "adapter-native") {
    throw new NativeAuthDescriptorError(
      "unsupported_native_flow",
      "Clerk CLI requires its declared adapter-native flow",
    )
  }

  const revocationEndpoint = exactHttpsUrl(raw.native.cli.revocation.endpoint, "native.cli.revocation.endpoint")
  if (revocationEndpoint.origin !== tokenEndpointOrigin) {
    throw new NativeAuthDescriptorError(
      "deployment_mismatch",
      "Authentication revocation endpoint belongs to a different token endpoint origin",
    )
  }
  const revocation = {
    ...raw.native.cli.revocation,
    endpoint: revocationEndpoint.href.replace(/\/$/, ""),
  }
  if (
    raw.adapter === "better-auth" &&
    (revocation.protocol !== "rfc7009" || revocation.endpoint !== `${issuer.href.replace(/\/$/, "")}/oauth2/revoke`)
  ) {
    throw new NativeAuthDescriptorError(
      "invalid_descriptor",
      "Better Auth CLI requires its issuer-bound RFC 7009 revocation endpoint",
    )
  }
  if (raw.adapter === "clerk" && revocation.protocol !== "adapter-native") {
    throw new NativeAuthDescriptorError(
      "unsupported_native_flow",
      "Clerk CLI requires its declared adapter-native revocation protocol",
    )
  }

  return {
    adapter: raw.adapter,
    deploymentId: nonEmpty(raw.deploymentId, "deploymentId"),
    configurationVersion: nonEmpty(raw.configurationVersion, "configurationVersion"),
    expiresAt: raw.expiresAt,
    issuer: issuer.href.replace(/\/$/, ""),
    flow: raw.native.cli.flow,
    tokenEndpointOrigin,
    controlPlaneOrigin,
    clientId: nonEmpty(raw.native.cli.clientId, "native.cli.clientId"),
    resource: resource.href.replace(/\/$/, ""),
    scopes: exactScopes(raw.native.cli.scopes),
    tokenKind: "access-token",
    trustedBrowserOrigins,
    revocation,
  }
}

export function credentialBinding(descriptor: CliAuthDescriptor): NativeCredentialBinding {
  return {
    adapter: descriptor.adapter,
    deploymentId: descriptor.deploymentId,
    issuer: descriptor.issuer,
    tokenEndpointOrigin: descriptor.tokenEndpointOrigin,
    controlPlaneOrigin: descriptor.controlPlaneOrigin,
    clientId: descriptor.clientId,
    resource: descriptor.resource,
    scopes: descriptor.scopes,
    tokenKind: descriptor.tokenKind,
  }
}

export function persistedCredentialBinding(descriptor: CliAuthDescriptor): PersistedNativeCredentialBinding {
  return { ...credentialBinding(descriptor), configurationVersion: descriptor.configurationVersion }
}

/** Missing legacy fields are deliberately rejected as an unbound credential. */
export function credentialBindingFromRow(row: NativeCredentialBindingRow): PersistedNativeCredentialBinding {
  let scopes: unknown
  try {
    scopes = row.auth_scopes === null ? undefined : JSON.parse(row.auth_scopes)
  } catch {
    scopes = undefined
  }
  if (
    (row.auth_adapter !== "better-auth" && row.auth_adapter !== "clerk") ||
    !row.auth_deployment_id ||
    !row.auth_configuration_version ||
    !row.auth_issuer ||
    !row.auth_token_endpoint_origin ||
    !row.auth_control_plane_origin ||
    !row.auth_client_id ||
    !row.auth_resource ||
    row.auth_token_kind !== "access-token" ||
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    scopes.some((scope) => typeof scope !== "string" || !scope.trim()) ||
    new Set(scopes).size !== scopes.length
  ) {
    throw new NativeAuthDescriptorError(
      "credential_binding_mismatch",
      "Stored native credential is unbound or corrupt; sign in again",
    )
  }
  return {
    adapter: row.auth_adapter,
    deploymentId: row.auth_deployment_id,
    configurationVersion: row.auth_configuration_version,
    issuer: row.auth_issuer,
    tokenEndpointOrigin: row.auth_token_endpoint_origin,
    controlPlaneOrigin: row.auth_control_plane_origin,
    clientId: row.auth_client_id,
    resource: row.auth_resource,
    scopes,
    tokenKind: row.auth_token_kind,
  }
}

export function assertCredentialBinding(
  stored: NativeCredentialBinding,
  descriptor: CliAuthDescriptor,
): NativeCredentialBinding {
  const current = credentialBinding(descriptor)
  if (
    stored.adapter !== current.adapter ||
    stored.deploymentId !== current.deploymentId ||
    stored.issuer !== current.issuer ||
    stored.tokenEndpointOrigin !== current.tokenEndpointOrigin ||
    stored.controlPlaneOrigin !== current.controlPlaneOrigin ||
    stored.clientId !== current.clientId ||
    stored.resource !== current.resource ||
    stored.tokenKind !== current.tokenKind ||
    stored.scopes.length !== current.scopes.length ||
    stored.scopes.some((scope, index) => scope !== current.scopes[index])
  ) {
    throw new NativeAuthDescriptorError(
      "credential_binding_mismatch",
      "Stored credential does not belong to the currently selected authentication deployment",
    )
  }
  return stored
}

export function assertCredentialServer(stored: NativeCredentialBinding, server: string) {
  const configured = exactHttpsOrigin(server, "Stored account server")
  if (configured !== stored.controlPlaneOrigin) {
    throw new NativeAuthDescriptorError(
      "credential_binding_mismatch",
      "Stored account URL does not match the credential's control-plane origin",
    )
  }
  return stored
}

export function authorizationUri(value: string, descriptor: CliAuthDescriptor) {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return invalid("Device authorization response contains an invalid verification URL")
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    !descriptor.trustedBrowserOrigins.includes(parsed.origin)
  ) {
    throw new NativeAuthDescriptorError(
      "deployment_mismatch",
      "Device authorization response points at an untrusted browser origin",
    )
  }
  return parsed.href
}

export function betterAuthDeviceEndpoint(descriptor: CliAuthDescriptor) {
  if (descriptor.adapter !== "better-auth" || descriptor.flow !== "device-authorization") {
    throw new NativeAuthDescriptorError(
      "unsupported_native_flow",
      "Selected auth adapter does not use OAuth Device Authorization",
    )
  }
  return `${descriptor.issuer}/device/code`
}

export function betterAuthTokenEndpoint(descriptor: Pick<CliAuthDescriptor, "adapter" | "flow" | "issuer">) {
  if (descriptor.adapter !== "better-auth" || descriptor.flow !== "device-authorization") {
    throw new NativeAuthDescriptorError(
      "unsupported_native_flow",
      "Selected auth adapter does not use OAuth Device Authorization",
    )
  }
  return `${descriptor.issuer}/oauth2/token`
}
