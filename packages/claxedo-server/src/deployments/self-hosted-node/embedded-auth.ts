import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import Database from "better-sqlite3"
import { betterAuth, type BetterAuthOptions } from "better-auth"
import { symmetricEncrypt } from "better-auth/crypto"
import { bearer } from "better-auth/plugins"
import { oauthDeviceAuthorization, oauthProvider } from "@better-auth/oauth-provider"
import { getMigrations } from "better-auth/db/migration"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import type { BetterAuthVerifier } from "@claxedo/server-core/platform/auth/auth"
import { asRecord } from "@claxedo/server-core/platform/json/index"
import { DEFAULT_CLAXEDO_SERVER_PORT } from "@claxedo/local-server/self-hosted-execution"
import { BETTER_AUTH_NATIVE_SCOPES, betterAuthIssuer } from "../../platform/auth/better-auth-d1-foundation"
import {
  BETTER_AUTH_CLI_CLIENT_ID,
  BETTER_AUTH_DESKTOP_CLIENT_ID,
  BETTER_AUTH_DESKTOP_REDIRECT_URI,
  BETTER_AUTH_INTROSPECTION_CLIENT_ID,
} from "../../platform/auth/better-auth-native-clients"
import { CLAXEDO_MCP_RESOURCE_SCOPES, claxedoMcpResource } from "../../platform/auth/mcp-oauth-scopes"
import { oauthConsentRevocation } from "../../platform/auth/oauth-consent-revocation"

/**
 * Embedded Better Auth for self-host boxes (part of the self-host/hosted-parity
 * plan): real signup/login (signed mode) with no hosted identity provider.
 *
 * - Users/sessions live in a dedicated SQLite file under `dataDir()`
 *   (`better-sqlite3` — already a real dependency; the central store's
 *   `node:sqlite` handle is not shared because better-auth manages its own
 *   schema/migrations and the stores have independent lifecycles).
 * - `handler` is a plain fetch handler; mount it in Hono via
 *   `app.all("/api/auth/*", (c) => embedded.handler(c.req.raw))` —
 *   better-auth's default `basePath` is exactly `/api/auth`.
 * - `verifier` adapts bearer session tokens (issued by the `bearer()` plugin
 *   as the `set-auth-token` response header on sign-up/sign-in) into the
 *   `BetterAuthVerifier` contract consumed by `betterAuthAdapter(...)`.
 *   Verification calls `auth.api.getSession` in-process — no HTTP hop.
 *
 * Enabled with CLAXEDO_EMBEDDED_AUTH=1. Optional env:
 * - CLAXEDO_EMBEDDED_AUTH_SECRET / BETTER_AUTH_SECRET: signing secret.
 *   When absent, a random secret is generated ONCE and persisted (0600) at
 *   `<dataDir>/embedded-auth.secret` so sessions survive restarts.
 * - CLAXEDO_EMBEDDED_AUTH_TRUSTED_ORIGINS: comma-separated extra origins for
 *   better-auth's CSRF origin check (localhost dev origins are trusted by
 *   default via wildcard).
 */

export const EMBEDDED_AUTH_ISSUER = "claxedo-embedded"

/**
 * The public origin the embedded issuer mints sessions for: `BETTER_AUTH_URL`
 * when set (the HTTPS dev origin that fronts this server), else this server's
 * own loopback origin. Cookie security follows it: an HTTPS origin gets the
 * `__Secure-` cookie the browser client's descriptor contract requires.
 */
export function embeddedAuthPublicOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.BETTER_AUTH_URL?.trim()
  return new URL(configured || `http://localhost:${DEFAULT_CLAXEDO_SERVER_PORT}`).origin
}

/** The RFC 8707 resource the native clients (CLI, desktop) hold control-plane tokens for; the descriptor advertises it. */
export function embeddedControlPlaneResource(env: NodeJS.ProcessEnv = process.env): string {
  return `${embeddedAuthPublicOrigin(env)}/control-plane`
}

const EMBEDDED_AUTH_COOKIE_PREFIX = "claxedo"

