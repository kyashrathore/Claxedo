import { readdirSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { describe, expect, test } from "vitest"

import {
  allocatedRequestLimiterNamespaceId,
  browserArtifactBuildId,
  betterAuthD1DeploymentManifest,
  betterAuthD1DeploymentManifestPath,
  betterAuthD1ReleaseInputs,
  betterAuthD1ReleaseSubprocessEnvironment,
  candidateConfigurationId,
  candidateVersionTag,
  cloudflareVersionOverride,
  fetchReleaseProbe,
  futureUnixMilliseconds,
  isAbsentWorkerProbe,
  parseDeploymentStatus,
  parseVersionUploadOutput,
  pairedD1RecoveryEpoch,
  recoverCandidateVersion,
  prepareBrowserArtifactsForWorkers,
  renderBetterAuthD1LiveSyncMigrationBridgeWranglerConfig,
  renderBetterAuthD1WranglerConfig,
  renderBetterAuthBrowserWranglerConfig,
  resolveReleaseSecretsFile,
  requireDeploymentTraffic,
  requireSecretInventory,
  taggedCandidateVersionId,
  workerArtifactBuildId,
  verifyBootstrapGate,
  workerVersionHasLiveSyncRoom,
} from "./release-better-auth-d1"

const env = {
  CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
  CLAXEDO_PRODUCT_POSTURE: "user-deployed",
  CLAXEDO_SANDBOX_POSTURE: "control-plane-only",
  CLAXEDO_PRODUCTION_DEPLOYMENT_ID: "deployment-production-01",
  CLAXEDO_STAGING_DEPLOYMENT_ID: "deployment-staging-01",
  CLAXEDO_RELEASE_SEQUENCE: "1",
  CLAXEDO_RELEASE_ID: "release-test-0001",
  CLAXEDO_AUTH_METHODS: "github",
  CLAXEDO_PRODUCTION_API_ORIGIN: "https://api.claxedo.test",
  CLAXEDO_STAGING_API_ORIGIN: "https://api-staging.claxedo.test",
  CLAXEDO_PRODUCTION_APP_ORIGIN: "https://app.claxedo.test",
  CLAXEDO_STAGING_APP_ORIGIN: "https://app-staging.claxedo.test",
  CLAXEDO_PRODUCTION_WORKSPACE_RELAY_URL: "https://relay.claxedo.test",
  CLAXEDO_STAGING_WORKSPACE_RELAY_URL: "https://relay-staging.claxedo.test",
  GITHUB_CLIENT_ID: "github-client",
  CLAXEDO_PRODUCTION_AUTH_D1_DATABASE_ID: "11111111-1111-1111-1111-111111111111",
  CLAXEDO_STAGING_AUTH_D1_DATABASE_ID: "22222222-2222-2222-2222-222222222222",
  CLAXEDO_PRODUCTION_AUTH_D1_DATABASE_NAME: "claxedo-auth-production",
  CLAXEDO_STAGING_AUTH_D1_DATABASE_NAME: "claxedo-auth-staging",
  CLAXEDO_PRODUCTION_CONTROL_PLANE_D1_DATABASE_ID: "33333333-3333-3333-3333-333333333333",
  CLAXEDO_STAGING_CONTROL_PLANE_D1_DATABASE_ID: "44444444-4444-4444-4444-444444444444",
  CLAXEDO_PRODUCTION_CONTROL_PLANE_D1_DATABASE_NAME: "claxedo-control-plane-production",
  CLAXEDO_STAGING_CONTROL_PLANE_D1_DATABASE_NAME: "claxedo-control-plane-staging",
}

describe("single-artifact Better Auth D1 release", () => {
  test("accepts only a future millisecond timestamp for the deployed auth descriptor", () => {
    expect(futureUnixMilliseconds({ EXPIRY: "2000" }, "EXPIRY", 1000)).toBe("2000")
    expect(() => futureUnixMilliseconds({ EXPIRY: "2026-09-01T00:00:00Z" }, "EXPIRY", 1000)).toThrow(
      "must be a future Unix timestamp in milliseconds",
    )
    expect(() => futureUnixMilliseconds({ EXPIRY: "1000" }, "EXPIRY", 1000)).toThrow(
      "must be a future Unix timestamp in milliseconds",
    )
  })
  test("keeps remote D1 trigger migrations compatible with Cloudflare's statement splitter", () => {
    for (const directory of ["auth", "control-plane"] as const) {
      const migrationDirectory = new URL(`../../migrations/${directory}/`, import.meta.url)
      for (const name of readdirSync(migrationDirectory).filter((candidate) => candidate.endsWith(".sql"))) {
        const bytes = readFileSync(new URL(name, migrationDirectory))
        expect(bytes.includes(13), `${directory}/${name} must use LF line endings`).toBe(false)
        const sql = bytes.toString("utf8")
        if (/create trigger/i.test(sql)) {
          expect(sql, `${directory}/${name} must spell trigger BEGIN in uppercase`).not.toMatch(/\bbegin\b/)
        }
      }
    }
  })

  test("recognizes current Wrangler absent-Worker diagnostics", () => {
    expect(isAbsentWorkerProbe("This Worker does not exist on your account. [code: 10007]")).toBe(true)
    expect(isAbsentWorkerProbe("The Worker was not found")).toBe(true)
    expect(isAbsentWorkerProbe("This Worker has no deployments")).toBe(true)
    expect(isAbsentWorkerProbe("Authentication failed")).toBe(false)
  })

  test("waits for asynchronous custom-domain activation and verifies the exact bootstrap gate", async () => {
    let attempts = 0
    await expect(
      verifyBootstrapGate("https://bootstrap.claxedo.test", {
        attempts: 3,
        intervalMs: 0,
        wait: async () => {},
        fetcher: async () => {
          attempts += 1
          if (attempts === 1) throw new TypeError("Unable to connect")
          return Response.json({ error: { code: "deployment_bootstrap" } }, { status: 503 })
        },
      }),
    ).resolves.toBeUndefined()
    expect(attempts).toBe(2)

    await expect(
      verifyBootstrapGate("https://bootstrap.claxedo.test", {
        attempts: 1,
        wait: async () => {},
        fetcher: async () => Response.json({ error: { code: "wrong_gate" } }, { status: 503 }),
      }),
    ).rejects.toThrow(/exact fail-closed production deployment/)
  })

  test("falls back to authoritative DNS while preserving the HTTPS hostname probe", async () => {
    const observed: string[] = []
    const response = await fetchReleaseProbe(
      "https://api.claxedo.test/health",
      {},
      {
        fetcher: async () => {
          throw new TypeError("cached NXDOMAIN")
        },
        resolver: async (hostname) => {
          expect(hostname).toBe("api.claxedo.test")
          return ["192.0.2.10"]
        },
        addressFetcher: async (url, address) => {
          observed.push(`${url}@${address}`)
          return Response.json({ status: "locked" })
        },
      },
    )
    expect(response.status).toBe(200)
    expect(observed).toEqual(["https://api.claxedo.test/health@192.0.2.10"])
  })

  test("writes a deterministic, secret-free manifest bound to the deployed resources", () => {
    const release = betterAuthD1ReleaseInputs(env, "production")
    const manifest = betterAuthD1DeploymentManifest({
      release,
      workerBuildId: `sha256:${"a".repeat(64)}`,
      platformVersionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      authConfigurationId: `sha256:${"b".repeat(64)}`,
    })
    expect(manifest).toMatchObject({
      deploymentId: "deployment-production-01",
      releaseId: "release-test-0001",
      browserBuildId: "browser-absent-v1",
      relayBuildId: "relay-absent-v1",
      serviceManifestId: "empty-services-v1",
      recoveryEpoch: pairedD1RecoveryEpoch({
        deploymentId: "deployment-production-01",
        releaseId: "release-test-0001",
        authDatabaseId: env.CLAXEDO_PRODUCTION_AUTH_D1_DATABASE_ID,
        controlPlaneDatabaseId: env.CLAXEDO_PRODUCTION_CONTROL_PLANE_D1_DATABASE_ID,
      }),
      resources: {
        authDatabase: { databaseId: env.CLAXEDO_PRODUCTION_AUTH_D1_DATABASE_ID },
        controlPlaneDatabase: { databaseId: env.CLAXEDO_PRODUCTION_CONTROL_PLANE_D1_DATABASE_ID },
      },
    })
    expect(JSON.stringify(manifest)).not.toContain("SECRET")
    expect(betterAuthD1DeploymentManifestPath(env, "production")).toContain(
      ".artifacts/deployments/production-release-test-0001.json",
    )
  })

  test("binds a cutover release to the exact browser and the existing release-train Worker", () => {
    const browserBuildId = `sha256:${"c".repeat(64)}`
    const cutoverEnv = {
      ...env,
      CLAXEDO_AUTH_DESCRIPTOR_EXPIRES_AT: String(Date.now() + 86_400_000),
      CLAXEDO_ENVIRONMENT_ID: "production",
      CLAXEDO_USER_DEPLOYED_ORGANIZATION_ID: "org_deployment",
      CLAXEDO_USER_DEPLOYED_ORGANIZATION_NAME: "My deployment",
      CLAXEDO_CANARY_JOURNEY_ID: "journey-cutover-0001",
    }
    const release = betterAuthD1ReleaseInputs(cutoverEnv, "production", {
      mode: "cutover",
      browserBuildId,
    })
    expect(release.runtimeVariables).toContainEqual(["CLAXEDO_DEPLOYMENT_MODE", "hosted"])
    const config = renderBetterAuthD1WranglerConfig({ staging: false, ...release })
    expect(config).toContain('name = "claxedo-user-deployed-locked"')
    expect(config).toContain('main = "../src/deployments/hosted-workerd/better-auth-d1-candidate-worker.cf.ts"')
    expect(config).toContain('name = "LIVE_SYNC_ROOM"')
    expect(config).toContain('new_sqlite_classes = ["LiveSyncRoom"]')
    const bridge = renderBetterAuthD1LiveSyncMigrationBridgeWranglerConfig({ staging: false, ...release })
    expect(bridge).toContain(
      'main = "../src/deployments/hosted-workerd/better-auth-d1-live-sync-migration-bridge.cf.ts"',
    )
    expect(bridge).toContain('new_sqlite_classes = ["LiveSyncRoom"]')

    const manifest = betterAuthD1DeploymentManifest({
      release,
      workerBuildId: `sha256:${"a".repeat(64)}`,
      platformVersionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      authConfigurationId: `sha256:${"b".repeat(64)}`,
    })
    expect(manifest.browserBuildId).toBe(browserBuildId)
    const subprocess = betterAuthD1ReleaseSubprocessEnvironment({
      env: cutoverEnv,
      release,
      workerBuildId: manifest.workerBuildId,
      platformVersionId: manifest.platformVersionId,
      authConfigurationId: manifest.authConfigurationId,
      wranglerConfig: "/tmp/wrangler.toml",
    })
    expect(subprocess.CLAXEDO_BROWSER_BUILD_ID).toBe(browserBuildId)
    expect(subprocess.CLAXEDO_RELAY_BUILD_ID).toBe("relay-absent-v1")
  })

  test("passes the paired recovery epoch to its migration subprocess", () => {
    const release = betterAuthD1ReleaseInputs(env, "staging")
    const subprocess = betterAuthD1ReleaseSubprocessEnvironment({
      env,
      release,
      workerBuildId: `sha256:${"a".repeat(64)}`,
      platformVersionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      authConfigurationId: `sha256:${"b".repeat(64)}`,
      wranglerConfig: "/tmp/wrangler.toml",
    })
    expect(subprocess.CLAXEDO_RECOVERY_EPOCH).toBe(
      pairedD1RecoveryEpoch({
        deploymentId: env.CLAXEDO_STAGING_DEPLOYMENT_ID,
        releaseId: env.CLAXEDO_RELEASE_ID,
        authDatabaseId: env.CLAXEDO_STAGING_AUTH_D1_DATABASE_ID,
        controlPlaneDatabaseId: env.CLAXEDO_STAGING_CONTROL_PLANE_D1_DATABASE_ID,
      }),
    )
  })

  test("derives a stable content identity instead of trusting operator input", () => {
    expect(workerArtifactBuildId(new TextEncoder().encode("worker bytes"))).toBe(
      "sha256:c21a76a3790fc8178f87a15132fc331a1d824328fa66ef614aa462210e1c952e",
    )
    expect(() =>
      betterAuthD1ReleaseInputs({ ...env, CLAXEDO_WORKER_BUILD_ID: "operator-value" }, "production"),
    ).toThrow(/must not be supplied/)
  })

  test("derives a path-aware browser identity and renders an assets-only custom-domain Worker", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "claxedo-browser-artifact-"))
    try {
      await mkdir(path.join(directory, "assets"))
      await writeFile(path.join(directory, "index.html"), "<main>Claxedo</main>")
      await writeFile(path.join(directory, "assets", "app.js"), "console.log('app')")
      const first = await browserArtifactBuildId(directory)
      await writeFile(path.join(directory, "claxedo-browser-build.json"), JSON.stringify({ browserBuildId: first }))
      expect(await browserArtifactBuildId(directory)).toBe(first)
      await writeFile(path.join(directory, "assets", "app.js"), "console.log('changed')")
      expect(await browserArtifactBuildId(directory)).not.toBe(first)

      const config = renderBetterAuthBrowserWranglerConfig({ environment: "staging", browserDirectory: directory })
      expect(config).toContain('name = "claxedo-user-deployed-app-staging"')
      expect(config).toContain(`directory = ${JSON.stringify(directory)}`)
      expect(config).toContain('not_found_handling = "single-page-application"')
      expect(config).not.toContain("main =")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("removes Pages-only routing and upload-only source maps before hashing Worker assets", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "claxedo-worker-browser-"))
    try {
      await mkdir(path.join(directory, "assets"))
      await writeFile(path.join(directory, "_redirects"), "/* /index.html 200\n")
      await writeFile(path.join(directory, "index.html"), "worker app")
      await writeFile(path.join(directory, "assets", "app.js"), "console.log('app')")
      await writeFile(path.join(directory, "assets", "app.js.map"), "changing build-only metadata")

      await prepareBrowserArtifactsForWorkers(directory)

      expect((await readdir(directory)).sort()).toEqual(["assets", "index.html"])
      expect(await readdir(path.join(directory, "assets"))).toEqual(["app.js"])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("binds an atomic candidate secret rotation to a private mode-0600 bundle identity", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "claxedo-release-secrets-"))
    try {
      const file = path.join(directory, "secrets.json")
      await writeFile(file, JSON.stringify({ GITHUB_CLIENT_SECRET: "rotated-secret" }), { mode: 0o600 })
      const resolved = await resolveReleaseSecretsFile({ CLAXEDO_RELEASE_SECRETS_FILE: file }, [
        "BETTER_AUTH_SECRET",
        "GITHUB_CLIENT_SECRET",
      ])
      expect(resolved?.file).toBe(file)
      expect(resolved?.bundleId).toMatch(/^sha256:[0-9a-f]{64}$/)
      const buildId = `sha256:${"a".repeat(64)}`
      expect(candidateVersionTag("2", buildId, resolved?.bundleId)).not.toBe(candidateVersionTag("2", buildId))

      await writeFile(file, JSON.stringify({ UNEXPECTED_SECRET: "value" }), { mode: 0o600 })
      await expect(
        resolveReleaseSecretsFile({ CLAXEDO_RELEASE_SECRETS_FILE: file }, ["GITHUB_CLIENT_SECRET"]),
      ).rejects.toThrow(/unexpected secret/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("binds candidate recovery to the exact browser artifact", () => {
    const workerBuildId = `sha256:${"a".repeat(64)}`
    const firstBrowserBuildId = `sha256:${"b".repeat(64)}`
    const secondBrowserBuildId = `sha256:${"c".repeat(64)}`

    expect(candidateVersionTag("2", workerBuildId, undefined, firstBrowserBuildId)).not.toBe(
      candidateVersionTag("2", workerBuildId, undefined, secondBrowserBuildId),
    )
  })

  test("binds candidate recovery to the complete runtime configuration", () => {
    const workerBuildId = `sha256:${"a".repeat(64)}`
    const firstConfiguration = candidateConfigurationId(new Map([["CLAXEDO_WORKSPACE_RELAY_URL", "https://one"]]))
    const secondConfiguration = candidateConfigurationId(new Map([["CLAXEDO_WORKSPACE_RELAY_URL", "https://two"]]))

    expect(candidateVersionTag("2", workerBuildId, undefined, undefined, firstConfiguration)).not.toBe(
      candidateVersionTag("2", workerBuildId, undefined, undefined, secondConfiguration),
    )
  })

  test("renders one selected resource-closed config with real account IDs", () => {
    const input = betterAuthD1ReleaseInputs(env, "staging")
    const config = renderBetterAuthD1WranglerConfig({ staging: true, ...input })
    expect(config).toContain('name = "claxedo-user-deployed-locked-staging"')
    expect(config).toContain(
      'binding = "AUTH_DB"\ndatabase_name = "claxedo-auth-staging"\ndatabase_id = "22222222-2222-2222-2222-222222222222"\nmigrations_dir = "../migrations/auth"',
    )
    expect(config).toContain(
      'binding = "CONTROL_PLANE_DB"\ndatabase_name = "claxedo-control-plane-staging"\ndatabase_id = "44444444-4444-4444-4444-444444444444"\nmigrations_dir = "../migrations/control-plane"',
    )
    expect(config.match(/\[\[d1_databases\]\]/g)).toHaveLength(2)
    expect(config).toContain(`namespace_id = "${input.namespaceId}"`)
    expect(config).toContain("preview_urls = false")
    expect(config).toContain('[version_metadata]\nbinding = "CF_VERSION_METADATA"')
    expect(config).not.toContain("replace-with")
    expect(config).not.toContain("workgraph")
    expect(config).not.toContain("documents")
    expect(config).not.toContain("WORKGRAPH_DB")
    expect(config).not.toContain("WORKGRAPH_SERVICE")
    expect(config).not.toContain("WORKGRAPH_SETTLER")
    expect(config).not.toContain("WORKGRAPH_WAKE_LANE")
    expect(config).not.toContain("DOCUMENTS_DB")
    expect(config).not.toContain("DOCUMENTS_BUCKET")
    expect(config).not.toContain("DOCUMENTS_SERVICE")
  })

  test("requires supported provider composition and the remote secrets", () => {
    expect(() => betterAuthD1ReleaseInputs({ ...env, CLAXEDO_AUTH_METHODS: "email-password" }, "production")).toThrow(
      /email-sender/,
    )
    expect(() => betterAuthD1ReleaseInputs({ ...env, GITHUB_CLIENT_ID: undefined }, "production")).toThrow(
      /GITHUB_CLIENT_ID/,
    )
    const requiredSecrets = betterAuthD1ReleaseInputs(env, "production").requiredSecrets
    expect(requiredSecrets).toEqual([
      "BETTER_AUTH_SECRET",
      "CLAXEDO_AUTH_INTROSPECTION_SECRET",
      "CLAXEDO_RELEASE_OPERATOR_SECRET",
      "CLAXEDO_RELAY_RESOLVER_TOKEN",
      "CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM",
      "CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM",
      "CLAXEDO_RELAY_HOST_VERIFY_PEM",
      "GITHUB_CLIENT_SECRET",
    ])
    expect(() =>
      requireSecretInventory(
        JSON.stringify([{ name: "BETTER_AUTH_SECRET" }, { name: "GITHUB_CLIENT_SECRET" }]),
        requiredSecrets,
      ),
    ).toThrow(/CLAXEDO_AUTH_INTROSPECTION_SECRET/)
    expect(
      requireSecretInventory(
        JSON.stringify([
          { name: "BETTER_AUTH_SECRET" },
          { name: "CLAXEDO_AUTH_INTROSPECTION_SECRET" },
          { name: "CLAXEDO_RELEASE_OPERATOR_SECRET" },
          { name: "CLAXEDO_RELAY_RESOLVER_TOKEN" },
          { name: "CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM" },
          { name: "CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM" },
          { name: "CLAXEDO_RELAY_HOST_VERIFY_PEM" },
          { name: "GITHUB_CLIENT_SECRET" },
        ]),
        requiredSecrets,
      ),
    ).toBeUndefined()
  })

  test("requires canonical methods and physically isolated production and staging resources", () => {
    expect(() => betterAuthD1ReleaseInputs({ ...env, CLAXEDO_AUTH_METHODS: "github,github" }, "staging")).toThrow(
      /selected more than once/,
    )
    expect(() =>
      betterAuthD1ReleaseInputs(
        {
          ...env,
          CLAXEDO_STAGING_AUTH_D1_DATABASE_ID: env.CLAXEDO_PRODUCTION_AUTH_D1_DATABASE_ID,
        },
        "staging",
      ),
    ).toThrow(/production and staging AUTH_D1_DATABASE_ID must be distinct/)
    expect(() =>
      betterAuthD1ReleaseInputs(
        {
          ...env,
          CLAXEDO_STAGING_CONTROL_PLANE_D1_DATABASE_ID: env.CLAXEDO_PRODUCTION_CONTROL_PLANE_D1_DATABASE_ID,
        },
        "staging",
      ),
    ).toThrow(/production and staging CONTROL_PLANE_D1_DATABASE_ID must be distinct/)
    expect(() =>
      betterAuthD1ReleaseInputs(
        {
          ...env,
          CLAXEDO_STAGING_WORKSPACE_RELAY_URL: env.CLAXEDO_PRODUCTION_WORKSPACE_RELAY_URL,
        },
        "staging",
      ),
    ).toThrow(/production and staging WORKSPACE_RELAY_URL must be distinct/)
    expect(() =>
      betterAuthD1ReleaseInputs(
        {
          ...env,
          CLAXEDO_PRODUCTION_CONTROL_PLANE_D1_DATABASE_ID: env.CLAXEDO_PRODUCTION_AUTH_D1_DATABASE_ID,
        },
        "production",
      ),
    ).toThrow(/production AUTH and CONTROL_PLANE database IDs must be distinct/)
    expect(() =>
      betterAuthD1ReleaseInputs(
        {
          ...env,
          CLAXEDO_PRODUCTION_CONTROL_PLANE_D1_DATABASE_NAME: env.CLAXEDO_PRODUCTION_AUTH_D1_DATABASE_NAME,
        },
        "production",
      ),
    ).toThrow(/production AUTH and CONTROL_PLANE database names must be distinct/)
    expect(
      allocatedRequestLimiterNamespaceId(env.CLAXEDO_PRODUCTION_DEPLOYMENT_ID, "claxedo-user-deployed-locked"),
    ).not.toBe(
      allocatedRequestLimiterNamespaceId(env.CLAXEDO_STAGING_DEPLOYMENT_ID, "claxedo-user-deployed-locked-staging"),
    )
    expect(() =>
      betterAuthD1ReleaseInputs(
        {
          ...env,
          CLAXEDO_STAGING_API_ORIGIN: undefined,
          BETTER_AUTH_URL: env.CLAXEDO_PRODUCTION_API_ORIGIN,
        },
        "staging",
      ),
    ).toThrow(/CLAXEDO_STAGING_API_ORIGIN is required/)
  })

  test("accepts only one private Wrangler upload and exact deployment allocations", () => {
    const versionA = "11111111-1111-1111-1111-111111111111"
    const versionB = "22222222-2222-2222-2222-222222222222"
    const upload = JSON.stringify({
      type: "version-upload",
      worker_name: "claxedo-user-deployed-locked",
      version_id: versionB,
      preview_url: null,
      preview_alias_url: null,
    })
    expect(parseVersionUploadOutput(upload, "claxedo-user-deployed-locked")).toBe(versionB)
    expect(() =>
      parseVersionUploadOutput(
        upload.replace('"preview_url":null', '"preview_url":"https://preview.workers.dev"'),
        "claxedo-user-deployed-locked",
      ),
    ).toThrow(/private exact Worker version/)
    expect(() =>
      parseVersionUploadOutput(
        `${upload}\n${JSON.stringify({ type: "command-failed" })}`,
        "claxedo-user-deployed-locked",
      ),
    ).toThrow(/failed version upload/)

    const status = parseDeploymentStatus(
      JSON.stringify({
        versions: [
          { version_id: versionA, percentage: 100 },
          { version_id: versionB, percentage: 0 },
        ],
      }),
    )
    expect(
      requireDeploymentTraffic(status, [
        { versionId: versionA, percentage: 100 },
        { versionId: versionB, percentage: 0 },
      ]),
    ).toBeUndefined()
    expect(() => requireDeploymentTraffic(status, [{ versionId: versionB, percentage: 100 }])).toThrow(
      /exact certified allocation/,
    )
    expect(cloudflareVersionOverride("claxedo-user-deployed-locked", versionB)).toBe(
      `claxedo-user-deployed-locked="${versionB}"`,
    )
    expect(
      workerVersionHasLiveSyncRoom(
        JSON.stringify({
          resources: {
            bindings: [
              {
                type: "durable_object_namespace",
                name: "LIVE_SYNC_ROOM",
                class_name: "LiveSyncRoom",
              },
            ],
          },
        }),
      ),
    ).toBe(true)
    expect(
      workerVersionHasLiveSyncRoom(
        JSON.stringify({ resources: { bindings: [{ type: "d1", name: "CONTROL_PLANE_DB" }] } }),
      ),
    ).toBe(false)
  })

  test("recovers only a resource-identical tagged candidate", () => {
    const buildId = workerArtifactBuildId(new TextEncoder().encode("worker bytes"))
    const tag = candidateVersionTag("2", buildId)
    const variables = new Map([
      ["CLAXEDO_RELEASE_ID", "release-test-0002"],
      ["CLAXEDO_WORKER_BUILD_ID", buildId],
    ])
    const output = JSON.stringify([
      {
        id: "22222222-2222-2222-2222-222222222222",
        annotations: { "workers/tag": tag },
        resources: {
          bindings: [
            { type: "plain_text", name: "CLAXEDO_RELEASE_ID", text: "release-test-0002" },
            { type: "plain_text", name: "CLAXEDO_WORKER_BUILD_ID", text: buildId },
            { type: "d1", name: "AUTH_DB", id: "11111111-1111-1111-1111-111111111111" },
            { type: "d1", name: "CONTROL_PLANE_DB", id: "33333333-3333-3333-3333-333333333333" },
            { type: "ratelimit", name: "CLAXEDO_REQUEST_LIMITER", namespace_id: "2102" },
            { type: "version_metadata", name: "CF_VERSION_METADATA" },
          ],
        },
      },
    ])
    const listOutput = JSON.stringify([
      {
        id: "22222222-2222-2222-2222-222222222222",
        annotations: { "workers/tag": tag },
      },
    ])
    expect(taggedCandidateVersionId(listOutput, tag)).toBe("22222222-2222-2222-2222-222222222222")
    expect(
      recoverCandidateVersion({
        output,
        tag,
        expectedVariables: variables,
        authDatabaseId: "11111111-1111-1111-1111-111111111111",
        controlPlaneDatabaseId: "33333333-3333-3333-3333-333333333333",
        namespaceId: "2102",
      }),
    ).toBe("22222222-2222-2222-2222-222222222222")
    expect(() =>
      recoverCandidateVersion({
        output: output.replace('"namespace_id":"2102"', '"namespace_id":"2101"'),
        tag,
        expectedVariables: variables,
        authDatabaseId: "11111111-1111-1111-1111-111111111111",
        controlPlaneDatabaseId: "33333333-3333-3333-3333-333333333333",
        namespaceId: "2102",
      }),
    ).toThrow(/conflicting rate-limiter/)
    expect(() =>
      recoverCandidateVersion({
        output: output.replace(
          '"id":"33333333-3333-3333-3333-333333333333"',
          '"id":"55555555-5555-5555-5555-555555555555"',
        ),
        tag,
        expectedVariables: variables,
        authDatabaseId: "11111111-1111-1111-1111-111111111111",
        controlPlaneDatabaseId: "33333333-3333-3333-3333-333333333333",
        namespaceId: "2102",
      }),
    ).toThrow(/conflicting CONTROL_PLANE_DB/)
  })
})
