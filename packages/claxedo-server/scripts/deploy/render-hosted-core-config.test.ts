import { access, readFile } from "node:fs/promises"
import path from "node:path"

import { describe, expect, test } from "vitest"

import {
  certifiedHostedWorkerArtifact,
  requireNonLegacyWorkerName,
} from "../../src/deployments/hosted-workerd/certified-worker-artifacts"
import { renderHostedCoreWranglerConfig, requireUniqueRateLimitNamespaces } from "./render-hosted-core-config"

const packageRoot = path.resolve(import.meta.dirname, "../..")

const base = {
  artifactId: "user-deployed-better-auth-d1-locked" as const,
  deploymentId: "deployment-1",
  authDatabase: { name: "claxedo-auth-production", id: "auth-id" },
  controlPlaneDatabase: { name: "claxedo-core-production", id: "core-id" },
  limiter: {
    owner: "core",
    environment: "production" as const,
    namespaceId: "3123456789",
  },
}

describe("certified hosted Worker renderer", () => {
  test("renders the real locked Better Auth+D1 artifact with its exact resource closure", async () => {
    const artifact = certifiedHostedWorkerArtifact(base.artifactId, "production")
    await access(path.join(packageRoot, artifact.entrypointFromPackageRoot))
    const entrypoint = await readFile(path.join(packageRoot, artifact.entrypointFromPackageRoot), "utf8")
    expect(entrypoint).toMatch(/export default handler/)
    const bootstrapEntrypoint = await readFile(
      path.join(packageRoot, artifact.bootstrapEntrypointFromPackageRoot),
      "utf8",
    )
    expect(bootstrapEntrypoint).toMatch(/export default/)

    const config = renderHostedCoreWranglerConfig(base)
    expect(config).toContain('name = "claxedo-user-deployed-locked"')
    expect(config).toContain('main = "src/deployments/hosted-workerd/better-auth-d1-locked-worker.cf.ts"')
    for (const required of ["AUTH_DB", "CONTROL_PLANE_DB", "CLAXEDO_REQUEST_LIMITER"]) {
      expect(config).toContain(required)
    }
    for (const forbidden of [
      "LIVE_SYNC_ROOM",
      "DOCUMENTS_SERVICE",
      "DOCUMENTS_DB",
      "DOCUMENTS_BUCKET",
      "WAKE_LANE",
      "CLAXEDO_DOCUMENTS",
      "r2_buckets",
      "durable_objects",
      "[[migrations]]",
      "[triggers]",
      "crons",
      "POLAR",
      "BILLING",
    ]) {
      expect(config).not.toContain(forbidden)
    }
    expect(config).toContain("workers_dev = false")
    expect(config).toContain("preview_urls = false")
  })

  test("derives staging name and entrypoint from the same closed artifact", () => {
    const config = renderHostedCoreWranglerConfig({
      ...base,
      limiter: { ...base.limiter, environment: "staging" },
    })
    expect(config).toContain('name = "claxedo-user-deployed-locked-staging"')
    expect(config).toContain('main = "src/deployments/hosted-workerd/better-auth-d1-locked-worker.cf.ts"')
  })

  test("renders the phase-gated cutover bytes on the locked release-train Worker name", async () => {
    const input = {
      ...base,
      artifactId: "user-deployed-better-auth-d1-candidate" as const,
      userDeployedOrganization: { id: "org_deployment", name: "My deployment" },
    }
    const artifact = certifiedHostedWorkerArtifact(input.artifactId, "production")
    const entrypoint = await readFile(path.join(packageRoot, artifact.entrypointFromPackageRoot), "utf8")
    expect(entrypoint).toMatch(/export default handler/)
    expect(entrypoint).toMatch(/export \{ LiveSyncRoom \}/)

    const config = renderHostedCoreWranglerConfig(input)
    expect(config).toContain('name = "claxedo-user-deployed-locked"')
    expect(config).toContain('main = "src/deployments/hosted-workerd/better-auth-d1-candidate-worker.cf.ts"')
    expect(config).toContain('name = "LIVE_SYNC_ROOM"')
    expect(config).toContain('tag = "v1"\nnew_sqlite_classes = ["LiveSyncRoom"]')
    expect(config).not.toMatch(/WAKE_LANE|DOCUMENTS|POLAR|BILLING/i)
  })

  test("rejects unknown artifacts instead of accepting a free-form main", () => {
    expect(() =>
      renderHostedCoreWranglerConfig({
        ...base,
        artifactId: "arbitrary-open-core",
      } as never),
    ).toThrow(/is not certified/)
    expect(() =>
      renderHostedCoreWranglerConfig({
        ...base,
        main: "src/deployments/hosted-workerd/core-worker.cf.ts",
      } as never),
    ).toThrow(/unsupported fields: main/)
    expect(() =>
      renderHostedCoreWranglerConfig({
        ...base,
        workerName: "arbitrary-worker",
      } as never),
    ).toThrow(/unsupported fields: workerName/)
  })

  test("reserves legacy Worker names with their append-only DO migration history", () => {
    expect(() => requireNonLegacyWorkerName("claxedo-control-plane")).toThrow(
      /legacy Worker.*append-only Durable Object migration history/,
    )
    expect(() => requireNonLegacyWorkerName("claxedo-control-plane-staging")).toThrow(
      /legacy Worker.*append-only Durable Object migration history/,
    )
    expect(requireNonLegacyWorkerName("claxedo-user-deployed-locked")).toBe("claxedo-user-deployed-locked")
    expect(requireNonLegacyWorkerName("claxedo-user-deployed-locked")).toBe("claxedo-user-deployed-locked")
  })

  test("pins the shared rate-limit window and ceiling to the local fuse", () => {
    // Recovered from the retired package-root wrangler.toml guard. Cloudflare
    // accepts only 10 or 60 for `period`, and 60 is not a preference: the
    // hosted app's own limiter runs on `defaultRequestRateLimitWindowMs`
    // (60_000ms), so a `period` of 10 would make the SHARED ceiling six times
    // tighter than the configured `limit` implies — a throttle nobody
    // configured and no test would have caught.
    for (const input of [
      base,
      {
        ...base,
        artifactId: "user-deployed-better-auth-d1-candidate" as const,
        userDeployedOrganization: { id: "org_deployment", name: "My deployment" },
      },
    ]) {
      expect(renderHostedCoreWranglerConfig(input))
        .toContain('[ratelimits.simple]\nlimit = 600\nperiod = 60')
    }
  })

  test("rejects namespace reuse across products and environments", () => {
    expect(() =>
      requireUniqueRateLimitNamespaces([
        { owner: "core", environment: "production", namespaceId: "3001" },
        { owner: "documents", environment: "staging", namespaceId: "3001" },
      ]),
    ).toThrow(/reused/)
  })
})
