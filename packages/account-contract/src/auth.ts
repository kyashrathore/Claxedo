import { asRecord } from "@claxedo/helpers/guards"

export const AUTH_ADAPTERS = ["better-auth", "custom"] as const
export const INTERACTIVE_AUTH_METHODS = ["google", "github", "email-password"] as const

export type AuthAdapterId = (typeof AUTH_ADAPTERS)[number]
export type InteractiveAuthMethod = (typeof INTERACTIVE_AUTH_METHODS)[number]

type CommonBrowserAuthDescriptor = {
  trustedOrigins: readonly string[]
  clientId: string
  resource: string
  scopes: readonly string[]
}

export type BrowserAuthDescriptor = CommonBrowserAuthDescriptor &
  (
    | {
        transport: "cookie"
        credentialPolicy: "reject-cookie-and-authorization"
        cookie: {
          name: string
          path: "/"
          secure: true
          httpOnly: true
          hostOnly: true
          sameSite: "lax" | "strict"
        }
      }
    | {
        transport: "bearer"
        credentialPolicy: "authorization-only"
        cookie?: never
      }
  )

export type NativeAuthClientDescriptor = {
  flow: "device-authorization" | "authorization-code-pkce" | "adapter-native"
  clientId: string
  resource: string
  scopes: readonly string[]
  tokenEndpointOrigin: string
  controlPlaneOrigin: string
  revocation:
    | {
        protocol: "rfc7009"
        endpoint: string
        /** Public native clients identify themselves but hold no client secret. */
        tokenEndpointAuthMethod: "none"
      }
    | {
        protocol: "adapter-native"
        endpoint: string
      }
}

export type AuthAdapterDescriptor = {
  adapter: AuthAdapterId
  deploymentId: string
  configurationVersion: string
  expiresAt: number
  issuer: string
  methods: readonly InteractiveAuthMethod[]
  browser: BrowserAuthDescriptor
  native: {
    cli: NativeAuthClientDescriptor
    desktop: NativeAuthClientDescriptor
  }
}

export type NativeDescriptor = Pick<
  AuthAdapterDescriptor,
  "adapter" | "deploymentId" | "configurationVersion" | "expiresAt" | "issuer"
> & {
  native: Partial<AuthAdapterDescriptor["native"]>
}

const NATIVE_AUTH_FLOWS = ["device-authorization", "authorization-code-pkce", "adapter-native"] as const satisfies readonly NativeAuthClientDescriptor["flow"][]

export type AuthDescriptorPolicy = {
  now: number
  clients: readonly ("cli" | "desktop")[]
  adapters?: readonly AuthAdapterId[]
  url: (value: string, name: string, kind: "origin" | "url") => string
  client?: (value: NativeAuthClientDescriptor, kind: "cli" | "desktop", issuer: string) => void
  error?: (code: "invalid_descriptor" | "expired_descriptor", message: string) => Error
}

export function decodeAuthDescriptor(raw: unknown, policy: AuthDescriptorPolicy): NativeDescriptor {
  const fail = (code: "invalid_descriptor" | "expired_descriptor", message: string): never => {
    throw policy.error?.(code, message) ?? new Error(message)
  }
  const object = (value: unknown, name: string): Record<string, unknown> =>
    asRecord(value) ?? fail("invalid_descriptor", `${name} must be an object`)
  const text = (value: unknown, name: string): string => {
    if (typeof value !== "string" || !value.trim()) return fail("invalid_descriptor", `${name} must be non-empty`)
    return value
  }
  const url = (value: unknown, name: string, kind: "origin" | "url") => policy.url(text(value, name), name, kind)
  const root = object(raw, "Authentication descriptor")
  const adapter = (policy.adapters ?? AUTH_ADAPTERS).find((candidate) => candidate === root.adapter)
  if (!adapter) return fail("invalid_descriptor", `Authentication descriptor adapter ${String(root.adapter)} is unsupported`)
  const deploymentId = text(root.deploymentId, "deploymentId")
  const configurationVersion = text(root.configurationVersion, "configurationVersion")
  if (typeof root.expiresAt !== "number" || !Number.isFinite(root.expiresAt))
    return fail("invalid_descriptor", "expiresAt must be a finite timestamp")
  if (root.expiresAt <= policy.now) return fail("expired_descriptor", "Authentication descriptor has expired")
  const issuer = url(root.issuer, "issuer", "url")
  const native = object(root.native, "native")
  const decoded: NativeDescriptor = {
    adapter,
    deploymentId,
    configurationVersion,
    expiresAt: root.expiresAt,
    issuer,
    native: {},
  }
  for (const kind of policy.clients) {
    const name = `native.${kind}`
    const row = object(native[kind], name)
    const flowName = text(row.flow, `${name}.flow`)
    const flow = NATIVE_AUTH_FLOWS.find((candidate) => candidate === flowName)
    if (!flow) return fail("invalid_descriptor", `${name}.flow is invalid`)
    const clientId = text(row.clientId, `${name}.clientId`)
    const controlPlaneOrigin = url(row.controlPlaneOrigin, `${name}.controlPlaneOrigin`, "origin")
    const tokenEndpointOrigin = url(row.tokenEndpointOrigin, `${name}.tokenEndpointOrigin`, "origin")
    const resource = url(row.resource, `${name}.resource`, "url")
    const scopes = row.scopes
    if (
      !Array.isArray(scopes) ||
      scopes.length === 0 ||
      scopes.some((value) => typeof value !== "string" || !value.trim()) ||
      new Set(scopes).size !== scopes.length
    )
      return fail("invalid_descriptor", `${name}.scopes must contain unique non-empty scopes`)
    const revocation = object(row.revocation, `${name}.revocation`)
    const endpoint = url(revocation.endpoint, `${name}.revocation.endpoint`, "url")
    let parsedRevocation: NativeAuthClientDescriptor["revocation"]
    if (revocation.protocol === "rfc7009" && revocation.tokenEndpointAuthMethod === "none")
      parsedRevocation = { protocol: "rfc7009", endpoint, tokenEndpointAuthMethod: "none" }
    else if (revocation.protocol === "adapter-native") parsedRevocation = { protocol: "adapter-native", endpoint }
    else return fail("invalid_descriptor", `${name}.revocation contract is invalid`)
    const client: NativeAuthClientDescriptor = {
      flow,
      clientId,
      resource,
      scopes,
      tokenEndpointOrigin,
      controlPlaneOrigin,
      revocation: parsedRevocation,
    }
    policy.client?.(client, kind, issuer)
    decoded.native[kind] = client
  }
  return decoded
}

export type NativeCredentialBinding = {
  kind: "cli" | "desktop"
  tokenKind: "access-token"
  adapter: AuthAdapterId
  deploymentId: string
  issuer: string
  tokenEndpointOrigin: string
  controlPlaneOrigin: string
  id: string
  resource: string
  scopes: readonly string[]
}

export function bindNativeClient<K extends "cli" | "desktop">(
  descriptor: Pick<NativeDescriptor, "adapter" | "deploymentId" | "issuer" | "native">,
  kind: K,
): NativeCredentialBinding & { kind: K } {
  const client = descriptor.native[kind]
  if (!client) throw new Error(`native.${kind} was not decoded`)
  return {
    id: client.clientId,
    resource: client.resource,
    scopes: client.scopes,
    kind,
    tokenKind: "access-token",
    deploymentId: descriptor.deploymentId,
    adapter: descriptor.adapter,
    issuer: descriptor.issuer,
    tokenEndpointOrigin: client.tokenEndpointOrigin,
    controlPlaneOrigin: client.controlPlaneOrigin,
  }
}
