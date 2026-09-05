import type { McpOAuthDiscovery, McpOAuthDynamicClient } from "./discovery"

type Fetch = (url: string, init?: RequestInit) => Promise<Response>
type OAuthTokens = { accessToken: string; refreshToken?: string; expiresAt?: number; fields?: Record<string, string> }
export type McpOAuthIntegration = {
  decl: {
    id: string
    name: string
    methods: ["oauth"]
    capabilities: ["mcp"]
  }
  impl: {
    canonicalFields: readonly string[]
    attemptContext: Readonly<Record<string, string>>
    authorize(state: string, verifier: string): Promise<URL>
    callback(code: string, verifier: string, context?: Readonly<Record<string, string>>, response?: { issuer?: string }): Promise<OAuthTokens>
    refresh(refreshToken: string): Promise<OAuthTokens>
  }
}
const encoder = new TextEncoder()
const CONNECTION_FIELDS = [
  ["resource", "MCP resource"],
  ["issuer", "Authorization server"],
  ["authorization_endpoint", "Authorization endpoint"],
  ["token_endpoint", "Token endpoint"],
  ["client_kind", "OAuth client kind"],
  ["client_id", "OAuth client ID"],
  ["callback_url", "OAuth callback"],
  ["scopes", "OAuth scopes"],
  ["response_iss_required", "Authorization response issuer requirement"],
] as const

const canonicalFields = CONNECTION_FIELDS.map(([id]) => id)

function base64Url(bytes: Uint8Array) {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export async function mcpOAuthIntegrationId(input: { pluginInstanceId: string; serverName: string }) {
  const identity = JSON.stringify([input.pluginInstanceId, input.serverName])
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(identity)))
  return `mcp-${base64Url(digest)}`
}

export async function mcpOAuthDeclaration(input: { pluginInstanceId: string; serverName: string }) {
  return {
    id: await mcpOAuthIntegrationId(input),
    name: `${input.serverName} MCP`,
    methods: ["oauth"] as ["oauth"],
    capabilities: ["mcp"] as ["mcp"],
  }
}

function context(discovery: McpOAuthDiscovery, callbackUrl: string) {
  const scopes = discovery.scopes.join(" ")
  return {
    resource: discovery.resource,
    issuer: discovery.issuer,
    authorization_endpoint: discovery.authorizationEndpoint,
    token_endpoint: discovery.tokenEndpoint,
    client_kind: discovery.client.kind,
    client_id: discovery.client.clientId,
    callback_url: callbackUrl,
    ...(scopes ? { scopes } : {}),
    response_iss_required: discovery.authorizationResponseIssuerParameterSupported ? "true" : "false",
  }
}

function exactContext(value: Readonly<Record<string, string>> | undefined, expected: Record<string, string>) {
  const byKey = ([left]: [string, string], [right]: [string, string]) => left.localeCompare(right)
  return value && JSON.stringify(Object.entries(value).toSorted(byKey)) === JSON.stringify(Object.entries(expected).toSorted(byKey))
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

async function challenge(verifier: string) {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))))
}

async function tokens(response: Response, now: () => number = Date.now): Promise<OAuthTokens> {
  if (!response.ok) throw new Error(`OAuth token endpoint rejected the request with ${response.status}`)
  const raw = await response.json() as unknown
  if (!record(raw)) throw new Error("OAuth token response is invalid")
  const value = raw
  if (typeof value.access_token !== "string"
    || !value.access_token
    || (value.token_type !== undefined
      && (typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer"))) {
    throw new Error("OAuth token response has no Bearer access token")
  }
  return {
    accessToken: value.access_token,
    ...(typeof value.refresh_token === "string" ? { refreshToken: value.refresh_token } : {}),
    ...(typeof value.expires_in === "number" && Number.isFinite(value.expires_in) && value.expires_in > 0
      ? { expiresAt: now() + value.expires_in * 1_000 }
      : {}),
  }
}

/** Dynamic Connections integration for one exact retained plugin/server/resource/issuer identity. */
export async function createMcpOAuthIntegration(input: {
  pluginInstanceId: string
  serverName: string
  discovery: McpOAuthDiscovery
  callbackUrl: string
  fetch: Fetch
  now?: () => number
}): Promise<McpOAuthIntegration> {
  const id = await mcpOAuthIntegrationId(input)
  const frozen = context(input.discovery, input.callbackUrl)
  // A client-id metadata document identity has no secret by construction; the
  // other two kinds carry one only when the authorization server issued it.
  const clientSecret = input.discovery.client.kind === "client-id-metadata-document"
    ? undefined
    : input.discovery.client.clientSecret
  const clientAuth = (body: URLSearchParams) => {
    body.set("client_id", frozen.client_id)
    if (clientSecret) body.set("client_secret", clientSecret)
  }
  return {
    decl: {
      id,
      name: `${input.serverName} MCP`,
      methods: ["oauth"],
      capabilities: ["mcp"],
    },
    impl: {
      canonicalFields,
      attemptContext: frozen,
      async authorize(state, verifier) {
        const url = new URL(frozen.authorization_endpoint)
        url.searchParams.set("response_type", "code")
        url.searchParams.set("client_id", frozen.client_id)
        url.searchParams.set("redirect_uri", frozen.callback_url)
        url.searchParams.set("state", state)
        url.searchParams.set("code_challenge_method", "S256")
        url.searchParams.set("code_challenge", await challenge(verifier))
        url.searchParams.set("resource", frozen.resource)
        if (frozen.scopes) url.searchParams.set("scope", frozen.scopes)
        return url
      },
      async callback(code, verifier, attempt, response) {
        if (!exactContext(attempt, frozen)) throw new Error("MCP OAuth attempt no longer matches the retained server")
        if (response?.issuer !== undefined && response.issuer !== frozen.issuer) throw new Error("MCP OAuth authorization response issuer mismatch")
        if (frozen.response_iss_required === "true" && response?.issuer === undefined) throw new Error("MCP OAuth authorization response omitted its required issuer")
        const body = new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: frozen.callback_url,
          resource: frozen.resource,
        })
        clientAuth(body)
        const result = await tokens(await input.fetch(frozen.token_endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body,
        }), input.now)
        return { ...result, fields: { ...frozen } }
      },
      async refresh(refreshToken) {
        const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, resource: frozen.resource })
        if (frozen.scopes) body.set("scope", frozen.scopes)
        clientAuth(body)
        return tokens(await input.fetch(frozen.token_endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body,
        }), input.now)
      },
    },
  }
}

