export type McpOAuthClientRegistration =
  | { kind: "pre-registered"; clientId: string; clientSecret?: string }
  | { kind: "client-id-metadata-document"; clientId: string }
  | { kind: "dynamic"; clientId: string; clientSecret?: string }

/** One issued OAuth client, as both the registry and the token exchange see it. */
export type McpOAuthDynamicClient = { clientId: string; clientSecret?: string }

/**
 * Persistence for RFC 7591 dynamic client registration. Discovery performs the
 * registration request itself and stays free of storage: `lookup` answers
 * whether this deployment already holds a client for an issuer, and `register`
 * durably records the one it just obtained (returning the row that won, so two
 * concurrent registrations converge on a single client).
 *
 * `clientMetadata` is the deployment's own RFC 7591 client metadata document
 * WITHOUT `client_id` — the same body the client-id-metadata-document route
 * publishes, which is what makes the two registration paths one identity.
 */
export type McpOAuthDynamicRegistrationPort = {
  clientMetadata: Readonly<Record<string, unknown>>
  lookup(issuer: string): Promise<McpOAuthDynamicClient | undefined>
  register(input: {
    issuer: string
    registrationEndpoint: string
    metadata: Record<string, unknown>
  }): Promise<McpOAuthDynamicClient>
}

export type McpOAuthDiscovery = {
  resource: string
  resourceMetadataUrl: string
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  authorizationResponseIssuerParameterSupported: boolean
  scopes: string[]
  client: McpOAuthClientRegistration
}

export type McpOAuthDiscoveryResult =
  | { status: "public" }
  | { status: "protected"; discovery: McpOAuthDiscovery }

export class McpOAuthDiscoveryError extends Error {
  constructor(
    readonly code:
      | "invalid-resource"
      | "discovery-failed"
      | "ambiguous-issuer"
      | "unsupported-client-registration"
      | "pkce-unsupported",
    message: string,
    readonly issuers?: readonly string[],
  ) {
    super(message)
    this.name = "McpOAuthDiscoveryError"
  }
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>
const MAX_METADATA_BYTES = 256 * 1024

function isPrivateAddress(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (host === "localhost" || host === "::1" || host.endsWith(".localhost")) return true
  if (/^127(?:\.\d{1,3}){3}$/.test(host) || /^10(?:\.\d{1,3}){3}$/.test(host)) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const octets = v4.slice(1).map(Number)
    if (octets.some((part) => part > 255)) return true
    if (octets[0] === 0 || octets[0] === 169 && octets[1] === 254 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 || octets[0] === 192 && octets[1] === 168) return true
  }
  return host === "::" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb")
}

function safeEndpoint(value: string, options: { loopback?: boolean } = {}): URL | undefined {
  let url: URL
  try { url = new URL(value) } catch { return undefined }
  if (url.username || url.password || url.hash) return undefined
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
  if (url.protocol === "https:" && (!isPrivateAddress(url.hostname) || options.loopback && loopback)) return url
  if (options.loopback && url.protocol === "http:" && loopback) return url
  return undefined
}

async function boundedJson(response: Response) {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > MAX_METADATA_BYTES) throw new Error("metadata response is too large")
  if (!response.body) throw new Error("metadata response has no body")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const part = await reader.read()
    if (part.done) break
    length += part.value.byteLength
    if (length > MAX_METADATA_BYTES) {
      await reader.cancel("metadata response is too large")
      throw new Error("metadata response is too large")
    }
    chunks.push(part.value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

async function safeFetch(fetcher: Fetch, input: URL, init?: RequestInit) {
  let url = input
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetcher(url.toString(), { ...init, redirect: "manual" })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get("location")
    const next = location ? safeEndpoint(new URL(location, url).toString(), { loopback: url.protocol === "http:" }) : undefined
    if (!next) throw new Error("discovery redirect is unsafe")
    url = next
  }
  throw new Error("discovery redirected too many times")
}

