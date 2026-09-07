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
import { DEFAULT_CLAXEDO_SERVER_PORT } from "@claxedo/local-server/self-hosted-execution"
import { BETTER_AUTH_INTROSPECTION_CLIENT_ID } from "../../platform/auth/better-auth-native-clients"
import { CLAXEDO_MCP_RESOURCE_SCOPES, claxedoMcpResource } from "../../platform/auth/mcp-oauth-scopes"

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
      oauthProvider({
        loginPage: `${embeddedAuthPublicOrigin(env)}/login`,
        consentPage: `${embeddedAuthPublicOrigin(env)}/oauth/consent`,
        scopes: [...CLAXEDO_MCP_RESOURCE_SCOPES],
        resources: [
          {
            identifier: claxedoMcpResource(embeddedAuthPublicOrigin(env)),
            name: "Claxedo MCP",
            allowedScopes: [...CLAXEDO_MCP_RESOURCE_SCOPES],
            accessTokenTtl: 300,
            refreshTokenTtl: 30 * 24 * 60 * 60,
          },
        ],
        clientRegistrationDefaultResources: [claxedoMcpResource(embeddedAuthPublicOrigin(env))],
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

  // better-auth normally migrates via its CLI; an embedded self-host issuer
  // has no separate deploy step, so run the schema migrations in-process at
  // construction. Both the handler and the verifier await this.
  /**
   * The confidential client the box introspects with. Better Auth offers no
   * server-side call that reads an access token's claims without one, and its
   * dynamic registration mints ids for MCP hosts, so the resource server needs
   * a client of its own — the same `claxedo-control-plane` row the hosted
   * deployment provisions in `better-auth-native-clients.ts`.
   *
   * `storeClientSecret: "encrypted"` decides the stored shape, so the row
   * carries the ciphertext, not the secret.
   */
  const seedIntrospectionClient = async () => {
    const { adapter } = await auth.$context
    const row = {
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
    }
    const where = [{ field: "clientId", value: BETTER_AUTH_INTROSPECTION_CLIENT_ID }]
    if (await adapter.findOne({ model: "oauthClient", where })) {
      await adapter.update({ model: "oauthClient", where, update: row })
      return
    }
    await adapter.create({ model: "oauthClient", data: row })
  }

  const ready = getMigrations(options)
    .then(({ runMigrations }) => runMigrations())
    .then(seedIntrospectionClient)
  // Every consumer below awaits `ready` and so sees a boot failure; this only
  // stops an instance nobody went on to use — one closed while the schema work
  // was still in flight — from raising an unhandled rejection.
  void ready.catch(() => undefined)

  const handler = async (request: Request) => {
    await ready
    return auth.handler(request)
  }

  const verifier: BetterAuthVerifier = async (token) => {
    await ready
    const resolved = await auth.api
      .getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) })
      .catch(() => null)
    if (!resolved?.user?.id) return null
    return {
      subject: resolved.user.id,
      tokenIdentifier: resolved.session.id,
      issuer: EMBEDDED_AUTH_ISSUER,
    }
  }

  return {
    issuer: EMBEDDED_AUTH_ISSUER,
    handler,
    verifier,
    introspectAccessToken: async (token) => {
      await ready
      return auth.api.oauth2Introspect({
        body: {
          client_id: BETTER_AUTH_INTROSPECTION_CLIENT_ID,
          client_secret: introspectionClientSecret(options.secret),
          token,
          token_type_hint: "access_token",
        },
      })
    },
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
