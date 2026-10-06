import path from "node:path"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import { build } from "esbuild"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"
import { sourceClosure } from "@claxedo/server-core/platform/governance/source-closure"
import { unusedSandboxStart } from "../../../test-support/inline-sandbox-start"

import { decodeJwt } from "jose"
import type { ControlPlanePrincipal } from "@claxedo/server-core/platform/auth/authentication"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import { resolveRuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"
import type { D1CoreAuthorityBoundary } from "../d1/core-authority"
import { composeBetterAuthD1UserDeployedControlPlane } from "./better-auth-d1-compose"
import { applyControlPlaneBaseline } from "../../../test-support/control-plane-migrations"

const ROOT = path.resolve(import.meta.dirname, "../../../..")
const AUTH_MIGRATIONS = ["0001_better_auth.sql", "0003_authentication_evidence.sql"]
  .map((name) => fileURLToPath(new URL(`../../../../migrations/auth/${name}`, import.meta.url)))

const privateKey = [
  "-----BEGIN PRIVATE KEY-----",
  "MC4CAQAwBQYDK2VwBCIEIO9Cnka2wu8+h1a1Rd+bDejAsq2oUxO6BnDKjrHrpw54",
  "-----END PRIVATE KEY-----",
].join("\n")
const publicKey = [
  "-----BEGIN PUBLIC KEY-----",
  "MCowBQYDK2VwAyEAvy35aYUPAjG/Zac6ER0AiB0BZteRmYnpMZ5b1U0SJGs=",
  "-----END PUBLIC KEY-----",
].join("\n")

const active: Miniflare[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function databases() {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["AUTH_DB", "CONTROL_PLANE_DB"],
  })
  active.push(instance)
  const authDatabase = await instance.getD1Database("AUTH_DB")
  const controlPlaneDatabase = await instance.getD1Database("CONTROL_PLANE_DB")
  await applyMigrations(authDatabase, AUTH_MIGRATIONS)
  await applyControlPlaneBaseline(controlPlaneDatabase)
  return { authDatabase, controlPlaneDatabase }
}

function env(overrides: Record<string, string> = {}) {
  return {
    CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
    CLAXEDO_PRODUCT_POSTURE: "user-deployed",
    CLAXEDO_SANDBOX_POSTURE: "control-plane-only",
    CLAXEDO_DEPLOYMENT_ID: "deployment-1",
    CLAXEDO_DEPLOYMENT_MODE: "hosted",
    CLAXEDO_AUTH_METHODS: "github",
    CLAXEDO_AUTH_CONFIGURATION_ID: "sha256:auth-configuration",
    BETTER_AUTH_URL: "https://api.example.test",
    CLAXEDO_APP_ORIGIN: "https://app.example.test",
    BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-thirty-two-bytes",
    CLAXEDO_AUTH_INTROSPECTION_SECRET: "introspection-secret-that-is-also-at-least-thirty-two-bytes",
    GITHUB_CLIENT_ID: "github-client",
    GITHUB_CLIENT_SECRET: "github-secret",
    CLAXEDO_WORKSPACE_RELAY_URL: "https://relay.example.test",
    CLAXEDO_RELAY_RESOLVER_TOKEN: "relay-resolver-secret",
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: privateKey,
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: publicKey,
    ...overrides,
  }
}


async function applyMigrations(database: D1Database, paths: string[]) {
  for (const migrationPath of paths) {
    const migration = (await readFile(migrationPath, "utf8")).replace(/^\s*--.*$/gm, "")
    for (const statement of migration.split(/;\s*\n\s*\n/).map((part) => part.trim()).filter(Boolean)) {
      await database.prepare(statement).run()
    }
  }
}