function bearerChallenge(header: string | null) {
  if (!header || !/\bBearer\b/i.test(header)) return {}
  const metadata = /\bresource_metadata\s*=\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i.exec(header)?.[1]?.replace(/\\"/g, '"')
  const scopes = /\bscope\s*=\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i.exec(header)?.[1]?.split(/\s+/).filter(Boolean) ?? []
  return { metadata, scopes }
}

function protectedResourceCandidates(resource: URL, pointer?: string) {
  if (pointer) {
    const explicit = safeEndpoint(new URL(pointer, resource).toString(), { loopback: resource.protocol === "http:" })
    return explicit ? [explicit] : []
  }
  const path = resource.pathname === "/" ? "" : resource.pathname.replace(/\/$/, "")
  return [
    new URL(`/.well-known/oauth-protected-resource${path}`, resource.origin),
    new URL("/.well-known/oauth-protected-resource", resource.origin),
  ].filter((candidate, index, values) => values.findIndex((value) => value.toString() === candidate.toString()) === index)
}

function authorizationMetadataCandidates(issuer: URL) {
  const path = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/, "")
  return [
    new URL(`/.well-known/oauth-authorization-server${path}`, issuer.origin),
    new URL(`/.well-known/openid-configuration${path}`, issuer.origin),
    new URL(`${issuer.toString().replace(/\/$/, "")}/.well-known/openid-configuration`),
  ].filter((candidate, index, values) => values.findIndex((value) => value.toString() === candidate.toString()) === index)
}

async function firstMetadata(
  fetcher: Fetch,
  candidates: URL[],
): Promise<{ url: string; raw: Record<string, unknown> } | undefined> {
  for (const candidate of candidates) {
    const response = await safeFetch(fetcher, candidate, { headers: { accept: "application/json" } })
    if (response.status === 404) continue
    if (!response.ok) throw new Error(`metadata request failed with ${response.status}`)
    const raw = await boundedJson(response)
    if (!record(raw)) throw new Error("metadata response is not an object")
    return { url: candidate.toString(), raw }
  }
  return undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...new Set(value)] as string[] : []
}

/**
 * RFC 9728 §3.3: a resource server's metadata `resource` value identifies the
 * protected resource, and it MAY name a broader resource than the exact URL
 * that was requested — Context7 advertises its origin (`https://mcp.context7.com`)
 * for the MCP endpoint at `/mcp/oauth`. So the canonical value is accepted when
 * it is the exact URL, or a same-origin prefix of it that ends on a path
 * SEGMENT boundary. A different origin is always refused: that is the binding
 * that stops one server from claiming another's tokens. A canonical value
 * carrying a query is only ever accepted exactly.
 */
function resourceIdentifies(canonical: URL, resource: URL) {
  if (canonical.origin !== resource.origin) return false
  if (canonical.toString() === resource.toString()) return true
  if (canonical.search) return false
  if (canonical.pathname === "/") return true
  const prefix = canonical.pathname.endsWith("/") ? canonical.pathname : `${canonical.pathname}/`
  return resource.pathname.startsWith(prefix)
}

async function dynamicRegistration(input: {
  fetch: Fetch
  issuer: string
  metadata: Record<string, unknown>
  port: McpOAuthDynamicRegistrationPort
}): Promise<McpOAuthClientRegistration | undefined> {
  const endpoint = typeof input.metadata.registration_endpoint === "string"
    ? safeEndpoint(input.metadata.registration_endpoint)
    : undefined
  if (!endpoint) return undefined
  const known = await input.port.lookup(input.issuer)
  if (known?.clientId.trim()) {
    return { kind: "dynamic", clientId: known.clientId, ...(known.clientSecret ? { clientSecret: known.clientSecret } : {}) }
  }
  const response = await safeFetch(input.fetch, endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input.port.clientMetadata),
  })
  // RFC 7591 §3.2.1 answers 201; a 200 is common in the wild and equally usable.
  if (!response.ok) throw new Error(`dynamic client registration failed with ${response.status}`)
  const raw = await boundedJson(response)
  if (!record(raw) || typeof raw.client_id !== "string" || !raw.client_id.trim()) {
    throw new Error("dynamic client registration response carries no client_id")
  }
  // The registry, not this function, decides which client wins a race and
  // where an issued secret lives; whatever it returns is the durable answer.
  const stored = await input.port.register({
    issuer: input.issuer,
    registrationEndpoint: endpoint.toString(),
    metadata: raw,
  })
  if (!stored.clientId.trim()) throw new Error("dynamic client registration was not persisted")
  return { kind: "dynamic", clientId: stored.clientId, ...(stored.clientSecret ? { clientSecret: stored.clientSecret } : {}) }
}

