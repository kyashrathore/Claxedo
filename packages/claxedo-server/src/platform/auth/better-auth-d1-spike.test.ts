import { createPrivateKey, generateKeyPairSync, sign as signData } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import Database from "better-sqlite3"
import { getMigrations } from "better-auth/db/migration"
import { build } from "esbuild"
import { Miniflare } from "miniflare"

import {
  hostEnrollmentHeartbeatPayloadV2,
  hostEnrollmentPayload,
} from "../../authority/adapters/d1/host-access-authority"

import {
  BETTER_AUTH_SESSION_COOKIE,
  betterAuthIssuer,
  betterAuthD1FoundationOptions,
} from "./better-auth-d1-foundation"
import { resolveBetterAuthConfiguration } from "./better-auth-configuration"
import {
  BETTER_AUTH_DESKTOP_REDIRECT_URI,
  betterAuthNativeResource,
  provisionBetterAuthNativeClients,
} from "./better-auth-native-clients"
import { compileBetterAuthD1Migration } from "./better-auth-d1-migration"
import {
  BETTER_AUTH_ACCESS_TOKEN_PREFIX,
  BETTER_AUTH_REFRESH_TOKEN_PREFIX,
  betterAuthOAuthTokenHash,
} from "./better-auth-token-hash"

const API_ORIGIN = "https://api.claxedo.test"
const APP_ORIGIN = "https://app.claxedo.test"
const BETTER_AUTH_SECRET = "unit-1-better-auth-d1-spike-secret-that-is-long-enough"
const NATIVE_RESOURCE = betterAuthNativeResource(API_ORIGIN)
const MIGRATION_PATH = fileURLToPath(new URL("../../../migrations/auth/0001_better_auth.sql", import.meta.url))
const EVIDENCE_MIGRATION_PATH = fileURLToPath(
  new URL("../../../migrations/auth/0003_authentication_evidence.sql", import.meta.url),
)
const WORKER_PATH = fileURLToPath(new URL("./better-auth-d1-worker-spike.cf.ts", import.meta.url))
// The control-plane tables the D1 authority + relay-target resolver read:
// identities/orgs/workspaces (0002), host access + sharing (0004), and the
// machine-wide grain — enrollments plus owner assignments (0012–0014).
const CONTROL_PLANE_MIGRATION_PATHS = [
  "0001_service_installations.sql",
  "0002_workspace_authority.sql",
  "0003_private_sessions.sql",
  "0004_host_access_and_sharing.sql",
  "0005_agent_extensions_and_audit.sql",
  "0012_cold_local_host_challenges.sql",
  "0013_org_team_session_sharing.sql",
  "0014_host_workspace_assignments.sql",
  "0015_drop_local_host_links.sql",
].map((name) => fileURLToPath(new URL(`../../../migrations/control-plane/${name}`, import.meta.url)))

function body(input: Record<string, string>) {
  return new URLSearchParams(input).toString()
}

async function pkceChallenge(verifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return Buffer.from(digest).toString("base64url")
}

function executableMigration(sql: string) {
  return sql.replace(/^\s*--.*$/gm, "")
}

function cookieFrom(response: { headers: { get(name: string): string | null } }) {
  const setCookie = response.headers.get("set-cookie") ?? ""
  const value = setCookie.split(";")[0]
  if (!value.startsWith(`${BETTER_AUTH_SESSION_COOKIE}=`)) {
    throw new Error(`Better Auth did not issue ${BETTER_AUTH_SESSION_COOKIE}`)
  }
  return { value, setCookie }
}

