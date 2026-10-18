import { fileURLToPath } from "node:url"
import { readFile } from "node:fs/promises"
import { expect } from "vitest"
import { Hono } from "hono"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"
import type { AuthEmailMessage } from "../platform/auth/better-auth-configuration"
import { composeBetterAuthD1UserDeployedControlPlane } from "../authority/adapters/worker/better-auth-d1-compose"
import { createHostedCoreApp } from "../deployments/hosted-shared/hosted-core-app"
import { createIdempotencyCoordinator, memoryIdempotencyStore } from "../authority/http/idempotency"
import {
  betterAuthIntrospectionClientSecretCiphertext,
  betterAuthNativeClientProvisioningStatements,
} from "../platform/auth/better-auth-native-clients"
import { miniflareControlPlaneDatabase } from "./control-plane-migrations"
import { generateCanonicalOwnerClaim, ownerClaimMutationSql, ownerClaimProvisioning } from "../../scripts/deploy/claim-owner"
import { USER_DEPLOYED_OWNER_CLAIM_HEADER } from "../authority/adapters/d1/owner-identity"
import type { D1CoreAuthorityBoundary } from "../authority/adapters/d1/core-authority"

export const USER_DEPLOYED_API = "https://api.example.test"
export const USER_DEPLOYED_APP = "https://app.example.test"
export const USER_DEPLOYED_DEPLOYMENT_ID = "deployment-1"

const AUTH_MIGRATIONS = ["0001_better_auth.sql", "0003_authentication_evidence.sql"]
const BETTER_AUTH_SECRET = "better-auth-secret-that-is-at-least-thirty-two-bytes"
const INTROSPECTION_SECRET = "introspection-secret-that-is-also-at-least-thirty-two-bytes"

/** A signed-in person's session cookie plus the app origin a browser sends with it. */
export type SignedInPerson = { cookie: string; origin: string }

export type UserDeployedBetterAuthApp = {
  /** The Worker's app: Better Auth under `/api/auth`, the hosted core app under everything else, every request stamped with an edge client address. */
  app: Hono
  descriptor: ReturnType<typeof composeBetterAuthD1UserDeployedControlPlane>["options"]["authentication"]["descriptor"]
  /** The composition's D1 authority, the one object the plane's services hold as their `authority`. */
  authority: D1CoreAuthorityBoundary
  authDatabase: D1Database
  controlPlaneDatabase: D1Database
  request(pathname: string, init?: RequestInit): Promise<Response>
  /** Signs a verified person up and in through the email method; the password is the rig's. */
  signIn(email: string): Promise<SignedInPerson>
  /** The deployer's `claim-owner` step for the signed-in person: a one-use claim registered and redeemed; answers their Better Auth subject. */
  claimOwnership(person: SignedInPerson): Promise<string>
  dispose(): Promise<void>
}

async function migrateAuth(database: D1Database) {
  for (const name of AUTH_MIGRATIONS) {
    const sql = (await readFile(fileURLToPath(new URL(`../../migrations/auth/${name}`, import.meta.url)), "utf8")).replace(/^\s*--.*$/gm, "")
    for (const statement of sql.split(/;\s*\n\s*\n/).map((part) => part.trim()).filter(Boolean)) await database.prepare(statement).run()
  }
}

/**
 * The user-deployed Better Auth + D1 composition the Worker serves, over two
 * real D1 databases on Miniflare, with the native OAuth clients provisioned
 * and the owner claimable: what a test needs to sign a person in with a real
 * cookie and spend it on signed routes. `databases` wraps each database
 * before the composition sees it, so a test can count or record what the
 * composition reads.
 */
