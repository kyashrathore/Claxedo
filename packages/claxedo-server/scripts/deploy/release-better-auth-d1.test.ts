import { describe, expect, test } from "vitest"

import {
  allocatedRequestLimiterNamespaceId,
  betterAuthD1DeploymentManifest,
  betterAuthD1DeploymentManifestPath,
  betterAuthD1ReleaseInputs,
  candidateVersionTag,
  cloudflareVersionOverride,
  parseDeploymentStatus,
  parseVersionUploadOutput,
  pairedD1RecoveryEpoch,
  recoverCandidateVersion,
  renderBetterAuthD1WranglerConfig,
  requireDeploymentTraffic,
  requireSecretInventory,
  workerArtifactBuildId,
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

  test("derives a stable content identity instead of trusting operator input", () => {
    expect(workerArtifactBuildId(new TextEncoder().encode("worker bytes"))).toBe(
      "sha256:c21a76a3790fc8178f87a15132fc331a1d824328fa66ef614aa462210e1c952e",
    )
    expect(() =>
      betterAuthD1ReleaseInputs({ ...env, CLAXEDO_WORKER_BUILD_ID: "operator-value" }, "production"),
    ).toThrow(/must not be supplied/)
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