function attemptDiscovery(value: Readonly<Record<string, string>>): McpOAuthDiscovery | undefined {
  const kind = value.client_kind
  if (kind !== "pre-registered" && kind !== "client-id-metadata-document" && kind !== "dynamic") return undefined
  const responseIss = value.response_iss_required
  if (responseIss !== "true" && responseIss !== "false") return undefined
  try {
    const resource = new URL(value.resource)
    const issuer = new URL(value.issuer)
    const authorizationEndpoint = new URL(value.authorization_endpoint)
    const tokenEndpoint = new URL(value.token_endpoint)
    const callback = new URL(value.callback_url)
    const resourceLoopback = resource.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(resource.hostname)
    if (!(resource.protocol === "https:" || resourceLoopback) || issuer.protocol !== "https:" || authorizationEndpoint.protocol !== "https:" || tokenEndpoint.protocol !== "https:") return undefined
    if (callback.protocol !== "https:" && !(callback.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname))) return undefined
    if (!value.client_id) return undefined
    return {
      resource: value.resource,
      resourceMetadataUrl: "attempt:frozen",
      issuer: value.issuer,
      authorizationEndpoint: value.authorization_endpoint,
      tokenEndpoint: value.token_endpoint,
      authorizationResponseIssuerParameterSupported: responseIss === "true",
      scopes: value.scopes ? value.scopes.split(" ").filter(Boolean) : [],
      // No secret is ever read back from the attempt: a durable attempt row is
      // public-ish metadata. The pre-registered secret comes from configuration
      // and the dynamic one from the client registry, both below.
      client: { kind, clientId: value.client_id },
    }
  } catch {
    return undefined
  }
}

/** Reconstructs only the callback/refresh side from a durable, frozen attempt. */
export async function createMcpOAuthIntegrationFromAttempt(input: {
  integrationId: string
  serverName: string
  attemptContext: Readonly<Record<string, string>>
  fetch: Fetch
  preRegistered?: Readonly<Record<string, { clientId: string; clientSecret?: string }>>
  /** Resolves the deployment's dynamically registered client for an issuer. */
  dynamicRegistration?: { lookup(issuer: string): Promise<McpOAuthDynamicClient | undefined> }
  now?: () => number
}): Promise<McpOAuthIntegration> {
  const discovery = attemptDiscovery(input.attemptContext)
  if (!discovery) throw new Error("MCP OAuth attempt context is invalid")
  if (discovery.client.kind === "pre-registered") {
    const configured = input.preRegistered?.[discovery.issuer]
    if (!configured || configured.clientId !== discovery.client.clientId) {
      throw new Error("MCP OAuth pre-registration no longer matches the attempt")
    }
    discovery.client = { ...discovery.client, ...(configured.clientSecret ? { clientSecret: configured.clientSecret } : {}) }
  }
  if (discovery.client.kind === "dynamic") {
    // Same re-validation the pre-registered path performs, against the registry
    // instead of configuration: the attempt names a client id, and only the one
    // this deployment actually holds for that issuer may be presented.
    const registered = await input.dynamicRegistration?.lookup(discovery.issuer)
    if (!registered || registered.clientId !== discovery.client.clientId) {
      throw new Error("MCP OAuth dynamic registration no longer matches the attempt")
    }
    discovery.client = { ...discovery.client, ...(registered.clientSecret ? { clientSecret: registered.clientSecret } : {}) }
  }
  const built = await createMcpOAuthIntegration({
    pluginInstanceId: "callback",
    serverName: input.serverName,
    discovery,
    callbackUrl: input.attemptContext.callback_url,
    fetch: input.fetch,
    ...(input.now ? { now: input.now } : {}),
  })
  return { ...built, decl: { ...built.decl, id: input.integrationId } }
}
