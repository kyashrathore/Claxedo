import { url } from "../config"
import { requestJson } from "../http"
import { object } from "../json"
import { trimToUndefined } from "@claxedo/helpers/string"
import { asFiniteNumber } from "@claxedo/helpers/guards"

/**
 * The public native-client values a control plane advertises at
 * `/api/claxedo/auth/descriptor` (`AuthAdapterDescriptor` on the server): the
 * CLI, like the desktop, binds its credential to the deployment through that
 * document rather than by knowing client ids or endpoints itself. Both
 * certified planes serve it from Better Auth — the hosted Worker's D1
 * foundation and the self-hosted node's embedded issuer — and both register
 * the same `claxedo-cli` public client for the RFC 8628 device grant.
 */

export type NativeClient = {
  clientId: string
  resource: string
  scopes: string[]
}

export type CliAuthBinding = {
  /** Better Auth's base: `${origin}/api/auth`; every endpoint below hangs off it. */
  issuer: string
  deviceCodeUrl: string
  tokenUrl: string
  userInfoUrl: string
  cli: NativeClient
  /** The desktop mirrors its own credential into the CLI's file; a refresh of that one names its client. */
  desktop: NativeClient
}

export type FetchLike = (url: URL, init: RequestInit) => Promise<Response>

function descriptorText(value: unknown, name: string): string {
  const result = trimToUndefined(value)
  if (!result) throw new Error(`Auth descriptor: ${name} is missing`)
  return result
}

function descriptorOrigin(value: string, name: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`Auth descriptor: ${name} is not a URL`)
  }
  return parsed.origin
}

function descriptorClient(value: unknown, name: string, flow: string, controlPlaneOrigin: string, issuerOrigin: string): NativeClient {
  const row = object(value)
  if (row.flow !== flow) throw new Error(`Auth descriptor: ${name}.flow is ${String(row.flow)}, this CLI runs ${flow}`)
  const scopes = Array.isArray(row.scopes) ? row.scopes.filter((entry): entry is string => typeof entry === "string" && !!entry.trim()) : []
  if (scopes.length === 0) throw new Error(`Auth descriptor: ${name}.scopes is empty`)
  if (descriptorOrigin(descriptorText(row.controlPlaneOrigin, `${name}.controlPlaneOrigin`), `${name}.controlPlaneOrigin`) !== controlPlaneOrigin) {
    throw new Error(`Auth descriptor: ${name} belongs to another control plane (${String(row.controlPlaneOrigin)})`)
  }
  if (descriptorOrigin(descriptorText(row.tokenEndpointOrigin, `${name}.tokenEndpointOrigin`), `${name}.tokenEndpointOrigin`) !== issuerOrigin) {
    throw new Error(`Auth descriptor: ${name}.tokenEndpointOrigin does not match the issuer`)
  }
  const resource = descriptorText(row.resource, `${name}.resource`)
  if (descriptorOrigin(resource, `${name}.resource`) !== controlPlaneOrigin) {
    throw new Error(`Auth descriptor: ${name}.resource belongs to another control plane`)
  }
  return { clientId: descriptorText(row.clientId, `${name}.clientId`), resource, scopes }
}

/**
 * Validates the descriptor against the ONE control plane this CLI was pointed
 * at: the document may only describe clients of that origin, so a response
 * cannot redirect the credential to another deployment.
 */
export function parseCliAuthDescriptor(value: unknown, controlPlaneUrl: string, now = Date.now()): CliAuthBinding {
  const root = object(value)
  if (root.adapter !== "better-auth") throw new Error(`Auth descriptor: adapter ${String(root.adapter)} has no CLI login flow`)
  const expiresAt = asFiniteNumber(root.expiresAt)
  if (expiresAt === undefined || expiresAt <= now) throw new Error("Auth descriptor: expired")
  const controlPlaneOrigin = descriptorOrigin(controlPlaneUrl, "control plane URL")
  const issuer = descriptorText(root.issuer, "issuer").replace(/\/+$/, "")
  const issuerOrigin = descriptorOrigin(issuer, "issuer")
  const native = object(root.native)
  return {
    issuer,
    deviceCodeUrl: `${issuer}/device/code`,
    tokenUrl: `${issuer}/oauth2/token`,
    userInfoUrl: `${issuer}/oauth2/userinfo`,
    cli: descriptorClient(native.cli, "native.cli", "device-authorization", controlPlaneOrigin, issuerOrigin),
    desktop: descriptorClient(native.desktop, "native.desktop", "authorization-code-pkce", controlPlaneOrigin, issuerOrigin),
  }
}

export async function cliAuthBinding(controlPlaneUrl: string, deps: { fetch?: FetchLike; now: () => number }): Promise<CliAuthBinding> {
  const descriptor = await requestJson({
    url: url(controlPlaneUrl, "/api/claxedo/auth/descriptor"),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  }).catch((error: unknown) => {
    throw new Error(
      `${controlPlaneUrl} serves no auth descriptor (${error instanceof Error ? error.message : String(error)}); a self-hosted node needs BETTER_AUTH_URL set to its HTTPS origin`,
    )
  })
  return parseCliAuthDescriptor(descriptor, controlPlaneUrl, deps.now())
}
