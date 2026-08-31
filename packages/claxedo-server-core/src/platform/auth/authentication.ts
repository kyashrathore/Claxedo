/** Provider-neutral authentication contracts for hosted control planes. */

export const AUTH_ADAPTERS = ["better-auth", "clerk"] as const
export const AUTH_CLIENT_KINDS = ["browser", "cli", "desktop"] as const
export const AUTH_ASSURANCE_LEVELS = ["insufficient", "single-factor", "multi-factor", "phishing-resistant"] as const
export const INTERACTIVE_AUTH_METHODS = ["google", "github", "email-password", "clerk"] as const
export const AUTHENTICATION_EVIDENCE_METHODS = [
  "oauth:google",
  "oauth:github",
  "password",
  "totp",
  "passkey",
  "recovery",
  "clerk",
] as const

export type AuthAdapterId = (typeof AUTH_ADAPTERS)[number]
export type AuthClientKind = (typeof AUTH_CLIENT_KINDS)[number]
export type AuthAssurance = (typeof AUTH_ASSURANCE_LEVELS)[number]
export type InteractiveAuthMethod = (typeof INTERACTIVE_AUTH_METHODS)[number]
export type AuthenticationEvidenceMethod = (typeof AUTHENTICATION_EVIDENCE_METHODS)[number]

export type AuthIdentity = {
  adapter: AuthAdapterId
  issuer: string
  subject: string
}

type CommonAuthClientBinding = {
  id: string
  resource: string
  scopes: readonly string[]
}

export type BrowserAuthClientBinding = CommonAuthClientBinding & {
  kind: "browser"
  tokenKind: "browser-session"
  origin: string
}

/** Immutable tuple persisted with every native credential and registry row. */
export type NativeCredentialBinding = CommonAuthClientBinding & {
  kind: "cli" | "desktop"
  tokenKind: "access-token"
  deploymentId: string
  adapter: AuthAdapterId
  issuer: string
  tokenEndpointOrigin: string
  controlPlaneOrigin: string
}

export type AuthClientBinding = BrowserAuthClientBinding | NativeCredentialBinding

/**
 * Provider output before application identity mapping. This is documentation
 * for adapter authors; the request boundary receives `unknown` and validates
 * every field before constructing a principal.
 */
export type VerifiedAuthSession = AuthIdentity & {
  sessionId: string
  authenticatedAt: number
  methods: readonly AuthenticationEvidenceMethod[]
  assurance?: AuthAssurance
  client: AuthClientBinding
}

export type ControlPlanePrincipal = {
  userId: string
  actorId: string
  actorKind: "human"
  deploymentId: string
  sessionId: string
  authenticatedAt: number
  methods: readonly AuthenticationEvidenceMethod[]
  assurance: AuthAssurance
  client: AuthClientBinding
  identity: AuthIdentity
}

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

export type ReauthenticationChallenge = {
  code: "reauthentication_required"
  requiredAssurance: Exclude<AuthAssurance, "insufficient">
  methods: readonly InteractiveAuthMethod[]
  expiresAt: number
}

export type NativeAuthorizationPending = {
  state: "pending"
  binding: NativeCredentialBinding
  authorizationUri: string
  userCode?: string
  deviceCode?: string
  expiresAt: number
  pollingIntervalSeconds?: number
}

export type NativeCredentialSet = {
  state: "authorized"
  binding: NativeCredentialBinding
  sessionId: string
  accessToken: string
  accessTokenExpiresAt: number
  refreshToken: string
  refreshTokenExpiresAt: number
}

export type NativeAuthorizationPort = {
  issue(input: {
    binding: NativeCredentialBinding
    redirectUri?: string
    pkceChallenge?: string
    state?: string
  }): Promise<NativeAuthorizationPending | NativeCredentialSet>
  refresh(input: {
    binding: NativeCredentialBinding
    sessionId: string
    refreshToken: string
  }): Promise<NativeCredentialSet>
  revoke(input: {
    binding: NativeCredentialBinding
    sessionId: string
    token: string
    tokenKind: "access-token" | "refresh-token"
  }): Promise<{ revokedAt: number }>
}

