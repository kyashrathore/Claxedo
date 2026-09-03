import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"
import { Miniflare } from "miniflare"

import { provisionBetterAuthNativeClients } from "../../platform/auth/better-auth-native-clients"
import {
  LOCKED_BROWSER_BUILD_ID,
  LOCKED_RELAY_BUILD_ID,
  LOCKED_SERVICE_MANIFEST_ID,
  provisionLockedDeploymentReleaseState,
  registerLockedDeploymentReleaseCandidate,
} from "./better-auth-d1-release-state.cf"
import {
  beginDeploymentCanary,
  deploymentAdmissionBinding,
  recordDeploymentCutoverEvidence,
} from "./better-auth-d1-cutover-gate.cf"
import { pairedD1RecoveryRegistrationStatements } from "./paired-d1-recovery.cf"
import worker, { type BetterAuthD1LockedWorkerEnv } from "./better-auth-d1-locked-worker.cf"

const API_ORIGIN = "https://api.claxedo.test"
const APP_ORIGIN = "https://app.claxedo.test"
const MIGRATIONS = [
  fileURLToPath(new URL("../../../migrations/auth/0001_better_auth.sql", import.meta.url)),
  fileURLToPath(new URL("../../../migrations/auth/0002_deployment_release_state.sql", import.meta.url)),
  fileURLToPath(new URL("../../../migrations/auth/0003_authentication_evidence.sql", import.meta.url)),
  fileURLToPath(new URL("../../../migrations/auth/0004_cutover_admission.sql", import.meta.url)),
  fileURLToPath(new URL("../../../migrations/auth/0005_paired_recovery_epoch.sql", import.meta.url)),
]
const CONTROL_MIGRATION = fileURLToPath(
  new URL("../../../migrations/control-plane/0007_paired_recovery_epoch.sql", import.meta.url),
)

