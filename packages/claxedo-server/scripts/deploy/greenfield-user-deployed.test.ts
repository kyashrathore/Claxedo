import { describe, expect, test } from "vitest"
import { readFile } from "node:fs/promises"

import {
  GREENFIELD_USER_DEPLOYED_GUIDE_PATH,
  checkedGreenfieldUserDeployedGuide,
  greenfieldUserDeployedPreflight,
  requireGreenfieldUserDeployedResourceClosure,
  renderGreenfieldUserDeployedGuide,
} from "./greenfield-user-deployed"

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
  BETTER_AUTH_SECRET: "better-auth-secret-at-least-32-characters",
  CLAXEDO_AUTH_INTROSPECTION_SECRET: "introspection-secret-at-least-32-characters",
  CLAXEDO_RELEASE_OPERATOR_SECRET: "release-operator-secret-at-least-32-characters",
  CLAXEDO_PRODUCTION_AUTH_D1_DATABASE_ID: "11111111-1111-1111-1111-111111111111",
  CLAXEDO_STAGING_AUTH_D1_DATABASE_ID: "22222222-2222-2222-2222-222222222222",
  CLAXEDO_PRODUCTION_AUTH_D1_DATABASE_NAME: "claxedo-auth-production",
  CLAXEDO_STAGING_AUTH_D1_DATABASE_NAME: "claxedo-auth-staging",
  CLAXEDO_PRODUCTION_CONTROL_PLANE_D1_DATABASE_ID: "33333333-3333-3333-3333-333333333333",
  CLAXEDO_STAGING_CONTROL_PLANE_D1_DATABASE_ID: "44444444-4444-4444-4444-444444444444",
  CLAXEDO_PRODUCTION_CONTROL_PLANE_D1_DATABASE_NAME: "claxedo-control-plane-production",
  CLAXEDO_STAGING_CONTROL_PLANE_D1_DATABASE_NAME: "claxedo-control-plane-staging",
}