/** The session cookie name Better Auth derives from the prefix and the secure flag. */
export function embeddedAuthSessionCookieName(env: NodeJS.ProcessEnv = process.env): string {
  const secure = embeddedAuthPublicOrigin(env).startsWith("https:")
  return `${secure ? "__Secure-" : ""}${EMBEDDED_AUTH_COOKIE_PREFIX}.session_token`
}

function flagEnabled(input?: string) {
  return ["1", "true", "yes"].includes((input ?? "").trim().toLowerCase())
}

/** True when the deployment asked for the embedded Better Auth issuer. */
export function embeddedAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagEnabled(env.CLAXEDO_EMBEDDED_AUTH)
}

export type EmbeddedAuth = {
  issuer: string
  /** Fetch handler serving the better-auth routes under /api/auth/*. */
  handler: (request: Request) => Promise<Response>
  /** Bearer session-token verifier for `betterAuthAdapter(...)`. */
  verifier: BetterAuthVerifier
  /** RFC 7662 introspection of one access token, as this box's own resource-server client. */
  introspectAccessToken: (token: string) => Promise<unknown>
  /** Resolves once the auth schema migrations have run. */
  ready: Promise<void>
  /** Close the underlying SQLite handle (tests). */
  close: () => void
}

function resolveSecret(env: NodeJS.ProcessEnv, dir: string): string {
  const fromEnv = env.CLAXEDO_EMBEDDED_AUTH_SECRET?.trim() || env.BETTER_AUTH_SECRET?.trim()
  if (fromEnv) return fromEnv
  const secretPath = path.join(dir, "embedded-auth.secret")
  try {
    const existing = fs.readFileSync(secretPath, "utf8").trim()
    if (existing) return existing
  } catch {}
  const secret = crypto.randomBytes(32).toString("hex")
  fs.writeFileSync(secretPath, secret + "\n", { mode: 0o600 })
  return secret
}

/**
 * The secret the box authenticates to its own OAuth provider with, to read the
 * claims of an access token it issued for the MCP resource.
 *
 * Derived from the signing secret rather than stored: it is spent only inside
 * this process, and a second file on disk would be a second thing to keep in
 * step with a rotated `BETTER_AUTH_SECRET` — the client row is rewritten from
 * this value on every boot, so a rotation carries it.
 */
function introspectionClientSecret(betterAuthSecret: string): string {
  return crypto.createHmac("sha256", betterAuthSecret).update(BETTER_AUTH_INTROSPECTION_CLIENT_ID).digest("hex")
}

