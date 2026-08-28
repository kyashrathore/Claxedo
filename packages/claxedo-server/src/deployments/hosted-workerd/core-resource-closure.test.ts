import { readFile } from "node:fs/promises"
import path from "node:path"

import { describe, expect, test } from "vitest"

import { renderHostedCoreWranglerConfig } from "../../../scripts/deploy/render-hosted-core-config"
import { certifiedHostedWorkerArtifact } from "./certified-worker-artifacts"

const packageRoot = path.resolve(import.meta.dirname, "../../..")

const lockedCoreBoundary = {
  artifactId: "user-deployed-better-auth-d1-locked" as const,
  deploymentId: "deployment-production",
  authDatabase: { name: "claxedo-auth-production", id: "auth-production-id" },
  controlPlaneDatabase: {
    name: "claxedo-core-production",
    id: "core-production-id",
  },
  limiter: {
    owner: "core",
    environment: "production" as const,
    namespaceId: "3123456789",
  },
}

const openCoreBoundary = {
  ...lockedCoreBoundary,
  artifactId: "user-deployed-better-auth-d1-open" as const,
  userDeployedOrganization: { id: "org_deployment", name: "My deployment" },
}

describe("certified core resource ownership", () => {
  test("the generated locked boundary owns only auth/control D1 and the limiter", () => {
    const config = renderHostedCoreWranglerConfig(lockedCoreBoundary)

    expect([...config.matchAll(/^binding = "([A-Z][A-Z0-9_]+)"$/gm)].map((match) => match[1])).toEqual([
      "CF_VERSION_METADATA",
      "AUTH_DB",
      "CONTROL_PLANE_DB",
    ])
    expect([...config.matchAll(/^name = "([A-Z][A-Z0-9_]+)"$/gm)].map((match) => match[1])).toEqual([
      "CLAXEDO_REQUEST_LIMITER",
    ])
    expect(config).not.toMatch(
      /WORKGRAPH|WAKE_LANE|DOCUMENTS|CLAXEDO_DOCUMENTS|LIVE_SYNC_ROOM|r2_buckets|durable_objects|crons|POLAR/i,
    )
  })

  test("maps only to an existing default-exporting Worker, never the core factory", async () => {
    const artifact = certifiedHostedWorkerArtifact(lockedCoreBoundary.artifactId, "production")
    const source = await readFile(path.join(packageRoot, artifact.entrypointFromPackageRoot), "utf8")
    expect(source).toMatch(/export default handler/)
    expect(artifact.entrypointFromPackageRoot).not.toBe("src/deployments/hosted-workerd/core-worker.cf.ts")
  })

  test("the open artifact owns a fresh LiveSyncRoom v1 history and no optional-service resource", async () => {
    const artifact = certifiedHostedWorkerArtifact(openCoreBoundary.artifactId, "production")
    const source = await readFile(path.join(packageRoot, artifact.entrypointFromPackageRoot), "utf8")
    const config = renderHostedCoreWranglerConfig(openCoreBoundary)

    expect(source).toMatch(/export default handler/)
    expect(source).toMatch(/export \{ LiveSyncRoom \}/)
    expect(config).toContain('name = "claxedo-user-deployed-core"')
    expect(config).toContain('name = "LIVE_SYNC_ROOM"')
    expect(config).toContain('tag = "v1"\nnew_sqlite_classes = ["LiveSyncRoom"]')
    expect(config).not.toMatch(/WORKGRAPH|WAKE_LANE|DOCUMENTS|POLAR|BILLING/i)
  })

  test("does not rewrite or reuse the legacy WorkGraph/Wake DO migration history", async () => {
    const legacy = await readFile(new URL("../../../wrangler.toml", import.meta.url), "utf8")

    expect(legacy).toContain('name = "claxedo-control-plane"')
    expect(legacy).toContain('name = "claxedo-control-plane-staging"')
    expect(legacy).toContain('tag = "v1"\nnew_sqlite_classes = ["WorkGraphSettler"]')
    expect(legacy).toContain('tag = "v2"\nnew_sqlite_classes = ["ClaxedoWakeLane"]')
    expect(legacy).toContain('tag = "v3"\nnew_sqlite_classes = ["LiveSyncRoom"]')
    expect(renderHostedCoreWranglerConfig(lockedCoreBoundary)).toContain('name = "claxedo-user-deployed-locked"')
    expect(renderHostedCoreWranglerConfig(openCoreBoundary)).toContain('name = "claxedo-user-deployed-core"')
  })
})