export type AuthAccountOperationKind = "disable-account" | "revoke-all-sessions" | "delete-account"
export type AuthAccountOperationStatus =
  | { state: "pending"; operationId: string; kind: AuthAccountOperationKind }
  | { state: "completed"; operationId: string; kind: AuthAccountOperationKind; completedAt: number }
  | { state: "retryable-failure"; operationId: string; kind: AuthAccountOperationKind; retryAfterMs: number }
  | { state: "terminal-failure"; operationId: string; kind: AuthAccountOperationKind; code: string }

export type AuthAccountLifecycle = {
  disableAccount(input: { operationId: string; userId: string; reason: string }): Promise<AuthAccountOperationStatus>
  revokeAllSessions(input: { operationId: string; userId: string }): Promise<AuthAccountOperationStatus>
  /** Terminal: a deleted account cannot be restored or reprovisioned. */
  deleteAccount(input: { operationId: string; userId: string }): Promise<AuthAccountOperationStatus>
  operationStatus(operationId: string): Promise<AuthAccountOperationStatus>
}

export type RequestAuthenticationAdapter = {
  descriptor: AuthAdapterDescriptor
  authenticate(request: Request): Promise<ControlPlanePrincipal>
}

/**
 * Provider verification without application-account mapping.
 *
 * This narrow boundary is reserved for explicit enrollment flows. Ordinary
 * product requests must use `RequestAuthenticationAdapter.authenticate`, which
 * also requires an active application principal.
 */
export type RequestIdentityVerificationAdapter = {
  descriptor: AuthAdapterDescriptor
  verifyIdentity(request: Request): Promise<AuthIdentity>
}

export type HostedAuthAdapter = RequestAuthenticationAdapter & {
  reauthentication(input: {
    principal: ControlPlanePrincipal
    requiredAssurance: Exclude<AuthAssurance, "insufficient">
  }): Promise<ReauthenticationChallenge>
  native: NativeAuthorizationPort
  accounts: AuthAccountLifecycle
}

export class AuthenticationError extends Error {
  constructor(
    public readonly status: 401 | 403 | 503,
    public readonly code:
      | "invalid_credentials"
      | "ambiguous_credentials"
      | "insufficient_assurance"
      | "auth_unavailable"
      | "auth_configuration_invalid"
      | "identity_provisioning"
      | "account_suspended"
      | "account_deleted",
    message: string,
  ) {
    super(message)
    this.name = "AuthenticationError"
  }
}

export type ApplicationIdentityResolution =
  | { state: "active"; userId: string; actorId: string }
  | { state: "provisioning"; retryAfterMs: number }
  | { state: "suspended" }
  | { state: "deleted" }
  | { state: "unavailable"; retryAfterMs?: number }

export type ApplicationIdentityResolver = (
  identity: AuthIdentity,
  /** Original verified request, used only by explicit deployment bootstrap policies. */
  request?: Request,
) => Promise<ApplicationIdentityResolution>

function present(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isOneOf<const T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value)
}

function invalidCredentials(): AuthenticationError {
  return new AuthenticationError(401, "invalid_credentials", "Authentication credential is invalid")
}

function exactStringArray(value: unknown, allowed?: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length === 0) throw invalidCredentials()
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!present(item) || seen.has(item) || (allowed && !allowed.includes(item))) throw invalidCredentials()
    seen.add(item)
    result.push(item)
  }
  return result
}

function assertUniqueConfiguredStrings(value: readonly string[], message: string) {
  if (value.length === 0 || value.some((entry) => !present(entry)) || new Set(value).size !== value.length) {
    throw new AuthenticationError(503, "auth_configuration_invalid", message)
  }
}

function assertClientDescriptor(
  name: "browser" | "cli" | "desktop",
  value: { clientId: string; resource: string; scopes: readonly string[] },
) {
  if (!present(value.clientId) || !present(value.resource)) {
    throw new AuthenticationError(
      503,
      "auth_configuration_invalid",
      `${name === "browser" ? "Browser auth client" : `Native auth client ${name}`} requires clientId, resource, and at least one scope`,
    )
  }
  assertUniqueConfiguredStrings(
    value.scopes,
    `${name === "browser" ? "Browser auth client" : `Native auth client ${name}`} requires unique non-empty scopes`,
  )
}