describe("greenfield user-deployed Cloudflare preflight", () => {
  test("certifies one-org multiplayer with only the selected GitHub auth and mandatory core resources", () => {
    const preflight = greenfieldUserDeployedPreflight(env, "production")

    expect(preflight.product).toEqual({
      productPosture: "user-deployed",
      organizationPolicy: "single-org",
      billing: "absent",
      multiplayer: true,
    })
    expect(preflight.auth).toEqual({
      adapter: "better-auth-d1",
      methods: ["github"],
      publicVariables: ["GITHUB_CLIENT_ID"],
      secrets: [
        "BETTER_AUTH_SECRET",
        "CLAXEDO_AUTH_INTROSPECTION_SECRET",
        "CLAXEDO_RELEASE_OPERATOR_SECRET",
        "CLAXEDO_RELAY_RESOLVER_TOKEN",
        "CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM",
        "CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM",
        "CLAXEDO_RELAY_HOST_VERIFY_PEM",
        "GITHUB_CLIENT_SECRET",
      ],
      callbackUrls: [
        "https://api.claxedo.test/api/auth/callback/github",
        "https://api-staging.claxedo.test/api/auth/callback/github",
      ],
    })
    expect(preflight.resources).toEqual([
      { binding: "AUTH_DB", kind: "d1", name: "claxedo-auth-production" },
      { binding: "CONTROL_PLANE_DB", kind: "d1", name: "claxedo-control-plane-production" },
      { binding: "CLAXEDO_REQUEST_LIMITER", kind: "rate-limit" },
    ])
    expect(preflight.terminalPhase).toBe("locked")

    for (const forbidden of [
      "DOCUMENTS_SERVICE",
      "DOCUMENTS_DB",
      "DOCUMENTS_BUCKET",
      "CLAXEDO_DOCUMENTS",
      "POLAR",
      "BILLING",
      "GOOGLE_CLIENT",
      "r2_buckets",
      "durable_objects",
      "[triggers]",
      "crons",
    ]) {
      expect(preflight.wranglerConfig.toUpperCase()).not.toContain(forbidden.toUpperCase())
    }
  })

  test("generates the locked bootstrap and same-version cutover sequence without claiming unverified evidence", () => {
    const guide = renderGreenfieldUserDeployedGuide(greenfieldUserDeployedPreflight(env, "production"))

    expect(guide).toContain("one organization")
    expect(guide).toContain("multiplayer")
    expect(guide).toContain("Better Auth + D1")
    expect(guide).toContain("same Cloudflare")
    expect(guide).toContain("bun run deploy:user-cloudflare:preflight")
    expect(guide).toContain("bun run scripts/deploy/release-better-auth-d1.ts --deploy --bootstrap")
    expect(guide).toContain("bun run scripts/deploy/release-better-auth-d1.ts --deploy")
    expect(guide).toContain("bun run scripts/deploy/release-better-auth-d1.ts --deploy --cutover")
    expect(guide).toContain("GITHUB_CLIENT_ID")
    expect(guide).toContain("GITHUB_CLIENT_SECRET")
    expect(guide).toContain("BETTER_AUTH_SECRET")
    expect(guide).toContain("CLAXEDO_AUTH_INTROSPECTION_SECRET")
    expect(guide).toContain("CLAXEDO_STAGING_WORKSPACE_RELAY_URL")
    expect(guide).toContain("CLAXEDO_RELAY_RESOLVER_TOKEN")
    expect(guide).toContain("export BETTER_AUTH_SECRET='<deployment-owned secret of at least 32 characters>'")
    expect(guide).toContain(
      "export CLAXEDO_AUTH_INTROSPECTION_SECRET='<different deployment-owned secret of at least 32 characters>'",
    )
    expect(guide).toContain("cutover-better-auth-d1.ts --status")
    expect(guide).toContain("has no raw phase or arbitrary evidence input")
    expect(guide).toContain("/__release/canary/identity")
    expect(guide).toContain("provision-user-deployed-owner-claim.ts --provision")
    expect(guide).not.toContain("GOOGLE_CLIENT_ID")
    expect(guide).not.toContain("GOOGLE_CLIENT_SECRET")

    for (const unavailable of ["canary", "provider_sync", "multiplayer_validation", "open"]) {
      expect(guide).toContain(`\`${unavailable}\``)
    }
    for (const forbiddenResource of [
      "DOCUMENTS_DB",
      "DOCUMENTS_BUCKET",
      "DOCUMENTS_SERVICE",
      "POLAR_ACCESS_TOKEN",
      "BILLING",
      "CLAXEDO_DOCUMENTS",
    ]) {
      expect(guide).not.toContain(forbiddenResource)
    }
  })

  test("switches the generated inventory to Google without retaining GitHub credentials", () => {
    const googleEnv = {
      ...env,
      CLAXEDO_AUTH_METHODS: "google",
      GITHUB_CLIENT_ID: undefined,
      GOOGLE_CLIENT_ID: "google-client",
    }
    const preflight = greenfieldUserDeployedPreflight(googleEnv, "staging")
    const guide = renderGreenfieldUserDeployedGuide(preflight)

    expect(preflight.auth.publicVariables).toEqual(["GOOGLE_CLIENT_ID"])
    expect(preflight.auth.secrets).toEqual([
      "BETTER_AUTH_SECRET",
      "CLAXEDO_AUTH_INTROSPECTION_SECRET",
      "CLAXEDO_RELEASE_OPERATOR_SECRET",
      "CLAXEDO_RELAY_RESOLVER_TOKEN",
      "CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM",
      "CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM",
      "CLAXEDO_RELAY_HOST_VERIFY_PEM",
      "GOOGLE_CLIENT_SECRET",
    ])
    expect(guide).toContain("GOOGLE_CLIENT_ID")
    expect(guide).toContain("GOOGLE_CLIENT_SECRET")
    expect(guide).not.toContain("GITHUB_CLIENT_ID")
    expect(guide).not.toContain("GITHUB_CLIENT_SECRET")
    expect(guide).not.toContain("GitHub")
    expect(guide).toContain("--staging")
  })

  test("keeps the checked-in public guide byte-for-byte generated", async () => {
    await expect(readFile(GREENFIELD_USER_DEPLOYED_GUIDE_PATH, "utf8")).resolves.toBe(
      checkedGreenfieldUserDeployedGuide(),
    )
  })

  test("rejects an optional-service or billing resource injected into the generated config", () => {
    const config = greenfieldUserDeployedPreflight(env, "production").wranglerConfig
    expect(() =>
      requireGreenfieldUserDeployedResourceClosure(
        `${config}\n[[r2_buckets]]\nbinding = "DOCUMENTS_BUCKET"\nbucket_name = "documents"\n`,
      ),
    ).toThrow(/resource closure/)
    expect(() =>
      requireGreenfieldUserDeployedResourceClosure(`${config}\n[vars]\nPOLAR_ACCESS_TOKEN = "wrong"\n`),
    ).toThrow(/resource closure/)
  })

  test("requires distinct deployment-owned auth, introspection, and operator secrets", () => {
    expect(() =>
      greenfieldUserDeployedPreflight({ ...env, CLAXEDO_AUTH_INTROSPECTION_SECRET: undefined }, "production"),
    ).toThrow(/CLAXEDO_AUTH_INTROSPECTION_SECRET.*at least 32/)
    expect(() =>
      greenfieldUserDeployedPreflight(
        {
          ...env,
          CLAXEDO_RELEASE_OPERATOR_SECRET: env.BETTER_AUTH_SECRET,
        },
        "production",
      ),
    ).toThrow(/distinct trust identities/)
  })
})