describe("production Better Auth D1 locked Worker", () => {
  let miniflare!: Miniflare
  let database!: Awaited<ReturnType<Miniflare["getD1Database"]>>
  let controlPlaneDatabase!: Awaited<ReturnType<Miniflare["getD1Database"]>>
  const limit = vi.fn(async () => ({ success: true }))
  const env: BetterAuthD1LockedWorkerEnv = {
    AUTH_DB: undefined as never,
    CONTROL_PLANE_DB: undefined as never,
    CLAXEDO_REQUEST_LIMITER: { limit },
    CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
    CLAXEDO_PRODUCT_POSTURE: "user-deployed",
    CLAXEDO_SANDBOX_POSTURE: "control-plane-only",
    CLAXEDO_DEPLOYMENT_ID: "deployment-test-01",
    CLAXEDO_RELEASE_SEQUENCE: "1",
    CLAXEDO_RELEASE_ID: "release-test-0001",
    CLAXEDO_WORKER_BUILD_ID: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    CLAXEDO_AUTH_CONFIGURATION_ID: "sha256:0649de3450af10bc2af0e7f753ac375beb9bb87b4fa1ee8f0f8248825eb521e3",
    CLAXEDO_CANDIDATE_STATE_REVISION: "0",
    CLAXEDO_CANDIDATE_OPERATION_ID: "initialize:release-test-0001",
    CLAXEDO_AUTH_METHODS: "github",
    BETTER_AUTH_URL: API_ORIGIN,
    CLAXEDO_APP_ORIGIN: APP_ORIGIN,
    BETTER_AUTH_SECRET: "locked-worker-secret-that-is-long-enough",
    CLAXEDO_AUTH_INTROSPECTION_SECRET: "test-introspection-secret-that-is-long-enough",
    CLAXEDO_RELEASE_OPERATOR_SECRET: "test-release-operator-secret-that-is-long-enough",
    GITHUB_CLIENT_ID: "github-client",
    GITHUB_CLIENT_SECRET: "github-secret",
    CF_VERSION_METADATA: { id: "11111111-1111-1111-1111-111111111111", tag: "release-test-0001" },
    CLAXEDO_REQUEST_LIMITER_NAMESPACE_ID: "2101",
    CLAXEDO_RECOVERY_EPOCH: `paired-d1-v1:sha256:${"1".repeat(64)}`,
  }

  beforeAll(async () => {
    miniflare = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      compatibilityDate: "2025-05-01",
      d1Databases: ["AUTH_DB", "CONTROL_PLANE_DB"],
    })
    database = await miniflare.getD1Database("AUTH_DB")
    env.AUTH_DB = database
    controlPlaneDatabase = await miniflare.getD1Database("CONTROL_PLANE_DB")
    env.CONTROL_PLANE_DB = controlPlaneDatabase
    for (const path of MIGRATIONS) {
      const sql = (await readFile(path, "utf8")).replace(/^\s*--.*$/gm, "")
      for (const statement of sql
        .split(/;\s*\n\s*\n/)
        .map((part) => part.trim())
        .filter(Boolean)) {
        await database.prepare(statement).run()
      }
    }
    const controlMigration = (await readFile(CONTROL_MIGRATION, "utf8")).replace(/^\s*--.*$/gm, "")
    for (const statement of controlMigration
      .split(/;\s*\n\s*\n/)
      .map((part) => part.trim())
      .filter(Boolean)) {
      await controlPlaneDatabase.prepare(statement).run()
    }
    await provisionBetterAuthNativeClients(
      database,
      API_ORIGIN,
      env.BETTER_AUTH_SECRET!,
      env.CLAXEDO_AUTH_INTROSPECTION_SECRET!,
    )
  })

  afterAll(async () => {
    await miniflare.dispose()
  })

  async function targetSnapshot() {
    const tables = [
      "user",
      "oauthResource",
      "oauthClient",
      "oauthClientResource",
      "jwks",
      "deploymentRecoveryEpoch",
    ] as const
    return Object.fromEntries(
      await Promise.all(
        tables.map(async (table) => [
          table,
          (await database.prepare(`select * from "${table}" order by "id"`).all()).results,
        ]),
      ),
    )
  }

  test("fails closed until install tooling persists the exact locked identity", async () => {
    const response = await worker.fetch(new Request(`${API_ORIGIN}/health`), env)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: "deployment_unavailable" } })
    await registerLockedDeploymentReleaseCandidate(database, {
      deploymentId: env.CLAXEDO_DEPLOYMENT_ID!,
      releaseSequence: Number(env.CLAXEDO_RELEASE_SEQUENCE),
      releaseId: env.CLAXEDO_RELEASE_ID!,
      workerBuildId: env.CLAXEDO_WORKER_BUILD_ID!,
      platformVersionId: env.CF_VERSION_METADATA!.id!,
      browserBuildId: LOCKED_BROWSER_BUILD_ID,
      relayBuildId: LOCKED_RELAY_BUILD_ID,
      authConfigurationId: env.CLAXEDO_AUTH_CONFIGURATION_ID!,
      requestLimiterNamespaceId: env.CLAXEDO_REQUEST_LIMITER_NAMESPACE_ID!,
      adapterProfile: "better-auth-d1",
      productPosture: "user-deployed",
      sandboxPosture: "control-plane-only",
      serviceManifestId: LOCKED_SERVICE_MANIFEST_ID,
    })
    const recovery = pairedD1RecoveryRegistrationStatements({
      deploymentId: env.CLAXEDO_DEPLOYMENT_ID!,
      releaseId: env.CLAXEDO_RELEASE_ID!,
      recoveryEpoch: env.CLAXEDO_RECOVERY_EPOCH!,
    })
    await database.prepare(recovery.auth).run()
    await controlPlaneDatabase.prepare(recovery.controlPlane).run()
    const candidate = await worker.fetch(new Request(`${API_ORIGIN}/__release/candidate-health`), env)
    expect(candidate.status).toBe(200)
    expect(await candidate.json()).toMatchObject({
      status: "candidate-locked",
      platformVersionId: "11111111-1111-1111-1111-111111111111",
      release: { releaseId: "release-test-0001", stateRevision: 0 },
    })
  })

  test("serves only locked health and provider-owned metadata without target writes", async () => {
    await provisionLockedDeploymentReleaseState(database, {
      deploymentId: env.CLAXEDO_DEPLOYMENT_ID!,
      releaseSequence: Number(env.CLAXEDO_RELEASE_SEQUENCE),
      releaseId: env.CLAXEDO_RELEASE_ID!,
      workerBuildId: env.CLAXEDO_WORKER_BUILD_ID!,
      platformVersionId: env.CF_VERSION_METADATA!.id!,
      browserBuildId: LOCKED_BROWSER_BUILD_ID,
      relayBuildId: LOCKED_RELAY_BUILD_ID,
      authConfigurationId: env.CLAXEDO_AUTH_CONFIGURATION_ID!,
      requestLimiterNamespaceId: env.CLAXEDO_REQUEST_LIMITER_NAMESPACE_ID!,
      adapterProfile: "better-auth-d1",
      productPosture: "user-deployed",
      sandboxPosture: "control-plane-only",
      serviceManifestId: LOCKED_SERVICE_MANIFEST_ID,
    })
    const health = await worker.fetch(new Request(`${API_ORIGIN}/health`), env)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({
      status: "locked",
      platformVersionId: "11111111-1111-1111-1111-111111111111",
      profile: {
        adapter: "better-auth-d1",
        product: "user-deployed",
        sandbox: "control-plane-only",
        services: "empty-services-v1",
      },
    })
    expect(health.headers.get("x-content-type-options")).toBe("nosniff")
    expect(health.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains")

    const before = await targetSnapshot()
    const metadata = await worker.fetch(
      new Request(`${API_ORIGIN}/.well-known/oauth-authorization-server`, {
        headers: { origin: APP_ORIGIN, "cf-connecting-ip": "192.0.2.1" },
      }),
      env,
    )
    expect(metadata.status).toBe(200)
    expect(metadata.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN)
    expect(metadata.headers.get("access-control-allow-credentials")).toBe("true")
    expect(await metadata.json()).toMatchObject({
      issuer: `${API_ORIGIN}/api/auth`,
      token_endpoint: `${API_ORIGIN}/api/auth/oauth2/token`,
    })
    const after = await targetSnapshot()
    expect(after).toEqual(before)
  })

  test("exposes only the authenticated persisted operator status and blocks canary for the browser-absent artifact", async () => {
    const unauthorized = await worker.fetch(new Request(`${API_ORIGIN}/__release/operator/status`), env)
    expect(unauthorized.status).toBe(401)
    const status = await worker.fetch(
      new Request(`${API_ORIGIN}/__release/operator/status`, {
        headers: { authorization: `Bearer ${env.CLAXEDO_RELEASE_OPERATOR_SECRET}` },
      }),
      env,
    )
    expect(status.status).toBe(200)
    const statusBody = (await status.json()) as { release: Record<string, unknown> }
    expect(statusBody).toMatchObject({
      release: { releaseId: env.CLAXEDO_RELEASE_ID, browserBuildId: "browser-absent-v1", phase: "locked" },
    })
    const blocked = await worker.fetch(
      new Request(`${API_ORIGIN}/__release/operator/begin-canary`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.CLAXEDO_RELEASE_OPERATOR_SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          binding: statusBody.release,
          receiptId: "receipt-canary-http-01",
          operationId: "operation-canary-http-01",
          canaryIdentityHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          journeyId: "journey-canary-http-01",
          expectedStateRevision: 0,
          expectedPhaseRevision: 0,
        }),
      }),
      env,
    )
    expect(blocked.status).toBe(503)
    expect(await blocked.json()).toEqual({ error: { code: "deployment_unavailable" } })
  })

  test.each([
    ["POST", "/api/auth/sign-up/email"],
    ["POST", "/api/auth/sign-in/social"],
    ["POST", "/api/auth/device/code"],
    ["POST", "/api/auth/oauth2/token"],
    ["GET", "/api/auth/jwks"],
    ["GET", "/api/workspaces"],
    ["GET", "/__test/last-email"],
  ])("rejects %s %s while locked", async (method, path) => {
    const response = await worker.fetch(
      new Request(`${API_ORIGIN}${path}`, {
        method,
        headers: { origin: APP_ORIGIN, "cf-connecting-ip": "192.0.2.2" },
      }),
      env,
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: "deployment_locked" } })
    expect(response.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN)
  })

  test("refuses to serve if persisted state advances beyond this locked entrypoint", async () => {
    const selectedIdentity = {
      deploymentId: env.CLAXEDO_DEPLOYMENT_ID!,
      releaseSequence: Number(env.CLAXEDO_RELEASE_SEQUENCE),
      releaseId: env.CLAXEDO_RELEASE_ID!,
      workerBuildId: env.CLAXEDO_WORKER_BUILD_ID!,
      platformVersionId: env.CF_VERSION_METADATA!.id!,
      browserBuildId: LOCKED_BROWSER_BUILD_ID,
      relayBuildId: LOCKED_RELAY_BUILD_ID,
      authConfigurationId: env.CLAXEDO_AUTH_CONFIGURATION_ID!,
      requestLimiterNamespaceId: env.CLAXEDO_REQUEST_LIMITER_NAMESPACE_ID!,
      adapterProfile: "better-auth-d1" as const,
      productPosture: "user-deployed" as const,
      sandboxPosture: "control-plane-only" as const,
      serviceManifestId: LOCKED_SERVICE_MANIFEST_ID,
    }
    const locked = await provisionLockedDeploymentReleaseState(database, selectedIdentity)
    await recordDeploymentCutoverEvidence(database, selectedIdentity, deploymentAdmissionBinding(locked), {
      kind: "migration_conservation_verified",
      receiptId: "receipt-migration-conservation-01",
      operationId: "operation-migration-conservation-01",
      sourceSnapshotId: "snapshot-migration-01",
      evidenceSha256: "sha256:9999999999999999999999999999999999999999999999999999999999999999",
      sourceSha256: "sha256:8888888888888888888888888888888888888888888888888888888888888888",
    })
    await beginDeploymentCanary(database, selectedIdentity, {
      receiptId: "receipt-canary-01",
      operationId: "operation-canary-01",
      operatorSubjectHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      canaryIdentityHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      journeyId: "journey-canary-01",
      expectedStateRevision: 0,
      expectedPhaseRevision: 0,
    })
    try {
      const response = await worker.fetch(new Request(`${API_ORIGIN}/health`), env)
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: { code: "deployment_unavailable" } })
    } finally {
      await database.prepare(`update "deploymentReleaseActive" set "stateRevision" = 0 where "singleton" = 1`).run()
    }
  })

  test("fails readiness when the canonical native-client closure is damaged", async () => {
    await database.prepare(`delete from "oauthClientResource" where "id" = 'client_resource_cli'`).run()
    try {
      const response = await worker.fetch(
        new Request(`${API_ORIGIN}/health`, {
          headers: { "cf-connecting-ip": "192.0.2.5" },
        }),
        env,
      )
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: { code: "deployment_unavailable" } })
    } finally {
      await provisionBetterAuthNativeClients(
        database,
        API_ORIGIN,
        env.BETTER_AUTH_SECRET!,
        env.CLAXEDO_AUTH_INTROSPECTION_SECRET!,
      )
    }
  })

  test("fails readiness when a generated-schema table or named index is missing", async () => {
    await database.prepare(`alter table "session" rename to "session_broken"`).run()
    try {
      const missingTable = await worker.fetch(
        new Request(`${API_ORIGIN}/health`, {
          headers: { "cf-connecting-ip": "192.0.2.7" },
        }),
        env,
      )
      expect(missingTable.status).toBe(503)
    } finally {
      await database.prepare(`alter table "session_broken" rename to "session"`).run()
    }

    await database.prepare(`drop index "account_userId_idx"`).run()
    try {
      const missingIndex = await worker.fetch(
        new Request(`${API_ORIGIN}/health`, {
          headers: { "cf-connecting-ip": "192.0.2.8" },
        }),
        env,
      )
      expect(missingIndex.status).toBe(503)
    } finally {
      await database.prepare(`create index "account_userId_idx" on "account" ("userId")`).run()
    }

    await database.prepare(`drop index "deploymentCutoverEvidence_distinct_multiplayer_identity"`).run()
    try {
      const missingCutoverIndex = await worker.fetch(
        new Request(`${API_ORIGIN}/health`, { headers: { "cf-connecting-ip": "192.0.2.9" } }),
        env,
      )
      expect(missingCutoverIndex.status).toBe(503)
    } finally {
      await database
        .prepare(
          `create unique index "deploymentCutoverEvidence_distinct_multiplayer_identity"
        on "deploymentCutoverEvidenceReceipt" ("deploymentId", "releaseId", "primarySubjectHash")
        where "evidenceKind" = 'multiplayer_identity'`,
        )
        .run()
    }
  })

  test("rejects runtime auth composition drift from the persisted release", async () => {
    const original = env.GITHUB_CLIENT_ID
    env.GITHUB_CLIENT_ID = "different-github-client"
    try {
      const response = await worker.fetch(
        new Request(`${API_ORIGIN}/health`, {
          headers: { "cf-connecting-ip": "192.0.2.6" },
        }),
        env,
      )
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: { code: "deployment_unavailable" } })
    } finally {
      env.GITHUB_CLIENT_ID = original
    }
  })

  test("rejects a release whose configured recovery epoch does not match either D1 half", async () => {
    const original = env.CLAXEDO_RECOVERY_EPOCH
    env.CLAXEDO_RECOVERY_EPOCH = `paired-d1-v1:sha256:${"2".repeat(64)}`
    try {
      const response = await worker.fetch(new Request(`${API_ORIGIN}/health`), env)
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: { code: "deployment_unavailable" } })
    } finally {
      env.CLAXEDO_RECOVERY_EPOCH = original
    }
  })

  test("enforces the mandatory shared limiter and exact CORS origin", async () => {
    limit.mockResolvedValueOnce({ success: false })
    const limited = await worker.fetch(
      new Request(`${API_ORIGIN}/unknown`, {
        headers: { origin: APP_ORIGIN, "cf-connecting-ip": "192.0.2.3" },
      }),
      env,
    )
    expect(limited.status).toBe(429)
    const unknownOrigin = await worker.fetch(
      new Request(`${API_ORIGIN}/unknown`, {
        headers: { origin: "https://attacker.example", "cf-connecting-ip": "192.0.2.4" },
      }),
      env,
    )
    expect(unknownOrigin.headers.get("access-control-allow-origin")).toBeNull()
    const wrongApiOrigin = await worker.fetch(new Request("https://preview.workers.dev/health"), env)
    expect(wrongApiOrigin.status).toBe(503)
    expect(await wrongApiOrigin.json()).toEqual({ error: { code: "deployment_unavailable" } })
  })
})
