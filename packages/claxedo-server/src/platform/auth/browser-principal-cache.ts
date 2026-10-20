import { base64UrlDecode, base64UrlEncode, sha256Hex } from "@claxedo/helpers/crypto"
import {
  AUTH_ASSURANCE_LEVELS,
  AUTHENTICATION_EVIDENCE_METHODS,
  requestOrigin,
  type AuthAssurance,
  type AuthenticationEvidenceMethod,
  type ControlPlanePrincipal,
  type RequestAuthenticationAdapter,
  type RequestIdentityVerificationAdapter,
} from "@claxedo/server-core/platform/auth/authentication"
import { isJsonRecord, isNonEmptyString, isOneOf } from "@claxedo/server-core/platform/runtime/lib/json"

export const BROWSER_PRINCIPAL_CACHE_COOKIE = "__Host-claxedo.principal"

/**
 * How long a browser request may be admitted on the principal a live
 * verification produced, without asking Better Auth's session row and the
 * identity mapping again: the worst-case lag between a session's revocation
 * or expiry and its refusal (README.md).
 */
export const BROWSER_PRINCIPAL_CACHE_MAX_AGE_MS = 60_000

const KEY_DERIVATION_INFO = "claxedo.browser-principal-cache.v1"
const CLEARED = `${BROWSER_PRINCIPAL_CACHE_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`

type CachedPrincipal = {
  version: 1
  deploymentId: string
  configurationVersion: string
  sessionCookieHash: string
  expiresAt: number
  subject: string
  sessionId: string
  authenticatedAt: number
  methods: AuthenticationEvidenceMethod[]
  assurance: AuthAssurance
  userId: string
  actorId: string
}

type Adapter = RequestAuthenticationAdapter & RequestIdentityVerificationAdapter

/** The value of the one cookie named `name`; a name sent twice answers nothing, since Better Auth may have verified the other copy. */
function singleCookie(request: Request, name: string): string | undefined {
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.slice(0, part.indexOf("=")) === name && part.indexOf("=") > 0)
    .map((part) => part.slice(part.indexOf("=") + 1))
  return values.length === 1 && values[0] !== "" ? values[0] : undefined
}

async function principalCacheSigningKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"])
  return await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(KEY_DERIVATION_INFO) },
    material,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  )
}

function parseCached(value: unknown): CachedPrincipal | undefined {
  if (!isJsonRecord(value) || value.version !== 1) return undefined
  const { deploymentId, configurationVersion, sessionCookieHash, subject, sessionId, userId, actorId } = value
  const { expiresAt, authenticatedAt, assurance, methods } = value
  if (
    !isNonEmptyString(deploymentId) ||
    !isNonEmptyString(configurationVersion) ||
    !isNonEmptyString(sessionCookieHash) ||
    !isNonEmptyString(subject) ||
    !isNonEmptyString(sessionId) ||
    !isNonEmptyString(userId) ||
    !isNonEmptyString(actorId) ||
    typeof expiresAt !== "number" ||
    typeof authenticatedAt !== "number" ||
    !isOneOf(assurance, AUTH_ASSURANCE_LEVELS) ||
    !Array.isArray(methods) ||
    methods.length === 0
  ) return undefined
  const evidence: AuthenticationEvidenceMethod[] = []
  for (const method of methods) {
    if (!isOneOf(method, AUTHENTICATION_EVIDENCE_METHODS)) return undefined
    evidence.push(method)
  }
  return {
    version: 1,
    deploymentId,
    configurationVersion,
    sessionCookieHash,
    expiresAt,
    subject,
    sessionId,
    authenticatedAt,
    methods: evidence,
    assurance,
    userId,
    actorId,
  }
}

/**
 * Admits a browser request on the principal a live verification of the same
 * session cookie produced at most `BROWSER_PRINCIPAL_CACHE_MAX_AGE_MS` ago,
 * carried by the browser in an HMAC-signed, HTTP-only cookie so it reaches
 * whichever isolate answers. It holds who the caller is and nothing they may
 * do: every authorization, and `requireHuman`'s check that the identity, user
 * and actor are still linked and active, still reads the database on the
 * route.
 *
 * Only a lone session cookie with no `Authorization` header from a trusted
 * origin consults it; anything else goes to `adapter` as before, which
 * refuses what it refused. A cache that fails its signature, names another
 * deployment, configuration or session cookie, or has expired is not used,
 * and the request pays the live verification, whose response carries a fresh
 * cache. `verifyIdentity`, the enrollment flows' check, never reads it.
 */
