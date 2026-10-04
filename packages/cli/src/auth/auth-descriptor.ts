import { bindNativeClient, decodeAuthDescriptor, type NativeCredentialBinding } from "@claxedo/account-contract/auth"
import { url } from "../config"
import { requestJson } from "../http"
import { object } from "../json"
import { trimToUndefined } from "@claxedo/helpers/string"
import { isLoopbackHostname } from "@claxedo/helpers"

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
  if (root.adapter !== "better-auth")
    throw new Error(`Auth descriptor: adapter ${String(root.adapter)} has no CLI login flow`)
  const controlPlaneOrigin = descriptorOrigin(controlPlaneUrl, "control plane URL")
  const decoded = decodeAuthDescriptor(value, {
    now,
    adapters: ["better-auth"],
    clients: ["cli", "desktop"],
    url: (value, name, kind) => {
      if (name === "issuer") return descriptorIssuer(value)
      if (kind === "origin") return descriptorOrigin(value, name)
      descriptorUrl(value, name)
      return value
    },
    error: (_code, message) => new Error(`Auth descriptor: ${message}`),
    client: (client, kind, issuer) => {
      const name = `native.${kind}`
      const flow = kind === "cli" ? "device-authorization" : "authorization-code-pkce"
      if (client.flow !== flow)
        throw new Error(`Auth descriptor: ${name}.flow is ${client.flow}, this CLI runs ${flow}`)
      if (client.controlPlaneOrigin !== controlPlaneOrigin)
        throw new Error(`Auth descriptor: ${name} belongs to another control plane (${client.controlPlaneOrigin})`)
      if (client.tokenEndpointOrigin !== new URL(issuer).origin)
        throw new Error(`Auth descriptor: ${name}.tokenEndpointOrigin does not match the issuer`)
      if (new URL(client.resource).origin !== controlPlaneOrigin)
        throw new Error(`Auth descriptor: ${name}.resource belongs to another control plane`)
    },
  })
  const { issuer } = decoded
  const client = (binding: NativeCredentialBinding): NativeClient => ({
    clientId: binding.id,
    resource: binding.resource,
    scopes: [...binding.scopes],
  })
  return {
    issuer,
    pageOrigins: [
      ...new Set([controlPlaneOrigin, new URL(issuer).origin, ...browserPageOrigins(object(value).browser)]),
    ],
    deviceCodeUrl: `${issuer}/device/code`,
    tokenUrl: `${issuer}/oauth2/token`,
    userInfoUrl: `${issuer}/oauth2/userinfo`,
    cli: client(bindNativeClient(decoded, "cli")),
    desktop: client(bindNativeClient(decoded, "desktop")),
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

export async function cliAuthBinding(
  controlPlaneUrl: string,
  deps: { fetch?: FetchLike; now: () => number },
): Promise<CliAuthBinding> {
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