/** The same database, with every prepared statement's SQL recorded. */
function recording(database: D1Database, seen: string[]): D1Database {
  return new Proxy(database, {
    get(target, key) {
      if (key === "prepare") {
        return (sql: string) => {
          seen.push(sql)
          return target.prepare(sql)
        }
      }
      const value = Reflect.get(target, key)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

describe("Better Auth + D1 user-deployed composition", () => {

  test("is reusable only after both databases answered through it", async () => {
    const { authDatabase, controlPlaneDatabase } = await databases()
    const authSql: string[] = []
    const controlSql: string[] = []
    const composed = composeBetterAuthD1UserDeployedControlPlane({
      env: env(),
      authDatabase: recording(authDatabase, authSql),
      controlPlaneDatabase: recording(controlPlaneDatabase, controlSql),
      descriptorExpiresAt: 1_900_000_000_000,
      now: () => 1_800_000_000_000,
      product: {
        kind: "user-deployed",
        organization: { id: "org_deployment", name: "My deployment" },
        ownerIdentity: {
          adapter: "better-auth",
          issuer: "https://api.example.test/api/auth",
          subject: "owner-subject",
        },
      },
    })
    await composed.authReady
    // The session read goes through Better Auth's adapter, so a wedge anywhere
    // on that path keeps the composition unsettled instead of being reused.
    expect(authSql.some((sql) => /from "session"/.test(sql) && /"token"/.test(sql))).toBe(true)
    expect(controlSql.some((sql) => sql.trim() === "select 1")).toBe(true)
  })

  test("exposes the per-org credential store over CONTROL_PLANE_DB once the hosted credential flag is on", async () => {
    const { authDatabase, controlPlaneDatabase } = await databases()
    const input = {
      authDatabase,
      controlPlaneDatabase,
      descriptorExpiresAt: 1_900_000_000_000,
      now: () => 1_800_000_000_000,
      product: {
        kind: "user-deployed" as const,
        organization: { id: "org_deployment", name: "My deployment" },
        ownerBootstrap: "one-use-claim" as const,
      },
    }
    // Flag off: no store, and nothing about the KEK is required.
    const off = composeBetterAuthD1UserDeployedControlPlane({ ...input, env: env() })
    expect(off.plane.orgCredentials).toBeUndefined()
    await off.authReady.catch(() => undefined)

    // Flag on without a KEK: the composition refuses to start.
    expect(() =>
      composeBetterAuthD1UserDeployedControlPlane({ ...input, env: env({ CLAXEDO_HOSTED_CREDENTIALS_ENABLED: "1" }) }),
    ).toThrow(/CLAXEDO_CREDENTIALS_KEK/)

    const composed = composeBetterAuthD1UserDeployedControlPlane({
      ...input,
      env: env({
        CLAXEDO_HOSTED_CREDENTIALS_ENABLED: "1",
        CLAXEDO_CREDENTIALS_KEK: Buffer.alloc(32, 7).toString("base64"),
      }),
    })
    expect(await composed.plane.services.credentials.listCredentials("org_deployment")).toEqual([])
    const store = composed.plane.orgCredentials!("org_deployment")
    await store.putCredential({ owner: null, provider_id: "openai", kind: "api_key", source: "managed", secret: "sk-composed" })
    expect(await store.resolveCredentialSecret?.("openai")).toBe("sk-composed")
    const stored = await controlPlaneDatabase
      .prepare("select org_id, secret_envelope from hosted_provider_credentials")
      .all<{ org_id: string; secret_envelope: string }>()
    expect(stored.results).toEqual([{ org_id: "org_deployment", secret_envelope: expect.stringMatching(/^cenc1:/) }])
    expect(stored.results[0].secret_envelope).not.toContain("sk-composed")
    // Let Better Auth's init settle before the databases are disposed.
    await composed.authReady.catch(() => undefined)
  })

  test("full-hosted composes the sandbox manager over the injected driver and lease store, and admits cloud workspaces", async () => {
    const { authDatabase, controlPlaneDatabase } = await databases()
    const { createMemoryLeaseStore } = await import("@claxedo/sandbox-manager/stores/memory")
    const sandboxDriver = (id: string) => ({
      id,
      metadata: {
        driverRunsIn: ["worker"],
        hostStopBehavior: "suspends-host",
        hostResumeBehavior: "same-host",
        targetAccess: "relay",
        secretBrokering: "native",
        egressControl: "hosts-and-cidrs",
        persistence: {
          resume: "same-sandbox",
          capture: "none",
          clone: false,
          captureSource: "not-applicable",
          retention: "not-applicable",
          restoreMount: "not-applicable",
        },
      },
      ensureHost: async () => { throw new Error("not exercised") },
    } as unknown as NonNullable<Parameters<typeof composeBetterAuthD1UserDeployedControlPlane>[0]["sandbox"]>["driver"])
    const driver = sandboxDriver("cloudflare")
    const input = {
      authDatabase,
      controlPlaneDatabase,
      descriptorExpiresAt: 1_900_000_000_000,
      now: () => 1_800_000_000_000,
      product: {
        kind: "user-deployed" as const,
        organization: { id: "org_deployment", name: "My deployment" },
        ownerBootstrap: "one-use-claim" as const,
      },
    }
    const sandbox = { driver, leaseStore: createMemoryLeaseStore(), start: unusedSandboxStart, refresh: unusedSandboxStart }
    const composed = composeBetterAuthD1UserDeployedControlPlane({
      ...input,
      env: env({ CLAXEDO_SANDBOX_POSTURE: "full-hosted", CLAXEDO_SANDBOX_DRIVER: "cloudflare" }),
      sandbox,
    })
    expect(composed.plane.services.sandbox.sandboxManager).toBeDefined()
    // The placement every cloud root this deployment allocates is stored under.
    expect(composed.plane.services.sandbox.defaultDriver).toBe("cloudflare")
    expect(await composed.options.cloudWorkspaceAdmission({} as never)).toBeUndefined()
    await composed.authReady.catch(() => undefined)

    // Fail closed in both directions: a posture without its driver, and a
    // driver on a posture that promised none.
    expect(() => composeBetterAuthD1UserDeployedControlPlane({
      ...input,
      env: env({ CLAXEDO_SANDBOX_POSTURE: "full-hosted", CLAXEDO_SANDBOX_DRIVER: "cloudflare" }),
    })).toThrow(/full-hosted Better Auth \+ D1 requires/)
    expect(() => composeBetterAuthD1UserDeployedControlPlane({
      ...input,
      env: env({ CLAXEDO_SANDBOX_POSTURE: "full-hosted", CLAXEDO_SANDBOX_DRIVER: "fetch" }),
      sandbox,
    })).toThrow(/full-hosted Better Auth \+ D1 requires/)
    expect(() => composeBetterAuthD1UserDeployedControlPlane({ ...input, env: env(), sandbox })).toThrow(
      /must not configure CLAXEDO_SANDBOX_DRIVER or inject a sandbox/,
    )
    // The fetch bridge provisions through an operator-run service instead of a
    // catalog driver. The release pipeline certifies it, so a composition that
    // could not declare it would refuse every cloud root on that posture.
    const bridged = composeBetterAuthD1UserDeployedControlPlane({
      ...input,
      env: env({ CLAXEDO_SANDBOX_POSTURE: "full-hosted", CLAXEDO_SANDBOX_DRIVER: "fetch" }),
      sandbox: { driver: sandboxDriver("fetch"), leaseStore: createMemoryLeaseStore(), start: unusedSandboxStart, refresh: unusedSandboxStart },
    })
    expect(bridged.plane.services.sandbox.sandboxManager).toBeDefined()
    expect(bridged.plane.services.sandbox.defaultDriver).toBe("fetch")
    expect(await bridged.options.cloudWorkspaceAdmission({} as never)).toBeUndefined()
    await bridged.authReady.catch(() => undefined)

    const plain = composeBetterAuthD1UserDeployedControlPlane({ ...input, env: env() })
    expect(plain.plane.services.sandbox.sandboxManager).toBeUndefined()
    expect(plain.plane.services.sandbox.defaultDriver).toBeUndefined()
    expect((await plain.options.cloudWorkspaceAdmission({} as never))?.status).toBe(403)
    await plain.authReady.catch(() => undefined)
  })

  test("composes the real auth, authority and user-deployed posture", async () => {
    const { authDatabase, controlPlaneDatabase } = await databases()
    const composed = composeBetterAuthD1UserDeployedControlPlane({
      env: env(),
      authDatabase,
      controlPlaneDatabase,
      descriptorExpiresAt: 1_900_000_000_000,
      now: () => 1_800_000_000_000,
      product: {
        kind: "user-deployed",
        organization: { id: "org_deployment", name: "My deployment" },
        ownerIdentity: {
          adapter: "better-auth",
          issuer: "https://api.example.test/api/auth",
          subject: "owner-subject",
        },
      },
    })

    await composed.authReady
    expect(composed.plane.services.authority).toBeDefined()
    expect(composed.plane.privateSessionAuthority).toBeDefined()
    expect(composed.plane.runtimeSessionAuthority).toBeDefined()
    expect(composed.plane.services.auth.config).toMatchObject({ enabled: true, adapter: "better-auth" })
    expect(composed.options.authentication.descriptor).toMatchObject({
      adapter: "better-auth",
      deploymentId: "deployment-1",
      browser: { transport: "cookie" },
      native: {
        cli: { flow: "device-authorization" },
        desktop: { flow: "authorization-code-pkce" },
      },
    })
    expect(composed.product).toMatchObject({
      productPosture: "user-deployed",
      organizationPolicy: "single-org",
      multiplayer: true,
    })
    await expect(composed.options.cloudWorkspaceAdmission({} as never)).resolves.toMatchObject({
      status: 403,
      body: { error: { code: "cloud_workspace_capability_unavailable" } },
    })
    const authPreflight = await composed.authHandler(
      new Request("https://api.example.test/api/auth/sign-in/social", {
        method: "OPTIONS",
        headers: {
          origin: "https://app.example.test",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      }),
    )
    expect(authPreflight.status).toBe(204)
    expect(authPreflight.headers.get("access-control-allow-origin")).toBe("https://app.example.test")
    expect(authPreflight.headers.get("access-control-allow-credentials")).toBe("true")
    expect(authPreflight.headers.get("access-control-allow-headers")).toContain(
      "x-claxedo-multiplayer-validation-operation",
    )
  })

  test("fails closed when full-hosted is declared without a composed driver and lease store", async () => {
    const { authDatabase, controlPlaneDatabase } = await databases()
    expect(() =>
      composeBetterAuthD1UserDeployedControlPlane({
        env: env({
          CLAXEDO_SANDBOX_POSTURE: "full-hosted",
          CLAXEDO_SANDBOX_DRIVER: "cloudflare",
        }),
        authDatabase,
        controlPlaneDatabase,
        descriptorExpiresAt: 1_900_000_000_000,
        now: () => 1_800_000_000_000,
        product: {
          kind: "user-deployed",
          organization: { id: "org_deployment", name: "My deployment" },
          ownerIdentity: {
            adapter: "better-auth",
            issuer: "https://api.example.test/api/auth",
            subject: "owner-subject",
          },
        },
      }),
    ).toThrow(/full-hosted Better Auth \+ D1 requires CLAXEDO_SANDBOX_DRIVER and a composed sandbox driver/)
  })

  test("rejects reused D1 bindings before composing any provider state", async () => {
    const { authDatabase } = await databases()
    expect(() =>
      composeBetterAuthD1UserDeployedControlPlane({
        env: env(),
        authDatabase,
        controlPlaneDatabase: authDatabase,
        descriptorExpiresAt: 1_900_000_000_000,
        now: () => 1_800_000_000_000,
        product: {
          kind: "user-deployed",
          organization: { id: "org_deployment", name: "My deployment" },
          ownerIdentity: {
            adapter: "better-auth",
            issuer: "https://api.example.test/api/auth",
            subject: "owner-subject",
          },
        },
      }),
    ).toThrow("AUTH_DB and CONTROL_PLANE_DB must be distinct D1 bindings")
  })

  test("has no third-party identity, hosted-storage, documents or sandbox-driver value edge", async () => {
    const entry = path.join(ROOT, "src/authority/adapters/worker/better-auth-d1-compose.ts")
    const closure = sourceClosure({ entry, root: ROOT, runtimeOnly: true })
    expect(closure.unresolved).toEqual([])
    expect(closure.opaque).toEqual([])
    const modules = closure.modules.map((module) => module.relative)
    expect(
      modules.filter((file) =>
        [
          "/authority/adapters/hosted/",
          "/sandbox/stores/hosted",
          "/platform/auth/hosted-adapter",
          "/documents/",
        ].some((part) => `/${file}`.includes(part)),
      ),
    ).toEqual([])

    const bundled = await build({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      conditions: ["workerd", "worker", "import"],
      external: ["node:*"],
      write: false,
      metafile: true,
      logLevel: "silent",
    })
    const inputs = Object.keys(bundled.metafile.inputs).map((file) => file.replaceAll("\\", "/"))
    expect(
      inputs.filter((file) =>
        [
          "/authority/adapters/hosted/",
          "/sandbox/stores/hosted",
          "/platform/auth/hosted-adapter",
          "/sandbox-manager/src/drivers/",
          "/documents/",
        ].some((part) => file.includes(part)),
      ),
    ).toEqual([])
    expect(bundled.outputFiles.map((file) => file.text).join("\n")).not.toMatch(/POLAR_ACCESS_TOKEN/)
  })

  test("a Runtime Access Token minted for a Better Auth person names them as the machine's relay ingress requires", async () => {
    const { authDatabase, controlPlaneDatabase } = await databases()
    const identity = { adapter: "better-auth" as const, issuer: "https://api.example.test/api/auth", subject: "owner-subject" }
    await authDatabase.prepare(`insert into "user" (id, name, email, "emailVerified", image, "createdAt", "updatedAt")
      values (?, 'Ada Owner', 'ada@example.test', 1, 'https://images.example.test/ada.png', 1, 1)`).bind(identity.subject).run()
    const composed = composeBetterAuthD1UserDeployedControlPlane({
      env: env(),
      authDatabase,
      controlPlaneDatabase,
      descriptorExpiresAt: 1_900_000_000_000,
      now: () => 1_800_000_000_000,
      product: { kind: "user-deployed", organization: { id: "org_deployment", name: "My deployment" }, ownerIdentity: identity },
    })
    await composed.authReady
    const authority = requireAuthority(composed.plane.services)
    const person = await (authority as unknown as Pick<D1CoreAuthorityBoundary, "ensureApplicationIdentity">).ensureApplicationIdentity(identity)
    if (person.state !== "active") throw new Error(`owner identity is ${person.state}`)
    const principal: ControlPlanePrincipal = {
      userId: person.userId, actorId: person.actorId, actorKind: "human", deploymentId: "deployment-1",
      sessionId: "session-owner", authenticatedAt: 1_800_000_000_000, methods: ["oauth:github"], assurance: "single-factor",
      client: { kind: "browser", tokenKind: "browser-session", id: "browser", resource: "https://api.example.test", scopes: ["openid"], origin: "https://app.example.test" },
      identity,
    }
    const auth = { mode: "signed" as const, principal, user: { subject: identity.subject, tokenIdentifier: `${identity.issuer}|${identity.subject}`, issuer: identity.issuer } }

    const actor = await resolveRuntimeActor(authority, auth)
    const minted = await composed.plane.services.relay.runtimeAccessTokenSigner!({
      principalKind: "user", ...actor, orgId: "org_deployment", workspaceId: "ws_machine", hostId: "host_machine", role: "owner",
    })

    expect(decodeJwt(minted.runtimeAccessToken)).toMatchObject({
      actor_id: person.actorId,
      actor_public_id: person.userId,
      actor_name: "Ada Owner",
      actor_avatar_url: "https://images.example.test/ada.png",
    })
  })
})
