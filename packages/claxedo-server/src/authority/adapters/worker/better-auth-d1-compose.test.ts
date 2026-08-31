import path from "node:path"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import { build } from "esbuild"
import { Miniflare } from "miniflare"
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
].map((name) => fileURLToPath(new URL(`../../../../migrations/control-plane/${name}`, import.meta.url)))

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
  for (const migrationPath of CONTROL_MIGRATIONS) {
    const migration = (await readFile(migrationPath, "utf8")).replace(/^\s*--.*$/gm, "")
    for (const statement of migration
      .split(/;\s*\n\s*\n/)
      .map((part) => part.trim())
      .filter(Boolean)) {
      await controlPlaneDatabase.prepare(statement).run()
    }
  }
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

describe("Better Auth + D1 user-deployed composition", () => {
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
      ) values (?, ?, 'workgraph', 'claxedo.service.v1', 1, 'enabled', 'WORKGRAPH_SERVICE',
        'WorkGraphServiceV1', 'cloudflare-service:test', 'ready', ?, 'build-1', 2, 'op-enable', ?)`,
      )
      .bind("production", "deployment-1", "2026-08-28T00:00:00Z", "2026-08-28T00:00:00Z")
      .run()
    await expect(composed.options.serviceCatalog({} as never)).rejects.toThrow(
      "enabled service installation(s) without bindings: workgraph",
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

  test("has no Clerk, Convex, billing, optional-service, or sandbox-driver value edge", async () => {
    const entry = path.join(ROOT, "src/authority/adapters/worker/better-auth-d1-compose.ts")
    const closure = sourceClosure({ entry, root: ROOT, runtimeOnly: true })
    expect(closure.unresolved).toEqual([])
    expect(closure.opaque).toEqual([])
    const modules = closure.modules.map((module) => module.relative)
    expect(
      modules.filter((file) =>
        [
          "/authority/adapters/convex/",
          "/authority/adapters/worker/hosted-compose",
          "/authority/adapters/worker/retained-sandbox-driver",
          "/sandbox/stores/convex",
          "/platform/auth/clerk-adapter",
          "/billing/",
          "/hosts/workgraph/",
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
          "/authority/adapters/convex/",
          "/sandbox/stores/convex",
          "/platform/auth/clerk-adapter",
          "/sandbox-manager/src/drivers/",
          "/billing/",
          "/hosts/workgraph/",
          "/documents/",
        ].some((part) => file.includes(part)),
      ),
    ).toEqual([])
    expect(bundled.outputFiles.map((file) => file.text).join("\n")).not.toMatch(
      /CLERK_(?:PUBLISHABLE|SECRET)_KEY|CONVEX_(?:URL|DEPLOY_KEY)|POLAR_ACCESS_TOKEN/,
    )
  })
})
