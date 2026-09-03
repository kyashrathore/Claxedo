import { describe, expect, test } from "vitest"

import { renderBetterAuthD1WranglerConfig } from "../../../scripts/deploy/release-better-auth-d1"

const source = renderBetterAuthD1WranglerConfig({
  staging: false,
  authDatabaseId: "11111111-1111-1111-1111-111111111111",
  authDatabaseName: "claxedo-auth",
  controlPlaneDatabaseId: "33333333-3333-3333-3333-333333333333",
  controlPlaneDatabaseName: "claxedo-control-plane",
  namespaceId: "2101",
})

describe("generated Better Auth D1 locked Wrangler config", () => {
  test("binds the isolated auth and control-plane databases and the required shared limiter", () => {
    expect(source).toContain('main = "../src/deployments/hosted-workerd/better-auth-d1-locked-worker.cf.ts"')
    expect(source).toContain('compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]')
    expect(source).toContain("workers_dev = false")
    expect(source.match(/binding = "AUTH_DB"/g)).toHaveLength(1)
    expect(source.match(/binding = "CONTROL_PLANE_DB"/g)).toHaveLength(1)
    expect(source.match(/migrations_dir = "..\/migrations\/auth"/g)).toHaveLength(1)
    expect(source.match(/migrations_dir = "..\/migrations\/control-plane"/g)).toHaveLength(1)
    expect(source.match(/name = "CLAXEDO_REQUEST_LIMITER"/g)).toHaveLength(1)
    expect(source).toContain('CLAXEDO_ADAPTER_PROFILE = "better-auth-d1"')
    expect(source).toContain('CLAXEDO_PRODUCT_POSTURE = "user-deployed"')
    expect(source).toContain('CLAXEDO_SANDBOX_POSTURE = "control-plane-only"')
    expect(source).not.toContain("replace-with")
  })

  test("contains no optional-service, billing, sandbox, cron, or Durable Object resource", () => {
    const lowered = source.toLowerCase()
    for (const forbidden of [
      "r2_buckets",
      "durable_objects",
      "[[migrations]]",
      "[triggers]",
      "wake_lane",
      "live_sync_room",
      "claxedo_documents",
      "polar",
      "sandbox_driver",
    ])
      expect(lowered, `unexpected ${forbidden} resource/config`).not.toContain(forbidden)
  })
})