function trustedOrigins(env: NodeJS.ProcessEnv): string[] {
  const extra = (env.CLAXEDO_EMBEDDED_AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
  // Wildcards are supported by better-auth's origin matcher; localhost dev
  // (vite :4444 → local control plane) must pass the CSRF origin check. The
  // public origin is the HTTPS dev origin that fronts this server when set.
  return [...new Set(["http://localhost:*", "http://127.0.0.1:*", "https://localhost:*", "https://127.0.0.1:*", embeddedAuthPublicOrigin(env), ...extra])]
}

const NATIVE_CLIENT_IDS: ReadonlySet<string> = new Set([BETTER_AUTH_CLI_CLIENT_ID, BETTER_AUTH_DESKTOP_CLIENT_ID])

function audienceIncludes(aud: unknown, resource: string) {
  return aud === resource || (Array.isArray(aud) && aud.includes(resource))
}

/**
 * The subject behind an introspected native access token, or undefined for
 * anything the control plane must not accept: an inactive token, one from
 * another issuer, one a dynamically registered MCP host holds, or one whose
 * audience does not name this control plane.
 */
export function nativeAccessTokenSubject(
  introspection: unknown,
  expected: { issuer: string; resource: string },
): { subject: string; tokenIdentifier: string } | undefined {
  const claims = asRecord(introspection)
  if (!claims) return undefined
  if (claims.active !== true || claims.iss !== expected.issuer || claims.token_type !== "Bearer") return undefined
  if (typeof claims.sub !== "string" || !claims.sub || typeof claims.client_id !== "string") return undefined
  if (!NATIVE_CLIENT_IDS.has(claims.client_id) || !audienceIncludes(claims.aud, expected.resource)) return undefined
  const jti = typeof claims.jti === "string" && claims.jti ? claims.jti : undefined
  const sid = typeof claims.sid === "string" && claims.sid ? claims.sid : undefined
  return { subject: claims.sub, tokenIdentifier: jti ?? sid ?? `${claims.client_id}|${claims.sub}` }
}

export function createEmbeddedAuth(
  input: {
    env?: NodeJS.ProcessEnv
    /** Override the SQLite file (tests). Defaults to `<dataDir>/embedded-auth.sqlite`. */
    dbPath?: string
  } = {},
): EmbeddedAuth {
  const env = input.env ?? process.env
  const dir = dataDir()
  fs.mkdirSync(dir, { recursive: true })
  const dbPath = input.dbPath ?? path.join(dir, "embedded-auth.sqlite")
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)

  const mcpResource = {
    identifier: claxedoMcpResource(embeddedAuthPublicOrigin(env)),
    name: "Claxedo MCP",
    allowedScopes: [...CLAXEDO_MCP_RESOURCE_SCOPES],
    accessTokenTtl: 300,
    refreshTokenTtl: 30 * 24 * 60 * 60,
  }
  const controlPlaneResource = {
    identifier: embeddedControlPlaneResource(env),
    name: "Claxedo control plane",
    allowedScopes: [...BETTER_AUTH_NATIVE_SCOPES],
    accessTokenTtl: 300,
    refreshTokenTtl: 30 * 24 * 60 * 60,
  }

  const options = {
    database: db,
    secret: resolveSecret(env, path.dirname(dbPath)),
    // Only used for redirect-style flows; email+password + bearer verification
    // are origin-relative. Overridable via the standard better-auth env.
    baseURL: embeddedAuthPublicOrigin(env),
    emailAndPassword: { enabled: true },
    trustedOrigins: trustedOrigins(env),
    // Same cookie shape as the hosted issuer (better-auth-d1-foundation.ts) so
    // the browser client's descriptor contract holds against this issuer too;
    // `useSecureCookies` follows the public origin's scheme.
    advanced: {
      useSecureCookies: embeddedAuthPublicOrigin(env).startsWith("https:"),
      cookiePrefix: EMBEDDED_AUTH_COOKIE_PREFIX,
      defaultCookieAttributes: {
        secure: embeddedAuthPublicOrigin(env).startsWith("https:"),
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      },
    },
    // The bearer plugin issues a signed session token via the
    // `set-auth-token` response header and accepts `Authorization: Bearer`
    // on any endpoint — this is what non-cookie clients (CLI, extension,
    // control-plane bearer auth) use.
    plugins: [
      bearer(),
      oauthConsentRevocation(),
      oauthProvider({
        loginPage: `${embeddedAuthPublicOrigin(env)}/login`,
        consentPage: `${embeddedAuthPublicOrigin(env)}/oauth/consent`,
        scopes: [...BETTER_AUTH_NATIVE_SCOPES, ...CLAXEDO_MCP_RESOURCE_SCOPES],
        resources: [controlPlaneResource, mcpResource],
        clientRegistrationDefaultResources: [mcpResource.identifier],
        // Without this Better Auth writes the provider's whole scope list onto
        // every dynamically registered client; this box offers no other
        // resource, and its clients should not claim otherwise.
        clientRegistrationDefaultScopes: [...CLAXEDO_MCP_RESOURCE_SCOPES],
        enforcePerClientResources: true,
        allowPublicClientPrelogin: true,
        // Same reasoning as the hosted foundation: MCP hosts arrive with no
        // client id and a loopback redirect on an ephemeral port. A self-host
        // box has no install tooling to pre-register them at all.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // This box has no `jwt()` plugin, so ID tokens are signed with the
        // client secret and Better Auth must be able to recover it.
        disableJwtPlugin: true,
        storeClientSecret: "encrypted",
        accessTokenExpiresIn: 300,
        refreshTokenExpiresIn: 30 * 24 * 60 * 60,
      }),
      oauthDeviceAuthorization({
        verificationUri: `${embeddedAuthPublicOrigin(env)}/device`,
        expiresIn: "10m",
        interval: "5s",
      }),
    ],
    // Self-host boxes must not phone home.
    telemetry: { enabled: false },
  } satisfies BetterAuthOptions

  const auth = betterAuth(options)

  /**
   * The rows the hosted D1 plane provisions through
   * `betterAuthNativeClientStatements`, written here through Better Auth's
   * adapter: the two public native clients the descriptor advertises
   * (`claxedo-cli` for the RFC 8628 device grant, `claxedo-desktop` for
   * PKCE), the confidential client the box introspects with, the resource
   * rows, and the client↔resource links.
   *
   * The introspection client exists because Better Auth offers no server-side
   * call that reads an access token's claims without one, and its dynamic
   * registration mints ids for MCP hosts. `storeClientSecret: "encrypted"`
   * decides the stored shape, so the row carries the ciphertext, not the
   * secret.
   *
   * Every link matters: RFC 7662 §4 lets an authorization server answer
   * `active: false` rather than reveal a token to a caller with no claim on
   * it, and Better Auth authorizes an introspection only from the client that
   * issued the token or one linked to a resource in the token's audience. A
   * missing link makes every token for that resource look like garbage.
   */
  const seedNativeClients = async () => {
    const { adapter } = await auth.$context
    const scopes = JSON.stringify(BETTER_AUTH_NATIVE_SCOPES)
    const nativeClient = (clientId: string, redirectUris: string[], grantTypes: string[]) => ({
      clientId,
      disabled: false,
      skipConsent: false,
      subjectType: "public",
      scopes,
      redirectUris: JSON.stringify(redirectUris),
      tokenEndpointAuthMethod: "none",
      applicationType: "native",
      grantTypes: JSON.stringify(grantTypes),
      responseTypes: JSON.stringify(["code"]),
      requirePKCE: true,
    })
    const clients = [
      nativeClient(BETTER_AUTH_CLI_CLIENT_ID, [], ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"]),
      nativeClient(BETTER_AUTH_DESKTOP_CLIENT_ID, [BETTER_AUTH_DESKTOP_REDIRECT_URI], ["authorization_code", "refresh_token"]),
      {
        clientId: BETTER_AUTH_INTROSPECTION_CLIENT_ID,
        clientSecret: await symmetricEncrypt({ key: options.secret, data: introspectionClientSecret(options.secret) }),
        disabled: false,
        skipConsent: true,
        subjectType: "public",
        scopes: "[]",
        redirectUris: "[]",
        tokenEndpointAuthMethod: "client_secret_post",
        applicationType: "web",
        grantTypes: "[]",
        responseTypes: "[]",
        requirePKCE: false,
      },
    ]
    for (const row of clients) {
      const where = [{ field: "clientId", value: row.clientId }]
      if (await adapter.findOne({ model: "oauthClient", where })) {
        await adapter.update({ model: "oauthClient", where, update: row })
      } else {
        await adapter.create({ model: "oauthClient", data: row })
      }
    }
    // The join rows reference `oauthResource.identifier`, and a resource named
    // only in the plugin options has no row to reference.
    for (const resource of [controlPlaneResource, mcpResource]) {
      const where = [{ field: "identifier", value: resource.identifier }]
      if (!(await adapter.findOne({ model: "oauthResource", where }))) {
        await adapter.create({ model: "oauthResource", data: { ...resource, disabled: false, createdAt: new Date(), updatedAt: new Date() } })
      }
    }
    const links = [
      [BETTER_AUTH_CLI_CLIENT_ID, controlPlaneResource.identifier],
      [BETTER_AUTH_DESKTOP_CLIENT_ID, controlPlaneResource.identifier],
      [BETTER_AUTH_INTROSPECTION_CLIENT_ID, controlPlaneResource.identifier],
      [BETTER_AUTH_INTROSPECTION_CLIENT_ID, mcpResource.identifier],
    ]
    for (const [clientId, resourceId] of links) {
      const where = [{ field: "clientId", value: clientId }, { field: "resourceId", value: resourceId }]
      if (!(await adapter.findOne({ model: "oauthClientResource", where }))) {
        await adapter.create({ model: "oauthClientResource", data: { clientId, resourceId, createdAt: new Date() } })
      }
    }
  }

  // better-auth normally migrates via its CLI; an embedded self-host issuer has
  // no separate deploy step, so the schema migrations and the client row this
  // box needs are written in-process at construction. Every consumer below
  // awaits this.
  const ready = getMigrations(options)
    .then(({ runMigrations }) => runMigrations())
    .then(seedNativeClients)
  // A boot failure still reaches whoever awaits `ready`; this only stops an
  // instance nobody went on to use — one closed while the schema work was
  // still in flight — from raising an unhandled rejection.
  void ready.catch(() => undefined)

  const handler = async (request: Request) => {
    await ready
    return auth.handler(request)
  }

  const introspectAccessToken = async (token: string) => {
    await ready
    return auth.api.oauth2Introspect({
      body: {
        client_id: BETTER_AUTH_INTROSPECTION_CLIENT_ID,
        client_secret: introspectionClientSecret(options.secret),
        token,
        token_type_hint: "access_token",
      },
    })
  }

  /**
   * Two credentials reach the signed routes as a bearer: the session token the
   * `bearer()` plugin hands the web app and sign-in scripts, and the opaque
   * access token the OAuth server issues the CLI (device grant) and the
   * desktop (PKCE) for the control-plane resource. The second is verified the
   * way the hosted D1 plane verifies it (`verifyNative` in
   * better-auth-d1-request-authentication.ts): introspected, and accepted only
   * from one of the two native clients this box registers for itself, with
   * this box's control plane in its audience.
   */
  const verifier: BetterAuthVerifier = async (token) => {
    await ready
    const resolved = await auth.api
      .getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) })
      .catch(() => null)
    if (resolved?.user?.id) {
      return {
        subject: resolved.user.id,
        tokenIdentifier: resolved.session.id,
        issuer: EMBEDDED_AUTH_ISSUER,
      }
    }
    const native = nativeAccessTokenSubject(
      await introspectAccessToken(token).catch(() => undefined),
      { issuer: betterAuthIssuer(embeddedAuthPublicOrigin(env)), resource: controlPlaneResource.identifier },
    )
    if (!native) return null
    return { subject: native.subject, tokenIdentifier: native.tokenIdentifier, issuer: EMBEDDED_AUTH_ISSUER }
  }

  return {
    issuer: EMBEDDED_AUTH_ISSUER,
    handler,
    verifier,
    introspectAccessToken,
    ready,
    close: () => db.close(),
  }
}


let singleton: EmbeddedAuth | undefined

/**
 * Process-wide embedded auth instance. The server composition needs the SAME
 * instance in two places — the `/api/auth/*` route mount (createSelfHostedApp) and the
 * control-plane auth adapter (createDefaultLocalControlPlaneServices) — so it
 * is shared lazily here.
 */
export function getEmbeddedAuth(): EmbeddedAuth {
  return (singleton ??= createEmbeddedAuth())
}

/**
 * Close and forget the process-wide instance.
 *
 * Needed because the singleton binds to `CLAXEDO_DATA_DIR` at first use, and
 * suites run in one process with `fileParallelism: false`. A test that composes
 * the app with embedded auth under a temporary data dir leaves the singleton
 * pointing at a directory the next test deletes; its schema migration then
 * completes against a removed file and raises an unhandled SQLITE_IOERR
 * attributed to whichever test happens to be running when it lands.
 *
 * Production never calls this: the instance lives for the process.
 */
export function resetEmbeddedAuthForTests() {
  const current = singleton
  singleton = undefined
  try {
    current?.close()
  } catch {
    // Already closed, or its file is gone. Either way the reference is dropped.
  }
}