function assertNativeRevocationDescriptor(name: "cli" | "desktop", value: unknown, tokenEndpointOrigin: string) {
  if (
    !isRecord(value) ||
    !isOneOf(value.protocol, ["rfc7009", "adapter-native"] as const) ||
    !present(value.endpoint) ||
    !isExactHttpsUrl(value.endpoint) ||
    new URL(value.endpoint).origin !== tokenEndpointOrigin ||
    (value.protocol === "rfc7009" && value.tokenEndpointAuthMethod !== "none")
  ) {
    throw new AuthenticationError(
      503,
      "auth_configuration_invalid",
      `Native auth client ${name} revocation contract is invalid`,
    )
  }
}

function isExactHttpsOrigin(value: string) {
  try {
    const url = new URL(value)
    return (
      url.protocol === "https:" &&
      url.origin === value &&
      !url.hostname.includes("*") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    )
  } catch {
    return false
  }
}

function isExactHttpsUrl(value: string) {
  try {
    const url = new URL(value)
    const normalized = `${url.origin}${url.pathname === "/" ? "" : url.pathname}`
    return (
      url.protocol === "https:" &&
      value === normalized &&
      !url.hostname.includes("*") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    )
  } catch {
    return false
  }
}

function assertDescriptor(descriptor: AuthAdapterDescriptor, now: number) {
  if (
    !isOneOf(descriptor.adapter, AUTH_ADAPTERS) ||
    !present(descriptor.deploymentId) ||
    !present(descriptor.configurationVersion) ||
    !isExactHttpsUrl(descriptor.issuer) ||
    !Number.isFinite(descriptor.expiresAt) ||
    descriptor.expiresAt <= now ||
    descriptor.browser.trustedOrigins.length === 0
  ) {
    throw new AuthenticationError(503, "auth_configuration_invalid", "Authentication descriptor is incomplete")
  }
  assertUniqueConfiguredStrings(descriptor.methods, "Authentication methods must be unique and non-empty")
  if (descriptor.methods.some((method) => !isOneOf(method, INTERACTIVE_AUTH_METHODS))) {
    throw new AuthenticationError(
      503,
      "auth_configuration_invalid",
      "Authentication descriptor contains an unknown method",
    )
  }
  if (descriptor.browser.trustedOrigins.some((origin) => !isExactHttpsOrigin(origin))) {
    throw new AuthenticationError(
      503,
      "auth_configuration_invalid",
      "browser.trustedOrigins must contain exact HTTPS origins",
    )
  }
  assertClientDescriptor("browser", descriptor.browser)

  if (descriptor.browser.transport === "cookie") {
    const cookie = descriptor.browser.cookie
    if (
      descriptor.browser.credentialPolicy !== "reject-cookie-and-authorization" ||
      !present(cookie?.name) ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name) ||
      cookie.path !== "/" ||
      cookie.secure !== true ||
      cookie.httpOnly !== true ||
      cookie.hostOnly !== true ||
      (cookie.sameSite !== "lax" && cookie.sameSite !== "strict")
    ) {
      throw new AuthenticationError(503, "auth_configuration_invalid", "Cookie authentication posture is insecure")
    }
  } else if (
    descriptor.browser.transport !== "bearer" ||
    descriptor.browser.credentialPolicy !== "authorization-only"
  ) {
    throw new AuthenticationError(503, "auth_configuration_invalid", "Browser authentication transport is invalid")
  }

  for (const kind of ["cli", "desktop"] as const) {
    const native = descriptor.native[kind]
    assertClientDescriptor(kind, native)
    if (
      !isExactHttpsOrigin(native.tokenEndpointOrigin) ||
      !isExactHttpsOrigin(native.controlPlaneOrigin) ||
      !isExactHttpsUrl(native.resource) ||
      new URL(native.resource).origin !== native.controlPlaneOrigin
    ) {
      throw new AuthenticationError(503, "auth_configuration_invalid", `Native auth client ${kind} origins are invalid`)
    }
    assertNativeRevocationDescriptor(kind, native.revocation, native.tokenEndpointOrigin)
  }

  if (descriptor.adapter === "better-auth") {
    if (
      descriptor.browser.transport !== "cookie" ||
      descriptor.native.cli.flow !== "device-authorization" ||
      descriptor.native.desktop.flow !== "authorization-code-pkce" ||
      descriptor.native.cli.revocation.protocol !== "rfc7009" ||
      descriptor.native.desktop.revocation.protocol !== "rfc7009" ||
      descriptor.native.cli.revocation.tokenEndpointAuthMethod !== "none" ||
      descriptor.native.desktop.revocation.tokenEndpointAuthMethod !== "none" ||
      descriptor.native.cli.revocation.endpoint !== `${descriptor.issuer}/oauth2/revoke` ||
      descriptor.native.desktop.revocation.endpoint !== `${descriptor.issuer}/oauth2/revoke`
    ) {
      throw new AuthenticationError(
        503,
        "auth_configuration_invalid",
        "Better Auth transport and native flows are invalid",
      )
    }
  }
}