describe("Better Auth + D1 inside Workerd", () => {
  let miniflare!: Miniflare
  let migrationSql: string

  beforeAll(async () => {
    migrationSql = await readFile(MIGRATION_PATH, "utf8")
    const evidenceMigrationSql = await readFile(EVIDENCE_MIGRATION_PATH, "utf8")
    const bundled = await build({
      entryPoints: [WORKER_PATH],
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      conditions: ["workerd", "worker", "import"],
      external: ["node:async_hooks", "node:crypto"],
      write: false,
      metafile: true,
      logLevel: "silent",
    })
    const output = bundled.outputFiles[0]
    if (!output) throw new Error("Better Auth Worker bundle was not emitted")
    const nodeImports = Object.values(bundled.metafile.outputs)
      .flatMap((entry) => entry.imports.map((dependency) => dependency.path))
      .filter((path) => path.startsWith("node:"))
      .sort()
    expect(nodeImports).toEqual(["node:async_hooks", "node:crypto"])

    miniflare = new Miniflare({
      modules: true,
      script: output.text,
      compatibilityDate: "2025-05-01",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      d1Databases: ["AUTH_DB", "CONTROL_PLANE_DB"],
    })
    const database = await miniflare.getD1Database("AUTH_DB")
    const statements = executableMigration(migrationSql)
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean)
      .map((statement) => database.prepare(statement))
    await database.batch(statements)
    await database.exec(executableMigration(evidenceMigrationSql))
    const controlPlaneDatabase = await miniflare.getD1Database("CONTROL_PLANE_DB")
    for (const migrationPath of CONTROL_PLANE_MIGRATION_PATHS) {
      const migration = executableMigration(await readFile(migrationPath, "utf8"))
      for (const statement of migration.split(/;\s*\n\s*\n/).map((part) => part.trim()).filter(Boolean)) {
        await controlPlaneDatabase.prepare(statement).run()
      }
    }
    await provisionBetterAuthNativeClients(
      database,
      API_ORIGIN,
      BETTER_AUTH_SECRET,
      "test-introspection-secret-that-is-long-enough",
    )
  })

  afterAll(async () => {
    await miniflare?.dispose()
  })

  test("keeps the committed migration in exact schema sync with the pinned options", async () => {
    const database = new Database(":memory:")
    try {
      expect(migrationSql).toBe(await compileBetterAuthD1Migration(database))
      database.exec(migrationSql)
      const options = betterAuthD1FoundationOptions({
        database,
        configuration: resolveBetterAuthConfiguration({
          env: {
            CLAXEDO_AUTH_METHODS: "email-password",
            BETTER_AUTH_URL: API_ORIGIN,
            CLAXEDO_APP_ORIGIN: APP_ORIGIN,
            BETTER_AUTH_SECRET: "schema-drift-check-secret-that-is-never-deployed",
          },
          emailSender: { async send() {} },
        }),
        resource: NATIVE_RESOURCE,
      })
      const pending = await getMigrations({ ...options, logger: { disabled: true } })
      expect(pending.toBeCreated).toEqual([])
      expect(pending.toBeAdded).toEqual([])
      expect(pending.toBeAddedIndexes).toEqual([])
      expect(pending.unsafeChanges).toEqual([])
    } finally {
      database.close()
    }
  })

  test("provisions deployment-bound native clients idempotently", async () => {
    const database = await miniflare.getD1Database("AUTH_DB")
    await provisionBetterAuthNativeClients(
      database,
      API_ORIGIN,
      BETTER_AUTH_SECRET,
      "test-introspection-secret-that-is-long-enough",
    )
    const clients = await database
      .prepare(`select "clientId", "redirectUris", "grantTypes", "requirePKCE" from "oauthClient" order by "clientId"`)
      .all<Record<string, unknown>>()
    expect(clients.results).toEqual([
      expect.objectContaining({ clientId: "claxedo-cli", requirePKCE: 1 }),
      expect.objectContaining({
        clientId: "claxedo-control-plane",
        redirectUris: "[]",
        grantTypes: "[]",
        requirePKCE: 0,
      }),
      expect.objectContaining({
        clientId: "claxedo-desktop",
        redirectUris: JSON.stringify([BETTER_AUTH_DESKTOP_REDIRECT_URI]),
        requirePKCE: 1,
      }),
    ])
    const links = await database
      .prepare(`select "clientId", "resourceId" from "oauthClientResource" order by "clientId"`)
      .all<Record<string, unknown>>()
    expect(links.results).toEqual([
      { clientId: "claxedo-cli", resourceId: NATIVE_RESOURCE },
      { clientId: "claxedo-control-plane", resourceId: NATIVE_RESOURCE },
      { clientId: "claxedo-desktop", resourceId: NATIVE_RESOURCE },
    ])
    expect(() => betterAuthNativeResource("http://api.claxedo.test")).toThrow(/exact HTTPS API origin/)
  })

  test("rolls back a user when its credential account cannot be created", async () => {
    const database = await miniflare.getD1Database("AUTH_DB")
    await database.prepare(`create trigger "fail_atomic_credential_account"
      before insert on "account"
      when NEW."providerId" = 'credential'
        and exists (select 1 from "user" where "id" = NEW."userId" and "email" = 'atomic-failure@example.test')
      begin
        select raise(abort, 'forced credential account failure');
      end`).run()
    try {
      const response = await miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: APP_ORIGIN },
        body: JSON.stringify({
          name: "Atomic Failure",
          email: "atomic-failure@example.test",
          password: "correct horse battery staple",
        }),
      })
      expect(response.status).toBe(422)
      const counts = await database.prepare(`select
        (select count(*) from "user" where "email" = ?) as "users",
        (select count(*) from "account" where "userId" in
          (select "id" from "user" where "email" = ?)) as "accounts"`)
        .bind("atomic-failure@example.test", "atomic-failure@example.test")
        .first<{ users: number; accounts: number }>()
      expect(counts).toEqual({ users: 0, accounts: 0 })
      const delivered = await miniflare.dispatchFetch(
        `${API_ORIGIN}/__test/last-email?recipient=${encodeURIComponent("atomic-failure@example.test")}`,
      )
      expect(delivered.status).toBe(404)
    } finally {
      await database.prepare(`drop trigger "fail_atomic_credential_account"`).run()
    }
  })

  test.each(["userId", "providerId", "issuer", "accountId"])(
    "rejects an account hook that mutates the immutable %s binding before commit",
    async (field) => {
      const email = `hook-${field.toLowerCase()}@example.test`
      const response = await miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/sign-up/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: APP_ORIGIN,
          "x-test-account-binding-mutation": field,
        },
        body: JSON.stringify({
          name: "Hook Mutation",
          email,
          password: "correct horse battery staple",
        }),
      })
      expect([409, 422]).toContain(response.status)
      const database = await miniflare.getD1Database("AUTH_DB")
      const counts = await database.prepare(`select
        (select count(*) from "user" where "email" = ?) as "users",
        (select count(*) from "account" where "userId" in
          (select "id" from "user" where "email" = ?)) as "accounts"`)
        .bind(email, email)
        .first<{ users: number; accounts: number }>()
      expect(counts).toEqual({ users: 0, accounts: 0 })
      const delivered = await miniflare.dispatchFetch(
        `${API_ORIGIN}/__test/last-email?recipient=${encodeURIComponent(email)}`,
      )
      expect(delivered.status).toBe(404)
      expect(response.headers.get("set-cookie") ?? "").not.toContain(BETTER_AUTH_SESSION_COOKIE)
    },
  )

  test("preserves Better Auth's valid empty display-name contract", async () => {
    const email = "empty-name@example.test"
    const response = await miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_ORIGIN },
      body: JSON.stringify({ name: "", email, password: "correct horse battery staple" }),
    })
    expect(response.status, await response.clone().text()).toBe(200)
    const database = await miniflare.getD1Database("AUTH_DB")
    expect(await database.prepare(`select "name" from "user" where "email" = ?`).bind(email).first())
      .toEqual({ name: "" })
    await database.prepare(`delete from "user" where "email" = ?`).bind(email).run()
  })

  test("rolls back parent consumption when refresh-child creation fails", async () => {
    const database = await miniflare.getD1Database("AUTH_DB")
    const now = new Date()
    const rawToken = "fault-injected-refresh-secret"
    await database.batch([
      database.prepare(`insert into "user" (
        "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
      ) values (?, ?, ?, ?, ?, ?)`)
        .bind("refresh-fault-user", "Refresh Fault", "refresh-fault@example.test", 1, now.toISOString(), now.toISOString()),
      database.prepare(`insert into "oauthRefreshToken" (
        "id", "token", "clientId", "userId", "resources", "expiresAt", "createdAt", "scopes",
        "familyId", "generation"
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          "refresh-fault-parent",
          await betterAuthOAuthTokenHash(rawToken),
          "claxedo-cli",
          "refresh-fault-user",
          JSON.stringify([NATIVE_RESOURCE]),
          new Date(now.getTime() + 60_000).toISOString(),
          now.toISOString(),
          JSON.stringify(["offline_access", "workspace:read"]),
          "refresh-fault-family",
          0,
        ),
    ])
    await database.prepare(`create trigger "fail_atomic_refresh_child"
      before insert on "oauthRefreshToken"
      when NEW."parentId" = 'refresh-fault-parent'
      begin
        select raise(abort, 'forced refresh child failure');
      end`).run()
    const request = () => miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body({
        grant_type: "refresh_token",
        refresh_token: `${BETTER_AUTH_REFRESH_TOKEN_PREFIX}${rawToken}`,
        client_id: "claxedo-cli",
        resource: NATIVE_RESOURCE,
      }),
    })
    try {
      const failed = await request()
      expect(failed.status).toBe(500)
      const rows = await database.prepare(`select "id", "revoked", "rotatedAt", "rotationNonce"
        from "oauthRefreshToken" where "familyId" = ?`).bind("refresh-fault-family")
        .all<Record<string, unknown>>()
      expect(rows.results).toEqual([expect.objectContaining({
        id: "refresh-fault-parent",
        revoked: null,
        rotatedAt: null,
        rotationNonce: null,
      })])
    } finally {
      await database.prepare(`drop trigger "fail_atomic_refresh_child"`).run()
    }
    const retried = await request()
    expect(retried.status, await retried.clone().text()).toBe(200)
    await database.prepare(`delete from "user" where "id" = ?`).bind("refresh-fault-user").run()
  })

  test("serves discovery, JWKS, and exact-origin credentialed CORS from the bundled Worker", async () => {
    const [discovery, oidc, jwks, concurrentJwks] = await Promise.all([
      miniflare.dispatchFetch(`${API_ORIGIN}/.well-known/oauth-authorization-server`, {
        headers: { origin: APP_ORIGIN },
      }),
      miniflare.dispatchFetch(`${API_ORIGIN}/.well-known/openid-configuration`),
      miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/jwks`),
      miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/jwks`),
    ])

    expect(discovery.status).toBe(200)
    expect(discovery.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN)
    expect(discovery.headers.get("access-control-allow-credentials")).toBe("true")
    const metadata = (await discovery.json()) as Record<string, unknown>
    expect(metadata).toMatchObject({
      issuer: betterAuthIssuer(API_ORIGIN),
      token_endpoint: `${API_ORIGIN}/api/auth/oauth2/token`,
      revocation_endpoint: `${API_ORIGIN}/api/auth/oauth2/revoke`,
      device_authorization_endpoint: `${API_ORIGIN}/api/auth/device/code`,
      code_challenge_methods_supported: ["S256"],
    })
    expect(metadata.grant_types_supported).toContain("urn:ietf:params:oauth:grant-type:device_code")
    expect(metadata.registration_endpoint).toBeUndefined()

    expect(oidc.status).toBe(404)
    expect(jwks.status).toBe(200)
    expect((await jwks.json()) as { keys: unknown[] }).toMatchObject({ keys: expect.any(Array) })
    expect(concurrentJwks.status).toBe(200)
    expect(await concurrentJwks.json()).toEqual(await miniflare
      .dispatchFetch(`${API_ORIGIN}/api/auth/jwks`)
      .then((response) => response.json()))
    const keyCount = await (await miniflare.getD1Database("AUTH_DB"))
      .prepare(`select count(*) as "count" from "jwks"`)
      .first<{ count: number }>()
    expect(keyCount?.count).toBe(1)

    const preflight = await miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/sign-up/email`, {
      method: "OPTIONS",
      headers: { origin: APP_ORIGIN },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN)
    expect(preflight.headers.get("access-control-allow-credentials")).toBe("true")
  })

  test("runs cookie session, device OAuth token rotation/revocation, and desktop loopback validation", async () => {
    const signUp = await miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_ORIGIN },
      body: JSON.stringify({
        name: "Unit One",
        email: "unit-one@example.test",
        password: "correct horse battery staple",
      }),
    })
    expect(signUp.status).toBe(200)
    expect(signUp.headers.get("set-cookie") ?? "").not.toContain(BETTER_AUTH_SESSION_COOKIE)
    const delivered = await miniflare.dispatchFetch(
      `${API_ORIGIN}/__test/last-email?recipient=${encodeURIComponent("unit-one@example.test")}`,
    )
    expect(delivered.status).toBe(200)
    const verificationEmail = (await delivered.json()) as {
      kind: string
      recipient: string
      actionUrl: string
    }
    expect(verificationEmail).toMatchObject({
      kind: "verification",
      recipient: "unit-one@example.test",
    })
    expect(new URL(verificationEmail.actionUrl).origin).toBe(API_ORIGIN)
    const verification = await miniflare.dispatchFetch(verificationEmail.actionUrl, {
      headers: { origin: APP_ORIGIN },
      redirect: "manual",
    })
    expect([200, 302]).toContain(verification.status)

    const signIn = await miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_ORIGIN },
      body: JSON.stringify({
        email: "unit-one@example.test",
        password: "correct horse battery staple",
      }),
    })
    expect(signIn.status, await signIn.clone().text()).toBe(200)
    const sessionCookie = cookieFrom(signIn)
    expect(sessionCookie.setCookie).toContain("HttpOnly")
    expect(sessionCookie.setCookie).toContain("Secure")
    expect(sessionCookie.setCookie.toLowerCase()).toContain("samesite=lax")
    expect(sessionCookie.setCookie).toContain("Path=/")
    expect(sessionCookie.setCookie.toLowerCase()).not.toContain("domain=")
    expect(signIn.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN)
    expect(signIn.headers.get("access-control-allow-credentials")).toBe("true")

    const session = await miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/get-session`, {
      headers: { cookie: sessionCookie.value, origin: APP_ORIGIN },
    })
    expect(session.status).toBe(200)
    const browserSession = (await session.json()) as {
      user?: { id?: string; email?: string }
      session?: { id?: string; createdAt?: string }
    }
    expect(browserSession).toMatchObject({
      user: { email: "unit-one@example.test" },
    })
    if (!browserSession.user?.id || !browserSession.session?.id || !browserSession.session.createdAt) {
      throw new Error(`Better Auth session response is incomplete: ${JSON.stringify(browserSession)}`)
    }
    const evidenceDatabase = await miniflare.getD1Database("AUTH_DB")
    const persistedEvidence = await evidenceDatabase.prepare(`select * from "authenticationEvidence"
      where "sessionId" = ?`).bind(browserSession.session.id).first<{
        sessionId: string
        subject: string
        authenticatedAt: number
        methods: string
        assurance: string
        createdAt: number
      }>()
    expect(persistedEvidence).toMatchObject({
      sessionId: browserSession.session.id,
      subject: browserSession.user.id,
      authenticatedAt: new Date(browserSession.session.createdAt).getTime(),
      methods: JSON.stringify(["password"]),
      assurance: "single-factor",
    })
    const cookiePrincipal = await miniflare.dispatchFetch(`${API_ORIGIN}/__test/authenticate`, {
      headers: { cookie: sessionCookie.value, origin: APP_ORIGIN },
    })
    expect(cookiePrincipal.status, await cookiePrincipal.clone().text()).toBe(200)
    expect(await cookiePrincipal.json()).toMatchObject({
      sessionId: browserSession.session.id,
      authenticatedAt: persistedEvidence?.authenticatedAt,
      methods: ["password"],
      assurance: "single-factor",
      client: { kind: "browser", tokenKind: "browser-session" },
    })

    const registration = await miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "untrusted",
        redirect_uris: ["http://127.0.0.1:49152/callback"],
        token_endpoint_auth_method: "none",
      }),
    })
    expect([401, 403, 404]).toContain(registration.status)

    const device = await miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: "claxedo-cli",
        scope: "openid profile email offline_access workspace:read",
        resource: NATIVE_RESOURCE,
      }),
    })
    expect(device.status).toBe(200)
    const devicePayload = (await device.json()) as {
      device_code: string
      user_code: string
      verification_uri: string
    }
    expect(devicePayload.verification_uri).toBe(`${APP_ORIGIN}/device`)

    const verifyDevice = await miniflare.dispatchFetch(
      `${API_ORIGIN}/api/auth/device?user_code=${encodeURIComponent(devicePayload.user_code)}`,
      { headers: { cookie: sessionCookie.value, origin: APP_ORIGIN } },
    )
    expect(verifyDevice.status, await verifyDevice.clone().text()).toBe(200)
    expect((await verifyDevice.json()) as Record<string, unknown>).toMatchObject({
      user_code: devicePayload.user_code,
      status: "pending",
      client_id: "claxedo-cli",
    })

    const approve = await miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/device/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: sessionCookie.value, origin: APP_ORIGIN },
      body: JSON.stringify({ userCode: devicePayload.user_code }),
    })
    expect(approve.status, await approve.clone().text()).toBe(200)

    const forbiddenSessionToken = await miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: devicePayload.device_code,
        client_id: "claxedo-cli",
      }),
    })
    expect(forbiddenSessionToken.status).not.toBe(200)

    const exchangeBody = body({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: devicePayload.device_code,
      client_id: "claxedo-cli",
      resource: NATIVE_RESOURCE,
    })
    const exchanges = await Promise.all([
      miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: exchangeBody,
      }),
      miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: exchangeBody,
      }),
    ])
    expect(exchanges.filter((response) => response.status === 200)).toHaveLength(1)
    const tokenResponse = exchanges.find((response) => response.status === 200)!
    const tokens = (await tokenResponse.json()) as { access_token: string; refresh_token: string }
    expect(tokens.access_token).toMatch(new RegExp(`^${BETTER_AUTH_ACCESS_TOKEN_PREFIX}`))
    expect(tokens.refresh_token).toMatch(new RegExp(`^${BETTER_AUTH_REFRESH_TOKEN_PREFIX}`))
    expect(tokens.access_token.split(".")).toHaveLength(1)
    const bearerPrincipal = await miniflare.dispatchFetch(`${API_ORIGIN}/__test/authenticate`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })
    expect(bearerPrincipal.status, await bearerPrincipal.clone().text()).toBe(200)
    expect(await bearerPrincipal.json()).toMatchObject({
      sessionId: browserSession.session.id,
      authenticatedAt: persistedEvidence?.authenticatedAt,
      methods: ["password"],
      assurance: "single-factor",
      client: { kind: "cli", tokenKind: "access-token" },
    })
    const rawAccessToken = tokens.access_token.slice(BETTER_AUTH_ACCESS_TOKEN_PREFIX.length)
    const storedAccess = await (await miniflare.getD1Database("AUTH_DB"))
      .prepare(`select "token", "clientId", "sessionId", "resources", "scopes" from "oauthAccessToken"`)
      .first<{ token: string; clientId: string; sessionId: string; resources: string; scopes: string }>()
    expect(storedAccess).toMatchObject({
      token: await betterAuthOAuthTokenHash(rawAccessToken),
      clientId: "claxedo-cli",
      sessionId: browserSession.session.id,
      resources: JSON.stringify([NATIVE_RESOURCE]),
    })
    expect(storedAccess?.token).not.toContain(rawAccessToken)
    expect(JSON.parse(storedAccess?.scopes ?? "[]")).toEqual(["openid", "profile", "email", "offline_access", "workspace:read"])
    const issuedRefresh = await evidenceDatabase.prepare(`select "sessionId", "authTime"
      from "oauthRefreshToken" where "generation" = 0`).first<{ sessionId: string; authTime: string | number }>()
    expect(issuedRefresh?.sessionId).toBe(browserSession.session.id)
    expect(new Date(issuedRefresh?.authTime ?? 0).getTime()).toBe(persistedEvidence?.authenticatedAt)

    await expect(evidenceDatabase.prepare(`update "authenticationEvidence" set "methods" = ?
      where "sessionId" = ?`).bind(JSON.stringify(["oauth:google"]), browserSession.session.id).run())
      .rejects.toThrow(/authentication evidence is immutable/)
    if (!persistedEvidence) throw new Error("Authentication evidence fixture is missing")
    await expect(evidenceDatabase.prepare(`delete from "authenticationEvidence" where "sessionId" = ?`)
      .bind(browserSession.session.id).run()).rejects.toThrow(/authentication evidence can be deleted only with its session/)
    // Simulate storage corruption after proving the schema itself blocks the
    // direct deletion. The request boundary must still reject both transports.
    await evidenceDatabase.prepare(`drop trigger "authenticationEvidence_no_direct_delete"`).run()
    await evidenceDatabase.prepare(`delete from "authenticationEvidence" where "sessionId" = ?`)
      .bind(browserSession.session.id).run()
    const missingCookieEvidence = await miniflare.dispatchFetch(`${API_ORIGIN}/__test/authenticate`, {
      headers: { cookie: sessionCookie.value, origin: APP_ORIGIN },
    })
    expect(missingCookieEvidence.status).toBe(401)
    const missingBearerEvidence = await miniflare.dispatchFetch(`${API_ORIGIN}/__test/authenticate`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })
    expect(missingBearerEvidence.status).toBe(401)
    await evidenceDatabase.prepare(`insert into "authenticationEvidence"
      ("sessionId", "subject", "authenticatedAt", "methods", "assurance", "createdAt")
      values (?, ?, ?, ?, ?, ?)`).bind(
        persistedEvidence.sessionId,
        persistedEvidence.subject,
        persistedEvidence.authenticatedAt,
        persistedEvidence.methods,
        persistedEvidence.assurance,
        persistedEvidence.createdAt,
      ).run()
    await evidenceDatabase.exec(`create trigger "authenticationEvidence_no_direct_delete" before delete on "authenticationEvidence" when exists (select 1 from "session" where "id" = old."sessionId") begin select raise(abort, 'authentication evidence can be deleted only with its session'); end;`)

    const refresh = await miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: "claxedo-cli",
        resource: NATIVE_RESOURCE,
      }),
    })
    expect(refresh.status).toBe(200)
    const rotated = (await refresh.json()) as { access_token?: unknown; refresh_token?: unknown }
    const rotatedRefreshToken = rotated.refresh_token
    const rotatedAccessToken = rotated.access_token
    if (typeof rotatedRefreshToken !== "string" || typeof rotatedAccessToken !== "string") {
      throw new Error(`Refresh grant did not rotate its refresh token: ${JSON.stringify(rotated)}`)
    }
    expect(rotatedRefreshToken).not.toBe(tokens.refresh_token)
    const refreshRows = await (await miniflare.getD1Database("AUTH_DB"))
      .prepare(`select "id", "revoked", "rotatedAt", "familyId", "parentId", "generation"
        from "oauthRefreshToken" order by "generation"`)
      .all<{
        id: string
        revoked: string | number | null
        rotatedAt: string | number | null
        familyId: string
        parentId: string | null
        generation: number
      }>()
    expect(refreshRows.results).toHaveLength(2)
    expect(refreshRows.results.filter((row) => row.revoked != null)).toHaveLength(1)
    expect(refreshRows.results[0]).toMatchObject({ parentId: null, generation: 0 })
    expect(refreshRows.results[1]).toMatchObject({
      familyId: refreshRows.results[0]?.familyId,
      parentId: refreshRows.results[0]?.id,
      generation: 1,
      revoked: null,
    })

    // Lost-response retry: a client whose refresh POST was answered but whose
    // response never arrived retries with the token that answer already
    // burned. Within `refreshTokenReuseInterval` the server must replay the
    // SAME successor pair instead of `invalid_grant` — a zero window turned
    // one dropped response into a full desktop sign-out (observed live on
    // staging: 400 on retry → credential invalidated → remote access torn
    // down mid-share).
    const replayed = await miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: "claxedo-cli",
        resource: NATIVE_RESOURCE,
      }),
    })
    expect(replayed.status, await replayed.clone().text()).toBe(200)
    const replayedTokens = (await replayed.json()) as { access_token?: unknown; refresh_token?: unknown }
    expect(replayedTokens.refresh_token).toBe(rotatedRefreshToken)
    expect(replayedTokens.access_token).toBe(rotatedAccessToken)
    const rowsAfterReplay = await (await miniflare.getD1Database("AUTH_DB"))
      .prepare(`select count(*) as "count" from "oauthRefreshToken"`)
      .first<{ count: number }>()
    expect(rowsAfterReplay?.count).toBe(2)

    const wrongClientRevoke = await miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/oauth2/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body({ token: rotatedRefreshToken, token_type_hint: "refresh_token", client_id: "claxedo-desktop" }),
    })
    expect(wrongClientRevoke.status).toBe(200)
    const survivesWrongClient = await miniflare.dispatchFetch(`${API_ORIGIN}/__test/authenticate`, {
      headers: { authorization: `Bearer ${rotatedAccessToken}` },
    })
    expect(survivesWrongClient.status, await survivesWrongClient.clone().text()).toBe(200)

    const afterWrongClientRefresh = await miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body({
        grant_type: "refresh_token",
        refresh_token: rotatedRefreshToken,
        client_id: "claxedo-cli",
        resource: NATIVE_RESOURCE,
      }),
    })
    expect(afterWrongClientRefresh.status, await afterWrongClientRefresh.clone().text()).toBe(200)
    const generationTwo = (await afterWrongClientRefresh.json()) as {
      access_token?: unknown
      refresh_token?: unknown
    }
    if (typeof generationTwo.access_token !== "string" || typeof generationTwo.refresh_token !== "string") {
      throw new Error(`Wrong-client revocation damaged the refresh family: ${JSON.stringify(generationTwo)}`)
    }

    const accessRevoke = await miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/oauth2/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body({ token: generationTwo.access_token, token_type_hint: "access_token", client_id: "claxedo-cli" }),
    })
    expect(accessRevoke.status).toBe(200)
    const revokedAccess = await miniflare.dispatchFetch(`${API_ORIGIN}/__test/authenticate`, {
      headers: { authorization: `Bearer ${generationTwo.access_token}` },
    })
    expect(revokedAccess.status).toBe(401)
    const revokedAccessSecret = generationTwo.access_token.slice(BETTER_AUTH_ACCESS_TOKEN_PREFIX.length)
    const revokedAccessRow = await evidenceDatabase.prepare(`select count(*) as "count"
      from "oauthAccessToken" where "token" = ?`)
      .bind(await betterAuthOAuthTokenHash(revokedAccessSecret))
      .first<{ count: number }>()
    expect(revokedAccessRow).toEqual({ count: 0 })

    const afterAccessRevokeRefresh = await miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body({
        grant_type: "refresh_token",
        refresh_token: generationTwo.refresh_token,
        client_id: "claxedo-cli",
        resource: NATIVE_RESOURCE,
      }),
    })
    expect(afterAccessRevokeRefresh.status, await afterAccessRevokeRefresh.clone().text()).toBe(200)
    const terminalGeneration = (await afterAccessRevokeRefresh.json()) as {
      access_token?: unknown
      refresh_token?: unknown
    }
    if (typeof terminalGeneration.access_token !== "string" || typeof terminalGeneration.refresh_token !== "string") {
      throw new Error(`Access-token revocation damaged the refresh family: ${JSON.stringify(terminalGeneration)}`)
    }

    const revoke = await miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/oauth2/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body({
        token: terminalGeneration.refresh_token,
        token_type_hint: "refresh_token",
        client_id: "claxedo-cli",
      }),
    })
    expect(revoke.status).toBe(200)
    const familyAccessAfterRevoke = await miniflare.dispatchFetch(`${API_ORIGIN}/__test/authenticate`, {
      headers: { authorization: `Bearer ${terminalGeneration.access_token}` },
    })
    expect(familyAccessAfterRevoke.status).toBe(401)
    const replay = await miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: "claxedo-cli",
        resource: NATIVE_RESOURCE,
      }),
    })
    expect(replay.status).not.toBe(200)
    const revokedRefresh = await miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body({
        grant_type: "refresh_token",
        refresh_token: terminalGeneration.refresh_token,
        client_id: "claxedo-cli",
        resource: NATIVE_RESOURCE,
      }),
    })
    expect(revokedRefresh.status).not.toBe(200)
    const revokedRows = await evidenceDatabase.prepare(`select
      (select count(*) from "oauthRefreshToken" where "familyId" = ?) as "refreshTokens",
      (select count(*) from "oauthAccessToken" where "clientId" = ? and "userId" = ?) as "accessTokens"`)
      .bind(refreshRows.results[0]?.familyId, "claxedo-cli", browserSession.user.id)
      .first<{ refreshTokens: number; accessTokens: number }>()
    expect(revokedRows).toEqual({ refreshTokens: 0, accessTokens: 0 })

    const databaseForRace = await miniflare.getD1Database("AUTH_DB")
    const user = await databaseForRace.prepare(`select "id" from "user" where "email" = ?`)
      .bind("unit-one@example.test")
      .first<{ id: string }>()
    if (!user) throw new Error("Refresh race fixture user is missing")
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 60_000)
    const raceRawToken = "concurrent-refresh-secret"
    await databaseForRace.batch([
      databaseForRace.prepare(`insert into "oauthRefreshToken" (
        "id", "token", "clientId", "userId", "resources", "expiresAt", "createdAt", "scopes",
        "familyId", "generation"
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          "concurrent-parent",
          await betterAuthOAuthTokenHash(raceRawToken),
          "claxedo-cli",
          user.id,
          JSON.stringify([NATIVE_RESOURCE]),
          expiresAt.toISOString(),
          now.toISOString(),
          JSON.stringify(["offline_access", "workspace:read"]),
          "concurrent-family",
          0,
        ),
      databaseForRace.prepare(`insert into "oauthRefreshToken" (
        "id", "token", "clientId", "userId", "resources", "expiresAt", "createdAt", "scopes",
        "familyId", "generation"
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          "unaffected-parent",
          await betterAuthOAuthTokenHash("unaffected-refresh-secret"),
          "claxedo-cli",
          user.id,
          JSON.stringify([NATIVE_RESOURCE]),
          expiresAt.toISOString(),
          now.toISOString(),
          JSON.stringify(["offline_access", "workspace:read"]),
          "unaffected-family",
          0,
        ),
    ])
    const raceRequest = () => miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body({
        grant_type: "refresh_token",
        refresh_token: `${BETTER_AUTH_REFRESH_TOKEN_PREFIX}${raceRawToken}`,
        client_id: "claxedo-cli",
        resource: NATIVE_RESOURCE,
      }),
    })
    const raced = await Promise.all([raceRequest(), raceRequest()])
    const racedBodies = await Promise.all(raced.map((response) => response.clone().json().catch(() => null)))
    // Exactly one rotation happens; the second request either replays the
    // SAME successor pair (`refreshTokenReuseInterval` — it read the parent
    // after the winner committed) or loses the atomic rotation outright (it
    // read the parent before the commit), which still invalidates the family
    // as a double-spend. What must never happen: two DIFFERENT pairs, or
    // zero successes.
    const successBodies = raced
      .map((response, index) => (response.status === 200 ? racedBodies[index] : undefined))
      .filter((value): value is { access_token: string; refresh_token: string } =>
        !!value && typeof value === "object" && "access_token" in value)
    expect(successBodies.length).toBeGreaterThanOrEqual(1)
    expect(new Set(successBodies.map((value) => `${value.access_token}\n${value.refresh_token}`)).size).toBe(1)
    for (const [index, response] of raced.entries()) {
      if (response.status !== 200) expect(racedBodies[index]).toMatchObject({ error: "invalid_grant" })
    }
    const familyCounts = await databaseForRace.prepare(`select
      (select count(*) from "oauthRefreshToken" where "familyId" = 'concurrent-family') as "attackedRefresh",
      (select count(*) from "oauthAccessToken" as access where "refreshId" is not null and not exists
        (select 1 from "oauthRefreshToken" as refresh where refresh."id" = access."refreshId")) as "orphanedAccess",
      (select count(*) from "oauthRefreshToken" where "familyId" = 'unaffected-family') as "unaffectedRefresh"`)
      .first<{ attackedRefresh: number; orphanedAccess: number; unaffectedRefresh: number }>()
    expect(familyCounts).toMatchObject({ orphanedAccess: 0, unaffectedRefresh: 1 })
    // Replay path keeps parent+child; atomic-conflict path invalidates the
    // family. Both requests succeeding REQUIRES the family to have survived.
    expect([0, 2]).toContain(familyCounts?.attackedRefresh)
    if (successBodies.length === 2) expect(familyCounts?.attackedRefresh).toBe(2)
    const racedAccessToken = successBodies[0]?.access_token
    if (typeof racedAccessToken === "string") {
      const raw = racedAccessToken.slice(BETTER_AUTH_ACCESS_TOKEN_PREFIX.length)
      const surviving = await databaseForRace.prepare(`select count(*) as "count" from "oauthAccessToken"
        where "token" = ?`).bind(await betterAuthOAuthTokenHash(raw)).first<{ count: number }>()
      expect(surviving?.count).toBe(familyCounts?.attackedRefresh === 0 ? 0 : 1)
    }

    const desktopRedirectUri = "http://127.0.0.1:49152/claxedo/auth/callback"
    const desktopCodeVerifier = "desktop-pkce-verifier-that-is-forty-three-bytes"
    const pkce = await miniflare.dispatchFetch(
      `${API_ORIGIN}/api/auth/oauth2/authorize?${new URLSearchParams({
        client_id: "claxedo-desktop",
        response_type: "code",
        redirect_uri: desktopRedirectUri,
        scope: "openid profile email offline_access workspace:read workspace:write",
        resource: NATIVE_RESOURCE,
        state: "desktop-state",
        code_challenge: await pkceChallenge(desktopCodeVerifier),
        code_challenge_method: "S256",
      })}`,
      { headers: { cookie: sessionCookie.value, origin: APP_ORIGIN }, redirect: "manual" },
    )
    expect(pkce.status, await pkce.clone().text()).toBe(200)
    const authorization = (await pkce.json()) as { redirect?: unknown; url?: unknown }
    expect(authorization.redirect).toBe(true)
    expect(typeof authorization.url).toBe("string")
    const consentUrl = new URL(String(authorization.url))
    expect(`${consentUrl.origin}${consentUrl.pathname}`).toBe(`${APP_ORIGIN}/oauth/consent`)
    const consent = await miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: sessionCookie.value,
        origin: APP_ORIGIN,
      },
      body: JSON.stringify({ accept: true, oauth_query: consentUrl.search }),
    })
    expect(consent.status, await consent.clone().text()).toBe(200)
    const consentResult = (await consent.json()) as { redirect?: unknown; url?: unknown }
    expect(consentResult.redirect).toBe(true)
    expect(typeof consentResult.url).toBe("string")
    const callback = new URL(String(consentResult.url))
    expect(`${callback.origin}${callback.pathname}`).toBe(desktopRedirectUri)
    expect(callback.searchParams.get("state")).toBe("desktop-state")
    const authorizationCode = callback.searchParams.get("code")
    expect(authorizationCode).toBeTruthy()

    const desktopToken = await miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body({
        grant_type: "authorization_code",
        client_id: "claxedo-desktop",
        code: authorizationCode!,
        code_verifier: desktopCodeVerifier,
        redirect_uri: desktopRedirectUri,
        resource: NATIVE_RESOURCE,
      }),
    })
    expect(desktopToken.status, await desktopToken.clone().text()).toBe(200)
    const desktopTokens = (await desktopToken.json()) as { access_token?: unknown; refresh_token?: unknown }
    expect(desktopTokens.access_token).toEqual(expect.any(String))
    expect(desktopTokens.refresh_token).toEqual(expect.any(String))

    const signOut = await miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/sign-out`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: sessionCookie.value, origin: APP_ORIGIN },
      body: "{}",
    })
    expect(signOut.status).toBe(200)
    const afterSignOut = await miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/get-session`, {
      headers: { cookie: sessionCookie.value, origin: APP_ORIGIN },
    })
    expect((await afterSignOut.json()) as unknown).toBeNull()

    const database = await miniflare.getD1Database("AUTH_DB")
    const counts = await database
      .prepare(`select
        (select count(*) from "user") as users,
        (select count(*) from "oauthClientResource") as links,
        (select count(*) from "deviceCode" where status = 'approved') as approved,
        (select count(*) from "authenticationEvidence") as evidence`)
      .first<{ users: number; links: number; approved: number; evidence: number }>()
    expect(counts).toMatchObject({ users: 1, links: 3, evidence: 0 })
  })

  test("runs machine enrollment → owner assignment → heartbeat v2 → relay-target routing end-to-end", async () => {
    // The whole remote-sharing grain, through the REAL routes inside workerd,
    // against the REAL D1 authority, authenticated by Better Auth: enroll the
    // machine once, assign a workspace to it, ack it with ONE P-256 signature
    // over the exact v2 payload literal, and watch the service-side relay
    // resolver flip to routable — then unassign and watch it flip back.
    const email = "host-owner@example.test"
    const signUp = await miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_ORIGIN },
      body: JSON.stringify({ name: "Host Owner", email, password: "correct horse battery staple" }),
    })
    expect(signUp.status, await signUp.clone().text()).toBe(200)
    const delivered = await miniflare.dispatchFetch(
      `${API_ORIGIN}/__test/last-email?recipient=${encodeURIComponent(email)}`,
    )
    const { actionUrl } = (await delivered.json()) as { actionUrl: string }
    await miniflare.dispatchFetch(actionUrl, { headers: { origin: APP_ORIGIN }, redirect: "manual" })
    const signIn = await miniflare.dispatchFetch(`${API_ORIGIN}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_ORIGIN },
      body: JSON.stringify({ email, password: "correct horse battery staple" }),
    })
    expect(signIn.status, await signIn.clone().text()).toBe(200)
    const owner = cookieFrom(signIn)

    const call = (path: string, init: { method?: string; body?: unknown } = {}) =>
      miniflare.dispatchFetch(`${API_ORIGIN}${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: {
          cookie: owner.value,
          origin: APP_ORIGIN,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      })
    const relayTarget = async (workspaceId: string) => {
      const response = await miniflare.dispatchFetch(
        `${API_ORIGIN}/__test/relay-target?workspaceId=${encodeURIComponent(workspaceId)}`,
      )
      expect(response.status).toBe(200)
      return (await response.json()) as { active: boolean; hostId?: string; backing?: string }
    }

    // The Host Connector's machine key. The server only ever sees the public
    // half; every proof below is a fresh ECDSA P-256 signature.
    const hostId = "host_spike_machine"
    const workspaceId = "ws_spike_e2e"
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
    const privateJwk = pair.privateKey.export({ format: "jwk" })
    const publicKey = JSON.stringify(pair.publicKey.export({ format: "jwk" }))
    const signPayload = (payload: string) =>
      signData("sha256", Buffer.from(payload), {
        key: createPrivateKey({ key: privateJwk, format: "jwk" }),
        dsaEncoding: "ieee-p1363",
      }).toString("base64url")

    // 1. Machine enrollment: one-use nonce, then the signed enrollment.
    const request = await call("/api/claxedo/host/enrollments/requests", { body: { hostId } })
    expect(request.status, await request.clone().text()).toBe(200)
    const challenge = (await request.json()) as { request_id: string; nonce: string }
    const enroll = await call("/api/claxedo/host/enrollments", {
      body: {
        hostId,
        publicKey,
        requestId: challenge.request_id,
        signature: signPayload(
          hostEnrollmentPayload({ hostId, requestId: challenge.request_id, nonce: challenge.nonce }),
        ),
        displayName: "Spike laptop",
      },
    })
    expect(enroll.status, await enroll.clone().text()).toBe(200)
    expect(await enroll.json()).toMatchObject({ enrollment: { host_id: hostId, display_name: "Spike laptop" } })

    // Enrolled but not yet assigned: nothing routes.
    expect(await relayTarget(workspaceId)).toEqual({ active: false })

    // 2. Owner assignment cold-registers the workspace and mints the Host
    //    Tunnel Token immediately — no machine signature on this leg.
    const assign = await call(`/api/workspace/${workspaceId}/host-assignment`, {
      body: { hostId, displayName: "Spike workspace", repoName: "spike", gitBranch: "main" },
    })
    expect(assign.status, await assign.clone().text()).toBe(200)
    expect(await assign.json()).toMatchObject({
      assignment: { assigned: true, workspace_id: workspaceId, host_id: hostId },
      hostTunnel: { hostTunnelToken: `htt-${hostId}:${workspaceId}`, relayUrl: "https://relay.claxedo.test" },
    })

    // Assigned but not yet acked by the machine: still not routable.
    expect(await relayTarget(workspaceId)).toEqual({ active: false })

    // 3. Heartbeat v2: ONE signature over the exact payload literal covers the
    //    served set. A signature over a DIFFERENT set must be refused first.
    const forged = await call("/api/claxedo/host/enrollments/heartbeat", {
      body: {
        hostId,
        signature: signPayload(hostEnrollmentHeartbeatPayloadV2({ hostId, workspaceIds: [] })),
        workspaceIds: [workspaceId],
      },
    })
    expect(forged.status).toBe(500)
    expect(await relayTarget(workspaceId)).toEqual({ active: false })

    const beat = await call("/api/claxedo/host/enrollments/heartbeat", {
      body: {
        hostId,
        signature: signPayload(hostEnrollmentHeartbeatPayloadV2({ hostId, workspaceIds: [workspaceId] })),
        workspaceIds: [workspaceId],
      },
    })
    expect(beat.status, await beat.clone().text()).toBe(200)
    const beatBody = (await beat.json()) as Record<string, unknown>
    expect(beatBody).toMatchObject({
      assigned_workspace_ids: [workspaceId],
      hostTunnel: {
        hostTunnelToken: `htt-${hostId}:${workspaceId}`,
        hostId,
        workspaceIds: [workspaceId],
        relayUrl: "https://relay.claxedo.test",
      },
    })
    expect(beatBody.expires_at).toEqual(expect.any(Number))

    // 4. Assigned ∩ acked ∩ live lease → the relay routes to this machine.
    expect(await relayTarget(workspaceId)).toEqual({
      active: true,
      hostId,
      backing: "local-worktree",
    })

    // 5. Unassign → nothing routes, even though the lease is still live.
    const unassign = await call(`/api/workspace/${workspaceId}/host-assignment`, { method: "DELETE" })
    expect(unassign.status, await unassign.clone().text()).toBe(200)
    expect(await unassign.json()).toEqual({ unassigned: true })
    expect(await relayTarget(workspaceId)).toEqual({ active: false })
  })
})
