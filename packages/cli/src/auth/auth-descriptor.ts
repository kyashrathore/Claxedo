import { url } from "../config"
import { requestJson } from "../http"
import { object } from "../json"
import { trimToUndefined } from "@claxedo/helpers/string"
import { asFiniteNumber } from "@claxedo/helpers/guards"
import { isLoopbackHostname } from "@claxedo/helpers"

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
  /**
   * Every origin this deployment says it serves its own pages from: the control
   * plane the user pointed the CLI at, the issuer, and the web app's trusted
   * origins — a deployment's app and API origins differ in the hosted plane.
   * The device grant's browser destination is checked against this set.
   */
  pageOrigins: readonly string[]
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

/**
 * The transport every endpoint below is reached over. The document is unsigned
 * and arrives over the wire, so a cleartext origin inside it puts the device
 * grant, the token poll and the bearer-carrying userinfo call on the network in
 * the clear — an HTTPS control plane can otherwise name an `http:` issuer and
 * the CLI would obey. `http:` survives only for the three loopback names a
 * request cannot leave the machine for, which is the same cleartext case
 * `canonicalControlPlaneUrl` allows a machine enrollment. Userinfo is refused
 * because `https://app.example@evil.test` reads as one host and resolves to
 * another, and the parsed host is what the origin comparisons below compare.
 */
function descriptorUrl(value: string, name: string): URL {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`Auth descriptor: ${name} is not a URL`)
  }
  if (parsed.username || parsed.password) throw new Error(`Auth descriptor: ${name} carries a user or password`)
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname))) {
    throw new Error(`Auth descriptor: ${name} must be https:// (http:// only for localhost, 127.0.0.1 or ::1)`)
  }
  return parsed
}

function descriptorOrigin(value: string, name: string): string {
  return descriptorUrl(value, name).origin
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
 * Entries this CLI would not talk to are dropped rather than refused: the set
 * only ever admits a destination, and a deployment that also lists a cleartext
 * dev origin still has a working hosted login. Dropping is the safe direction —
 * an entry that never lands here can never be opened.
 */
function browserPageOrigins(value: unknown): string[] {
  const trusted = object(value).trustedOrigins
  if (!Array.isArray(trusted)) return []
  return trusted.flatMap((entry) => {
    if (typeof entry !== "string") return []
    try {
      return [descriptorUrl(entry, "browser.trustedOrigins").origin]
    } catch {
      return []
    }
  })
}

/**
 * The issuer is concatenated with `/device/code` and friends, so a query or a
 * fragment on it would push those segments into the query of a request to the
 * base path instead — the endpoint would not be the one the string reads as.
 */
function descriptorIssuer(value: unknown): string {
  const raw = descriptorText(value, "issuer").replace(/\/+$/, "")
  const parsed = descriptorUrl(raw, "issuer")
  if (parsed.search || parsed.hash || `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "") !== raw) {
    throw new Error("Auth descriptor: issuer must be an origin with a plain path")
  }
  return raw
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
  const issuer = descriptorIssuer(root.issuer)
  const issuerOrigin = descriptorOrigin(issuer, "issuer")
  const native = object(root.native)
  return {
    issuer,
    pageOrigins: [...new Set([controlPlaneOrigin, issuerOrigin, ...browserPageOrigins(root.browser)])],
    deviceCodeUrl: `${issuer}/device/code`,
    tokenUrl: `${issuer}/oauth2/token`,
    userInfoUrl: `${issuer}/oauth2/userinfo`,
    cli: descriptorClient(native.cli, "native.cli", "device-authorization", controlPlaneOrigin, issuerOrigin),
    desktop: descriptorClient(native.desktop, "native.desktop", "authorization-code-pkce", controlPlaneOrigin, issuerOrigin),
  }
}

/**
 * The browser destination the device grant may send a user to. It arrives in
 * the device-code response, so it is the authentication server's text, and it
 * ends up both printed and handed to an OS launcher: a `javascript:`/`file:`
 * scheme, userinfo that makes one host read as another, or another deployment's
 * origin is a phishing or launch primitive, not a sign-in page. The descriptor
 * is the authority for where this deployment's pages live, and the CLI's own
 * control-plane URL anchors that document — so membership in `pageOrigins`
 * carries the descriptor's transport floor here too.
 */
export function deploymentPageUrl(binding: CliAuthBinding, value: string, name: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`Device-code response: ${name} is not a URL`)
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Device-code response: ${name} is a ${parsed.protocol} URL, not a web page`)
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Device-code response: ${name} carries a user or password`)
  }
  if (!binding.pageOrigins.includes(parsed.origin)) {
    throw new Error(`Device-code response: ${name} points at ${parsed.origin}, which this control plane does not serve`)
  }
  return parsed.toString()
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