function parseCommonClient(value: Record<string, unknown>) {
  if (!present(value.id) || !present(value.resource)) throw invalidCredentials()
  return {
    id: value.id,
    resource: value.resource,
    scopes: exactStringArray(value.scopes),
  }
}

function parseVerifiedSession(
  value: unknown,
  descriptor: AuthAdapterDescriptor,
  now: number,
  maxFutureSkewMs: number,
): VerifiedAuthSession {
  if (!isRecord(value)) throw invalidCredentials()
  if (value.adapter !== descriptor.adapter || value.issuer !== descriptor.issuer) throw invalidCredentials()
  if (!present(value.subject) || !present(value.sessionId)) throw invalidCredentials()
  if (
    typeof value.authenticatedAt !== "number" ||
    !Number.isFinite(value.authenticatedAt) ||
    value.authenticatedAt <= 0 ||
    value.authenticatedAt > now + maxFutureSkewMs
  )
    throw invalidCredentials()

  const methods = exactStringArray(value.methods, AUTHENTICATION_EVIDENCE_METHODS) as AuthenticationEvidenceMethod[]
  const assurance =
    value.assurance === undefined
      ? "insufficient"
      : isOneOf(value.assurance, AUTH_ASSURANCE_LEVELS)
        ? value.assurance
        : (() => {
            throw invalidCredentials()
          })()
  if (!isRecord(value.client) || !isOneOf(value.client.kind, AUTH_CLIENT_KINDS)) throw invalidCredentials()

  const common = parseCommonClient(value.client)
  let client: AuthClientBinding
  if (value.client.kind === "browser") {
    if (
      value.client.tokenKind !== "browser-session" ||
      !present(value.client.origin) ||
      !descriptor.browser.trustedOrigins.includes(value.client.origin)
    )
      throw invalidCredentials()
    client = { ...common, kind: "browser", tokenKind: "browser-session", origin: value.client.origin }
  } else {
    const expected = descriptor.native[value.client.kind]
    if (
      value.client.tokenKind !== "access-token" ||
      value.client.deploymentId !== descriptor.deploymentId ||
      value.client.adapter !== descriptor.adapter ||
      value.client.issuer !== descriptor.issuer ||
      value.client.tokenEndpointOrigin !== expected.tokenEndpointOrigin ||
      value.client.controlPlaneOrigin !== expected.controlPlaneOrigin
    )
      throw invalidCredentials()
    client = {
      ...common,
      kind: value.client.kind,
      tokenKind: "access-token",
      deploymentId: descriptor.deploymentId,
      adapter: descriptor.adapter,
      issuer: descriptor.issuer,
      tokenEndpointOrigin: expected.tokenEndpointOrigin,
      controlPlaneOrigin: expected.controlPlaneOrigin,
    }
  }

  const expected = client.kind === "browser" ? descriptor.browser : descriptor.native[client.kind]
  if (
    client.id !== expected.clientId ||
    client.resource !== expected.resource ||
    client.scopes.some((scope) => !expected.scopes.includes(scope))
  )
    throw invalidCredentials()

  return {
    adapter: descriptor.adapter,
    issuer: descriptor.issuer,
    subject: value.subject,
    sessionId: value.sessionId,
    authenticatedAt: value.authenticatedAt,
    methods,
    assurance,
    client,
  }
}

