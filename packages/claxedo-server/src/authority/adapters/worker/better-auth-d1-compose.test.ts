import path from "node:path"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import { build } from "esbuild"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"
import { sourceClosure } from "@claxedo/server-core/platform/governance/source-closure"

import { composeBetterAuthD1UserDeployedControlPlane } from "./better-auth-d1-compose"

const ROOT = path.resolve(import.meta.dirname, "../../../..")
const CONTROL_MIGRATIONS = [
  "0001_service_installations.sql",
  "0002_workspace_authority.sql",
  "0003_private_sessions.sql",
  "0004_host_access_and_sharing.sql",
  "0005_agent_extensions_and_audit.sql",
  "0006_channel_identity_and_canonical_runtime.sql",
  "0007_paired_recovery_epoch.sql",
  "0008_user_deployed_owner_bootstrap.sql",
  "0012_cold_local_host_challenges.sql",
  "0013_org_team_session_sharing.sql",
  "0017_adapter_custom.sql",
].map((name) => fileURLToPath(new URL(`../../../../migrations/control-plane/${name}`, import.meta.url)))
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
  await applyMigrations(controlPlaneDatabase, CONTROL_MIGRATIONS)
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
      environmentId: "production",
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

  test("hands a bound credentials KV namespace to the hosted credential store", async () => {
    // The composition env is strings only, so the binding object cannot ride
    // in it. Without the explicit seam a deployment with the hosted credential
    // store enabled refuses to start asking for the REST KV configuration —
    // which is exactly how staging release 65 failed its candidate health.
    const { authDatabase, controlPlaneDatabase } = await databases()
    const credentialEnv = env({
      CLAXEDO_HOSTED_CREDENTIALS_ENABLED: "1",
      CLAXEDO_CREDENTIALS_KEK: Buffer.alloc(32, 7).toString("base64"),
    })
    const input = {
      authDatabase,
      controlPlaneDatabase,
      environmentId: "staging",
      descriptorExpiresAt: 1_900_000_000_000,
      now: () => 1_800_000_000_000,
      product: {
        kind: "user-deployed" as const,
        organization: { id: "org_deployment", name: "My deployment" },
        ownerBootstrap: "one-use-claim" as const,
      },
    }
    expect(() => composeBetterAuthD1UserDeployedControlPlane({ ...input, env: credentialEnv })).toThrow(
      /CLAXEDO_CF_KV_URL is not configured/,
    )
    const binding = {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    }
    const composed = composeBetterAuthD1UserDeployedControlPlane({
      ...input,
      env: credentialEnv,
      credentialsNamespace: binding as never,
    })
    expect(await composed.plane.services.credentials.listCredentials("org_deployment")).toEqual([])
    // Let Better Auth's init settle before the databases are disposed.
    await composed.authReady.catch(() => undefined)
  })

  test("composes the real auth, authority, empty service catalog, and no-billing posture", async () => {
    const { authDatabase, controlPlaneDatabase } = await databases()
    const composed = composeBetterAuthD1UserDeployedControlPlane({
      env: env(),
      authDatabase,
      controlPlaneDatabase,
      environmentId: "production",
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
    expect(composed.plane.cliSessionTokenRegistry).toBeUndefined()
    expect(composed.options.authentication.descriptor).toMatchObject({
      adapter: "better-auth",
      deploymentId: "deployment-1",
      browser: { transport: "cookie" },
      native: {
        cli: { flow: "device-authorization" },
        desktop: { flow: "authorization-code-pkce" },
      },
    })
    expect(await composed.options.serviceCatalog({} as never)).toEqual([])
    await controlPlaneDatabase
      .prepare(
        `insert into service_installations (
        environment_id, deployment_id, service_id, protocol_version, schema_version,
        lifecycle_state, binding_name, entrypoint, binding_provenance,
        probe_status, probe_checked_at, service_build_id, revision, last_operation_id, updated_at
      ) values (?, ?, 'documents', 'claxedo.service.v1', 1, 'enabled', 'DOCUMENTS_SERVICE',
        'DocumentsServiceV1', 'cloudflare-service:test', 'ready', ?, 'build-1', 2, 'op-enable', ?)`,
      )
      .bind("production", "deployment-1", "2026-08-28T00:00:00Z", "2026-08-28T00:00:00Z")
      .run()
    await expect(composed.options.serviceCatalog({} as never)).rejects.toThrow(
      "enabled service installation(s) without bindings: documents",
    )
    expect(composed.billing).toBe("absent")
    expect(composed.product).toMatchObject({
      productPosture: "user-deployed",
      organizationPolicy: "single-org",
      billing: "absent",
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

  test("fails closed instead of inventing the missing D1 sandbox lease store", async () => {
    const { authDatabase, controlPlaneDatabase } = await databases()
    expect(() =>
      composeBetterAuthD1UserDeployedControlPlane({
        env: env({
          CLAXEDO_SANDBOX_POSTURE: "full-hosted",
          CLAXEDO_SANDBOX_DRIVER: "cloudflare",
        }),
        authDatabase,
        controlPlaneDatabase,
        environmentId: "production",
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
    ).toThrow(/no D1 durable sandbox lease store is implemented/)
  })

  test("rejects reused D1 bindings before composing any provider state", async () => {
    const { authDatabase } = await databases()
    expect(() =>
      composeBetterAuthD1UserDeployedControlPlane({
        env: env(),
        authDatabase,
        controlPlaneDatabase: authDatabase,
        environmentId: "production",
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

  test("has no third-party identity, hosted-storage, billing, optional-service, or sandbox-driver value edge", async () => {
    const entry = path.join(ROOT, "src/authority/adapters/worker/better-auth-d1-compose.ts")
    const closure = sourceClosure({ entry, root: ROOT, runtimeOnly: true })
    expect(closure.unresolved).toEqual([])
    expect(closure.opaque).toEqual([])
    const modules = closure.modules.map((module) => module.relative)
    expect(
      modules.filter((file) =>
        [
          "/authority/adapters/hosted/",
          "/authority/adapters/worker/hosted-compose",
          "/authority/adapters/worker/retained-sandbox-driver",
          "/sandbox/stores/hosted",
          "/platform/auth/hosted-adapter",
          "/billing/",
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
          "/billing/",
          "/documents/",
        ].some((part) => file.includes(part)),
      ),
    ).toEqual([])
    expect(bundled.outputFiles.map((file) => file.text).join("\n")).not.toMatch(/POLAR_ACCESS_TOKEN/)
  })
})