async function registration(input: {
  fetch: Fetch
  issuer: string
  metadata: Record<string, unknown>
  preRegistered?: Readonly<Record<string, { clientId: string; clientSecret?: string }>>
  clientIdMetadataDocumentUrl?: string
  dynamicRegistration?: McpOAuthDynamicRegistrationPort
}): Promise<McpOAuthClientRegistration | undefined> {
  const configured = input.preRegistered?.[input.issuer]
  if (configured?.clientId.trim()) return { kind: "pre-registered", clientId: configured.clientId, ...(configured.clientSecret ? { clientSecret: configured.clientSecret } : {}) }
  const document = input.clientIdMetadataDocumentUrl ? safeEndpoint(input.clientIdMetadataDocumentUrl) : undefined
  if (document && input.metadata.client_id_metadata_document_supported === true) {
    return { kind: "client-id-metadata-document", clientId: document.toString() }
  }
  if (!input.dynamicRegistration) return undefined
  return dynamicRegistration({
    fetch: input.fetch,
    issuer: input.issuer,
    metadata: input.metadata,
    port: input.dynamicRegistration,
  })
}

async function discoverAuthorizationServer(input: {
  fetch: Fetch
  resource: URL
  resourceMetadataUrl: string
  issuer: string
  scopes: string[]
  preRegistered?: Readonly<Record<string, { clientId: string; clientSecret?: string }>>
  clientIdMetadataDocumentUrl?: string
  dynamicRegistration?: McpOAuthDynamicRegistrationPort
}): Promise<McpOAuthDiscovery> {
  const issuerUrl = safeEndpoint(input.issuer)
  if (!issuerUrl) throw new Error(`Authorization server ${input.issuer} is unsafe`)
  const authorizationMetadata = await firstMetadata(input.fetch, authorizationMetadataCandidates(issuerUrl))
  if (!authorizationMetadata) throw new Error(`Authorization server metadata is unavailable for ${input.issuer}`)
  if (authorizationMetadata.raw.issuer !== input.issuer) {
    throw new Error(`Authorization server metadata issuer does not exactly match ${input.issuer}`)
  }
  const authorizationEndpoint = typeof authorizationMetadata.raw.authorization_endpoint === "string"
    ? safeEndpoint(authorizationMetadata.raw.authorization_endpoint)
    : undefined
  const tokenEndpoint = typeof authorizationMetadata.raw.token_endpoint === "string"
    ? safeEndpoint(authorizationMetadata.raw.token_endpoint)
    : undefined
  if (!authorizationEndpoint || !tokenEndpoint) throw new Error("authorization server endpoints are unsafe or missing")
  if (!stringArray(authorizationMetadata.raw.code_challenge_methods_supported).includes("S256")) {
    throw new McpOAuthDiscoveryError("pkce-unsupported", `Authorization server ${input.issuer} does not advertise PKCE S256`)
  }
  const client = await registration({
    fetch: input.fetch,
    issuer: input.issuer,
    metadata: authorizationMetadata.raw,
    preRegistered: input.preRegistered,
    clientIdMetadataDocumentUrl: input.clientIdMetadataDocumentUrl,
    dynamicRegistration: input.dynamicRegistration,
  })
  if (!client) {
    throw new McpOAuthDiscoveryError(
      "unsupported-client-registration",
      `No supported OAuth client registration exists for ${input.issuer}`,
    )
  }
  return {
    resource: input.resource.toString(),
    resourceMetadataUrl: input.resourceMetadataUrl,
    issuer: input.issuer,
    authorizationEndpoint: authorizationEndpoint.toString(),
    tokenEndpoint: tokenEndpoint.toString(),
    authorizationResponseIssuerParameterSupported: authorizationMetadata.raw.authorization_response_iss_parameter_supported === true,
    scopes: input.scopes,
    client,
  }
}

/**
 * MCP 2026 protected-resource and authorization-server discovery.
 *
 * Client registration is resolved in one fixed order: a deployment-configured
 * pre-registered client, then a client-id metadata document when the
 * authorization server advertises support, then RFC 7591 dynamic registration
 * when the server advertises a registration endpoint AND the caller supplied
 * the persistence port. Without that port there is no DCR fallback.
 */