function requestHasCookie(request: Request, name: string) {
  return (request.headers.get("cookie") ?? "").split(";").some((part) => {
    const trimmed = part.trim()
    const separator = trimmed.indexOf("=")
    return separator > 0 && trimmed.slice(0, separator) === name
  })
}

/** True only when the statically selected adapter's browser/native credential is present. */
export function requestHasAuthenticationCredential(request: Request, descriptor: AuthAdapterDescriptor) {
  if (request.headers.has("authorization")) return true
  return descriptor.browser.transport === "cookie" && requestHasCookie(request, descriptor.browser.cookie.name)
}

function assertUnambiguousCredential(request: Request, descriptor: AuthAdapterDescriptor) {
  if (
    descriptor.browser.transport === "cookie" &&
    request.headers.has("authorization") &&
    requestHasCookie(request, descriptor.browser.cookie.name)
  ) {
    throw new AuthenticationError(401, "ambiguous_credentials", "Multiple authentication credentials are not accepted")
  }
}

function resolveApplicationIdentity(result: ApplicationIdentityResolution) {
  switch (result.state) {
    case "active":
      if (!present(result.userId) || !present(result.actorId)) {
        throw new AuthenticationError(503, "auth_unavailable", "Application identity mapping is unavailable")
      }
      return result
    case "provisioning":
      throw new AuthenticationError(503, "identity_provisioning", "Application identity provisioning is in progress")
    case "suspended":
      throw new AuthenticationError(403, "account_suspended", "Application account is suspended")
    case "deleted":
      throw new AuthenticationError(403, "account_deleted", "Application account is deleted")
    case "unavailable":
      throw new AuthenticationError(503, "auth_unavailable", "Application identity mapping is unavailable")
  }
}

export function createControlPlaneAuthenticationAdapter(input: {
  descriptor: AuthAdapterDescriptor
  verify(request: Request): Promise<unknown>
  resolveIdentity: ApplicationIdentityResolver
  now?: () => number
  maxFutureSkewMs?: number
}): RequestAuthenticationAdapter & RequestIdentityVerificationAdapter {
  const now = input.now ?? Date.now
  const maxFutureSkewMs = input.maxFutureSkewMs ?? 60_000
  assertDescriptor(input.descriptor, now())

  const verify = async (request: Request) => {
    assertUnambiguousCredential(request, input.descriptor)

    let verified: unknown
    try {
      verified = await input.verify(request)
    } catch (error) {
      if (error instanceof AuthenticationError) throw error
      throw new AuthenticationError(503, "auth_unavailable", "Authentication verifier is unavailable")
    }
    const session = parseVerifiedSession(verified, input.descriptor, now(), maxFutureSkewMs)
    const identity = {
      adapter: session.adapter,
      issuer: session.issuer,
      subject: session.subject,
    } satisfies AuthIdentity
    return { identity, session }
  }

  return {
    descriptor: input.descriptor,
    async verifyIdentity(request) {
      return (await verify(request)).identity
    },
    async authenticate(request) {
      const { identity, session } = await verify(request)

      let resolution: ApplicationIdentityResolution
      try {
        resolution = await input.resolveIdentity(identity, request)
      } catch {
        throw new AuthenticationError(503, "auth_unavailable", "Application identity mapping is unavailable")
      }
      const mapped = resolveApplicationIdentity(resolution)
      return {
        userId: mapped.userId,
        actorId: mapped.actorId,
        actorKind: "human",
        deploymentId: input.descriptor.deploymentId,
        sessionId: session.sessionId,
        authenticatedAt: session.authenticatedAt,
        methods: session.methods,
        assurance: session.assurance ?? "insufficient",
        client: session.client,
        identity,
      }
    },
  }
}

/** Authenticate through the one statically composed adapter; there is no fallback list. */
export function authenticateControlPlaneRequest(request: Request, adapter: RequestAuthenticationAdapter) {
  return adapter.authenticate(request)
}