export function withBrowserPrincipalCache<A extends Adapter>(
  adapter: A,
  input: { secret: string; now?: () => number },
): A & Required<Pick<RequestAuthenticationAdapter, "responseCookies">> {
  const now = input.now ?? Date.now
  const { descriptor } = adapter
  if (descriptor.browser.transport !== "cookie") {
    throw new Error("The browser principal cache needs the cookie transport")
  }
  const sessionCookieName = descriptor.browser.cookie.name
  const browser = descriptor.browser
  // Only a derived key is shared, never the derivation: workerd can leave a
  // promise begun on one request's context unsettled once that request ends,
  // and every later request awaiting it would hang.
  let derivedKey: CryptoKey | undefined
  const key = async () => (derivedKey ??= await principalCacheSigningKey(input.secret))
  const principals = new WeakMap<Request, Promise<ControlPlanePrincipal>>()
  const issued = new WeakMap<Request, string>()

  async function sign(body: string) {
    const signature = await crypto.subtle.sign("HMAC", await key(), new TextEncoder().encode(body))
    return base64UrlEncode(signature)
  }

  async function read(request: Request, sessionCookieHash: string): Promise<ControlPlanePrincipal | undefined> {
    const value = singleCookie(request, BROWSER_PRINCIPAL_CACHE_COOKIE)
    const [body, signature, extra] = value?.split(".") ?? []
    if (!body || !signature || extra !== undefined) return undefined
    let verified: boolean
    let decoded: unknown
    try {
      verified = await crypto.subtle.verify("HMAC", await key(), new Uint8Array(base64UrlDecode(signature)), new TextEncoder().encode(body))
      decoded = verified ? JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) : undefined
    } catch {
      return undefined
    }
    const cached = parseCached(decoded)
    if (
      !cached ||
      cached.deploymentId !== descriptor.deploymentId ||
      cached.configurationVersion !== descriptor.configurationVersion ||
      cached.sessionCookieHash !== sessionCookieHash ||
      cached.expiresAt <= now()
    ) return undefined
    return {
      userId: cached.userId,
      actorId: cached.actorId,
      actorKind: "human",
      deploymentId: descriptor.deploymentId,
      sessionId: cached.sessionId,
      authenticatedAt: cached.authenticatedAt,
      methods: cached.methods,
      assurance: cached.assurance,
      client: {
        kind: "browser",
        tokenKind: "browser-session",
        id: browser.clientId,
        resource: browser.resource,
        scopes: browser.scopes,
        origin: requestOrigin(request),
      },
      identity: { adapter: descriptor.adapter, issuer: descriptor.issuer, subject: cached.subject },
    }
  }

  async function issue(principal: ControlPlanePrincipal, sessionCookieHash: string): Promise<string> {
    const cached: CachedPrincipal = {
      version: 1,
      deploymentId: descriptor.deploymentId,
      configurationVersion: descriptor.configurationVersion,
      sessionCookieHash,
      expiresAt: now() + BROWSER_PRINCIPAL_CACHE_MAX_AGE_MS,
      subject: principal.identity.subject,
      sessionId: principal.sessionId,
      authenticatedAt: principal.authenticatedAt,
      methods: [...principal.methods],
      assurance: principal.assurance,
      userId: principal.userId,
      actorId: principal.actorId,
    }
    const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(cached)))
    const maxAge = BROWSER_PRINCIPAL_CACHE_MAX_AGE_MS / 1_000
    return `${BROWSER_PRINCIPAL_CACHE_COOKIE}=${body}.${await sign(body)}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`
  }

  async function authenticate(request: Request): Promise<ControlPlanePrincipal> {
    const sessionCookie = singleCookie(request, sessionCookieName)
    if (
      sessionCookie === undefined ||
      request.headers.has("authorization") ||
      !browser.trustedOrigins.includes(requestOrigin(request))
    ) return await adapter.authenticate(request)
    const sessionCookieHash = await sha256Hex(sessionCookie)
    const cached = await read(request, sessionCookieHash)
    if (cached) return cached
    const principal = await adapter.authenticate(request)
    if (principal.client.kind === "browser") issued.set(request, await issue(principal, sessionCookieHash))
    return principal
  }

  return {
    ...adapter,
    authenticate(request) {
      const known = principals.get(request)
      if (known) return known
      const pending = authenticate(request)
      principals.set(request, pending)
      return pending
    },
    responseCookies: (request) => {
      const cookie = issued.get(request)
      return cookie ? [cookie] : []
    },
  }
}

/**
 * Retires the cache whenever Better Auth's answer sets or clears the session
 * cookie (sign-in, sign-out, a session refresh), so the browser holds no cache
 * of a session it no longer carries.
 */
export function retireBrowserPrincipalCache(response: Response, sessionCookieName: string): Response {
  if (!response.headers.getSetCookie().some((cookie) => cookie.startsWith(`${sessionCookieName}=`))) return response
  response.headers.append("set-cookie", CLEARED)
  return response
}
