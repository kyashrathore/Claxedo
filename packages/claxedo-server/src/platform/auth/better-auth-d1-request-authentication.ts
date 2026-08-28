import {
  AuthenticationError,
  createControlPlaneAuthenticationAdapter,
  type ApplicationIdentityResolver,
  type AuthAdapterDescriptor,
  type AuthAssurance,
  type AuthenticationEvidenceMethod,
  type RequestAuthenticationAdapter,
  type VerifiedAuthSession,
} from "@claxedo/server-core/platform/auth/authentication"

type BetterAuthApiSurface = {
  getSession(input: {
    headers: Headers
    query: { disableCookieCache: true; disableRefresh: true }
  }): Promise<unknown>
  oauth2Introspect(input: {
    body: {
      client_id: string
      client_secret: string
      token: string
      token_type_hint: "access_token"
    }
  }): Promise<unknown>
}

type BetterAuthAuthenticationEvidence = {
  sessionId?: string
  authenticatedAt?: number
  methods: readonly AuthenticationEvidenceMethod[]
  assurance?: AuthAssurance
}

export type BetterAuthAuthenticationEvidenceInput =
  | {
      kind: "browser"
      subject: string
      providerSessionId: string
      providerSessionCreatedAt: number
      providerResult: unknown
    }
  | {
      kind: "cli" | "desktop"
      subject: string
      providerSessionId?: string
      accessToken: string
      issuedAt?: number
      providerResult: unknown
    }

export type BetterAuthAuthenticationEvidenceResolver = (
  input: BetterAuthAuthenticationEvidenceInput,
) => Promise<BetterAuthAuthenticationEvidence>

export type BetterAuthD1RequestAuthenticationInput = {
  descriptor: AuthAdapterDescriptor & {
    adapter: "better-auth"
    browser: Extract<AuthAdapterDescriptor["browser"], { transport: "cookie" }>
  }
  /** The `api` property of the configured Better Auth instance. */
  auth: { api: BetterAuthApiSurface }
  /** Server-held OAuth client used only for RFC 7662 introspection. */
  nativeIntrospectionClient: {
    clientId: string
    clientSecret: string
  }
  /** Reads persisted sign-in evidence. Available account methods are not authentication evidence. */
  resolveAuthenticationEvidence: BetterAuthAuthenticationEvidenceResolver
  /** Maps the Better Auth subject to an existing application-owned user and actor. */
  resolveIdentity: ApplicationIdentityResolver
  now?: () => number
  maxFutureSkewMs?: number
}

function invalidCredentials(): AuthenticationError {
  return new AuthenticationError(401, "invalid_credentials", "Authentication credential is invalid")
}

function present(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidCredentials()
  return value as Record<string, unknown>
}

function exactCookiePresent(request: Request, name: string): boolean {
  return (request.headers.get("cookie") ?? "")
    .split(";")
    .some((part) => {
      const value = part.trim()
      const separator = value.indexOf("=")
      return separator > 0 && value.slice(0, separator) === name
    })
}

function opaqueBearer(request: Request): string | undefined {
  const value = request.headers.get("authorization")
  if (value === null) return undefined
  const match = /^Bearer ([^\s,]+)$/i.exec(value)
  if (!match?.[1]) throw invalidCredentials()
  return match[1]
}

function timestamp(value: unknown): number {
  const result = value instanceof Date
    ? value.getTime()
    : typeof value === "string" || typeof value === "number"
      ? new Date(value).getTime()
      : Number.NaN
  if (!Number.isFinite(result) || result <= 0) throw invalidCredentials()
  return result
}

function secondsTimestamp(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw invalidCredentials()
  return value * 1_000
}

function scopeList(value: unknown): string[] {
  if (!present(value)) throw invalidCredentials()
  const scopes = value.trim().split(/\s+/)
  if (scopes.length === 0 || new Set(scopes).size !== scopes.length) throw invalidCredentials()
  return scopes
}

function audienceIncludesOnly(value: unknown, expected: string): boolean {
  const values = typeof value === "string"
    ? [value]
    : Array.isArray(value) && value.every(present)
      ? value
      : []
  return values.length > 0 && values.every((entry) => entry === expected)
}

function requestOrigin(request: Request): string {
  const supplied = request.headers.get("origin")
  if (supplied !== null) return supplied
  return new URL(request.url).origin
}

function browserVerifiedSession(
  request: Request,
  descriptor: BetterAuthD1RequestAuthenticationInput["descriptor"],
  providerResult: unknown,
  evidence: BetterAuthAuthenticationEvidence,
): VerifiedAuthSession {
  const result = record(providerResult)
  const user = record(result.user)
  const session = record(result.session)
  if (!present(user.id) || !present(session.id)) throw invalidCredentials()
  const createdAt = timestamp(session.createdAt)

  return {
    adapter: "better-auth",
    issuer: descriptor.issuer,
    subject: user.id,
    sessionId: session.id,
    authenticatedAt: createdAt,
    methods: evidence.methods,
    assurance: evidence.assurance,
    client: {
      kind: "browser",
      tokenKind: "browser-session",
      id: descriptor.browser.clientId,
      resource: descriptor.browser.resource,
      scopes: descriptor.browser.scopes,
      origin: requestOrigin(request),
    },
  }
}