export async function discoverMcpOAuth(input: {
  resourceUrl: string
  fetch: Fetch
  selectedIssuer?: string
  requiredScopes?: readonly string[]
  preRegistered?: Readonly<Record<string, { clientId: string; clientSecret?: string }>>
  clientIdMetadataDocumentUrl?: string
  dynamicRegistration?: McpOAuthDynamicRegistrationPort
}): Promise<McpOAuthDiscoveryResult> {
  const resource = safeEndpoint(input.resourceUrl, { loopback: true })
  if (!resource) throw new McpOAuthDiscoveryError("invalid-resource", "MCP resource URL is unsafe")
  try {
    const probe = await safeFetch(input.fetch, resource, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "claxedo-oauth-discovery", method: "initialize", params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "Claxedo", version: "1" } } }),
    })
    if (probe.status !== 401) {
      if (probe.ok) return { status: "public" }
      throw new Error(`MCP resource probe failed with ${probe.status}`)
    }
    const challenge = bearerChallenge(probe.headers.get("www-authenticate"))
    const resourceMetadata = await firstMetadata(input.fetch, protectedResourceCandidates(resource, challenge.metadata))
    if (!resourceMetadata) throw new Error("protected resource metadata is unavailable")
    const canonicalResource = typeof resourceMetadata.raw.resource === "string" ? safeEndpoint(resourceMetadata.raw.resource, { loopback: true }) : undefined
    if (!canonicalResource || !resourceIdentifies(canonicalResource, resource)) {
      throw new Error("protected resource metadata does not identify the MCP resource")
    }
    const issuers = stringArray(resourceMetadata.raw.authorization_servers).filter((value) => !!safeEndpoint(value))
    if (!issuers.length) throw new Error("protected resource metadata advertises no safe authorization server")
    const challengeScopes = challenge.scopes ?? []
    const resourceScopes = stringArray(resourceMetadata.raw.scopes_supported)
    const requiredScopes = [...new Set([...(input.requiredScopes ?? []), ...(challengeScopes.length ? challengeScopes : resourceScopes)])]
    const discoverIssuer = (issuer: string) => discoverAuthorizationServer({
      fetch: input.fetch,
      resource,
      resourceMetadataUrl: resourceMetadata.url,
      issuer,
      scopes: requiredScopes,
      ...(input.preRegistered ? { preRegistered: input.preRegistered } : {}),
      ...(input.clientIdMetadataDocumentUrl
        ? { clientIdMetadataDocumentUrl: input.clientIdMetadataDocumentUrl }
        : {}),
      ...(input.dynamicRegistration ? { dynamicRegistration: input.dynamicRegistration } : {}),
    })
    if (input.selectedIssuer) {
      if (!issuers.includes(input.selectedIssuer)) {
        throw new McpOAuthDiscoveryError("ambiguous-issuer", "Selected authorization server is not advertised by the MCP resource")
      }
      return { status: "protected", discovery: await discoverIssuer(input.selectedIssuer) }
    }
    if (issuers.length === 1) return { status: "protected", discovery: await discoverIssuer(issuers[0]) }

    const supported = (await Promise.all(issuers.map(async (issuer) => {
      try {
        return { issuer, discovery: await discoverIssuer(issuer) }
      } catch {
        return undefined
      }
    }))).filter((value): value is { issuer: string; discovery: McpOAuthDiscovery } => value !== undefined)
    if (supported.length === 1) return { status: "protected", discovery: supported[0].discovery }
    if (supported.length > 1) {
      const choices = supported.map(({ issuer }) => issuer)
      throw new McpOAuthDiscoveryError(
        "ambiguous-issuer",
        `Choose one authorization server: ${choices.join(", ")}`,
        choices,
      )
    }
    throw new McpOAuthDiscoveryError(
      "unsupported-client-registration",
      "No advertised authorization server supports the configured Claxedo OAuth client",
    )
  } catch (cause) {
    if (cause instanceof McpOAuthDiscoveryError) throw cause
    throw new McpOAuthDiscoveryError("discovery-failed", cause instanceof Error ? cause.message : String(cause))
  }
}