export async function userDeployedBetterAuthApp(
  databases: { auth?: (database: D1Database) => D1Database; controlPlane?: (database: D1Database) => D1Database } = {},
): Promise<UserDeployedBetterAuthApp> {
  const instance = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", compatibilityDate: "2025-05-01", d1Databases: ["AUTH_DB"] })
  const authDatabase = await instance.getD1Database("AUTH_DB")
  await migrateAuth(authDatabase)
  const ciphertext = await betterAuthIntrospectionClientSecretCiphertext(BETTER_AUTH_SECRET, INTROSPECTION_SECRET)
  for (const sql of betterAuthNativeClientProvisioningStatements(USER_DEPLOYED_API, ciphertext)) await authDatabase.prepare(sql).run()
  const controlPlane = await miniflareControlPlaneDatabase()
  const keys = await generateKeyPair("EdDSA", { extractable: true })
  const mail: AuthEmailMessage[] = []
  const composed = composeBetterAuthD1UserDeployedControlPlane({
    env: {
      CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
      CLAXEDO_PRODUCT_POSTURE: "user-deployed",
      CLAXEDO_SANDBOX_POSTURE: "control-plane-only",
      CLAXEDO_DEPLOYMENT_ID: USER_DEPLOYED_DEPLOYMENT_ID,
      CLAXEDO_DEPLOYMENT_MODE: "hosted",
      CLAXEDO_AUTH_METHODS: "email-password",
      CLAXEDO_AUTH_CONFIGURATION_ID: "sha256:auth-configuration",
      BETTER_AUTH_URL: USER_DEPLOYED_API,
      CLAXEDO_APP_ORIGIN: USER_DEPLOYED_APP,
      BETTER_AUTH_SECRET,
      CLAXEDO_AUTH_INTROSPECTION_SECRET: INTROSPECTION_SECRET,
      CLAXEDO_WORKSPACE_RELAY_URL: "https://relay.example.test",
      CLAXEDO_RELAY_RESOLVER_TOKEN: "relay-resolver-secret",
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(keys.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(keys.publicKey),
    },
    emailSender: { send: async (message) => { mail.push(message) } },
    authDatabase: databases.auth?.(authDatabase) ?? authDatabase,
    controlPlaneDatabase: databases.controlPlane?.(controlPlane.database) ?? controlPlane.database,
    descriptorExpiresAt: Date.now() + 3_600_000,
    product: { kind: "user-deployed", organization: { id: "org_deployment", name: "Deployment" }, ownerBootstrap: "one-use-claim" },
  })
  await composed.authReady
  const core = createHostedCoreApp(composed.plane, {
    ...composed.options,
    idempotency: createIdempotencyCoordinator(memoryIdempotencyStore()),
    liveSyncRoom: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response(null, { status: 503 }) }) },
    sharedRateLimitStore: { periodSeconds: 60, check: async () => ({ allowed: true }) },
  })
  let requests = 0
  const app = new Hono()
  // The Cloudflare edge stamps every request with its client address, and Better Auth budgets each address; a test that names its own address keeps it.
  app.use((c, next) => {
    ++requests
    if (!c.req.raw.headers.has("cf-connecting-ip")) {
      c.req.raw.headers.set("cf-connecting-ip", `10.0.${Math.floor(requests / 250)}.${requests % 250}`)
    }
    return next()
  })
  app.all("/api/auth/*", (c) => composed.authHandler(c.req.raw))
  app.all("*", (c) => core.fetch(c.req.raw))

  const request = async (pathname: string, init?: RequestInit) => await app.request(new URL(pathname, USER_DEPLOYED_API).toString(), init)
  const json = (body: unknown, headers: Record<string, string> = {}) =>
    ({ method: "POST", headers: { "content-type": "application/json", origin: USER_DEPLOYED_APP, ...headers }, body: JSON.stringify(body) })
  return {
    app,
    descriptor: composed.options.authentication.descriptor,
    authority: composed.plane.services.authority as D1CoreAuthorityBoundary,
    authDatabase,
    controlPlaneDatabase: controlPlane.database,
    request,
    async signIn(email) {
      const password = "correct-horse-battery-staple"
      expect((await request("/api/auth/sign-up/email", json({ email, password, name: email }))).status).toBe(200)
      const verification = mail.findLast((message) => message.recipient === email)?.actionUrl
      if (!verification) throw new Error(`no verification mail for ${email}`)
      expect([200, 302]).toContain((await app.request(verification)).status)
      const signedIn = await request("/api/auth/sign-in/email", json({ email, password }))
      const cookie = /__Secure-claxedo\.session_token=[^;]+/.exec(signedIn.headers.get("set-cookie") ?? "")?.[0]
      if (!cookie) throw new Error(`sign-in set no session cookie: ${signedIn.status} ${await signedIn.text()}`)
      return { cookie, origin: USER_DEPLOYED_APP }
    },
    async claimOwnership(person) {
      const session = await request("/api/auth/get-session", { headers: person })
      const subject = ((await session.json()) as { user: { id: string } }).user.id
      const claim = generateCanonicalOwnerClaim()
      await controlPlane.database.prepare(ownerClaimMutationSql(await ownerClaimProvisioning({ deploymentId: USER_DEPLOYED_DEPLOYMENT_ID, apiOrigin: USER_DEPLOYED_API, subject, claim }))).run()
      const redeemed = await request("/api/claxedo/auth/bootstrap-owner", json({}, { ...person, [USER_DEPLOYED_OWNER_CLAIM_HEADER]: claim }))
      expect(redeemed.status, await redeemed.clone().text()).toBe(200)
      return subject
    },
    async dispose() {
      await instance.dispose()
      await controlPlane.dispose()
    },
  }
}