function nativeClient(
  descriptor: BetterAuthD1RequestAuthenticationInput["descriptor"],
  value: unknown,
) {
  if (value === descriptor.native.cli.clientId) return { kind: "cli" as const, descriptor: descriptor.native.cli }
  if (value === descriptor.native.desktop.clientId) {
    return { kind: "desktop" as const, descriptor: descriptor.native.desktop }
  }
  throw invalidCredentials()
}

async function verifyBrowser(
  input: BetterAuthD1RequestAuthenticationInput,
  request: Request,
): Promise<VerifiedAuthSession> {
  const providerResult = await input.auth.api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true, disableRefresh: true },
  })
  const result = record(providerResult)
  const user = record(result.user)
  const session = record(result.session)
  if (!present(user.id) || !present(session.id)) throw invalidCredentials()
  const createdAt = timestamp(session.createdAt)
  const evidence = await input.resolveAuthenticationEvidence({
    kind: "browser",
    subject: user.id,
    providerSessionId: session.id,
    providerSessionCreatedAt: createdAt,
    providerResult,
  })
  return browserVerifiedSession(request, input.descriptor, providerResult, evidence)
}

async function verifyNative(
  input: BetterAuthD1RequestAuthenticationInput,
  accessToken: string,
): Promise<VerifiedAuthSession> {
  const providerResult = await input.auth.api.oauth2Introspect({
    body: {
      client_id: input.nativeIntrospectionClient.clientId,
      client_secret: input.nativeIntrospectionClient.clientSecret,
      token: accessToken,
      token_type_hint: "access_token",
    },
  })
  const result = record(providerResult)
  if (result.active !== true || result.iss !== input.descriptor.issuer || result.token_type !== "Bearer") {
    throw invalidCredentials()
  }
  if (!present(result.sub)) throw invalidCredentials()
  const selected = nativeClient(input.descriptor, result.client_id)
  if (!audienceIncludesOnly(result.aud, selected.descriptor.resource)) throw invalidCredentials()
  const scopes = scopeList(result.scope)
  const issuedAt = secondsTimestamp(result.iat)
  const providerSessionId = result.sid === undefined
    ? undefined
    : present(result.sid)
      ? result.sid
      : (() => { throw invalidCredentials() })()

  const evidence = await input.resolveAuthenticationEvidence({
    kind: selected.kind,
    subject: result.sub,
    providerSessionId,
    accessToken,
    issuedAt,
    providerResult,
  })
  if (!present(evidence.sessionId) || typeof evidence.authenticatedAt !== "number") throw invalidCredentials()
  if (providerSessionId && evidence.sessionId !== providerSessionId) throw invalidCredentials()

  return {
    adapter: "better-auth",
    issuer: input.descriptor.issuer,
    subject: result.sub,
    sessionId: evidence.sessionId,
    authenticatedAt: evidence.authenticatedAt,
    methods: evidence.methods,
    assurance: evidence.assurance,
    client: {
      kind: selected.kind,
      tokenKind: "access-token",
      id: selected.descriptor.clientId,
      resource: selected.descriptor.resource,
      scopes,
      deploymentId: input.descriptor.deploymentId,
      adapter: "better-auth",
      issuer: input.descriptor.issuer,
      tokenEndpointOrigin: selected.descriptor.tokenEndpointOrigin,
      controlPlaneOrigin: selected.descriptor.controlPlaneOrigin,
    },
  }
}

function assertComposition(input: BetterAuthD1RequestAuthenticationInput) {
  if (!present(input.nativeIntrospectionClient.clientId) || !present(input.nativeIntrospectionClient.clientSecret)) {
    throw new AuthenticationError(
      503,
      "auth_configuration_invalid",
      "Better Auth native introspection client is not configured",
    )
  }
}

/**
 * Composes one Better Auth instance with the provider-neutral request boundary.
 * Verification never creates users: application identity is resolved only by
 * the injected application-owned mapping.
 */
export function createBetterAuthD1RequestAuthenticationAdapter(
  input: BetterAuthD1RequestAuthenticationInput,
): RequestAuthenticationAdapter {
  assertComposition(input)
  return createControlPlaneAuthenticationAdapter({
    descriptor: input.descriptor,
    resolveIdentity: input.resolveIdentity,
    now: input.now,
    maxFutureSkewMs: input.maxFutureSkewMs,
    async verify(request) {
      const cookie = exactCookiePresent(request, input.descriptor.browser.cookie.name)
      const bearer = opaqueBearer(request)
      if (cookie) return verifyBrowser(input, request)
      if (bearer) return verifyNative(input, bearer)
      throw invalidCredentials()
    },
  })
}
