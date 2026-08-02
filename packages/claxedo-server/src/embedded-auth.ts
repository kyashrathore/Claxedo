import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import Database from "better-sqlite3"
import { betterAuth, type BetterAuthOptions } from "better-auth"
import { bearer } from "better-auth/plugins"
import { getMigrations } from "better-auth/db/migration"
import { dataDir } from "./lib/paths"
import type { BetterAuthVerifier } from "./control-plane/auth"

/**
 * Embedded Better Auth for self-host boxes (W1 of the self-host/hosted-parity
 * plan): real signup/login (signed mode) with NO Convex/Clerk.
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

function trustedOrigins(env: NodeJS.ProcessEnv): string[] {
  const extra = (env.CLAXEDO_EMBEDDED_AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
  // Wildcards are supported by better-auth's origin matcher; localhost dev
  // (vite :4444 → control plane :3001) must pass the CSRF origin check.
  return ["http://localhost:*", "http://127.0.0.1:*", ...extra]
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
    baseURL: env.BETTER_AUTH_URL?.trim() || "http://localhost:3001",
    emailAndPassword: { enabled: true },
    trustedOrigins: trustedOrigins(env),
    // The bearer plugin issues a signed session token via the
    // `set-auth-token` response header and accepts `Authorization: Bearer`
    // on any endpoint — this is what non-cookie clients (CLI, extension,
    // control-plane bearer auth) use.
    plugins: [bearer()],
    // Self-host boxes must not phone home.
    telemetry: { enabled: false },
  } satisfies BetterAuthOptions

  const auth = betterAuth(options)

  // better-auth normally migrates via its CLI; an embedded self-host issuer
  // has no separate deploy step, so run the schema migrations in-process at
  // construction. Both the handler and the verifier await this.
  const ready = getMigrations(options).then(({ runMigrations }) => runMigrations())

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
    ready,
    close: () => db.close(),
  }
}

let singleton: EmbeddedAuth | undefined

/**
 * Process-wide embedded auth instance. The server composition needs the SAME
 * instance in two places — the `/api/auth/*` route mount (createApp) and the
 * control-plane auth adapter (createDefaultLocalControlPlaneServices) — so it
 * is shared lazily here.
 */
export function getEmbeddedAuth(): EmbeddedAuth {
  return (singleton ??= createEmbeddedAuth())
}
