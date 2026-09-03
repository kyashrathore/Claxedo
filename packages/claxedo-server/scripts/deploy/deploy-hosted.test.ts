import { describe, expect, test } from "vitest"
import { hostedDeployCommands } from "./deploy-hosted"

const sandboxEnv = {
  CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
  CLAXEDO_PRODUCT_POSTURE: "claxedo-hosted",
  CLAXEDO_SANDBOX_POSTURE: "full-hosted",
  CLAXEDO_SANDBOX_DRIVER: "cloudflare",
}

const betterAuthD1Env = {
  CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
  CLAXEDO_PRODUCT_POSTURE: "user-deployed",
  CLAXEDO_SANDBOX_POSTURE: "control-plane-only",
  CLAXEDO_PRODUCTION_DEPLOYMENT_ID: "deployment-production-01",
  CLAXEDO_STAGING_DEPLOYMENT_ID: "deployment-staging-01",
  CLAXEDO_RELEASE_SEQUENCE: "1",
  CLAXEDO_RELEASE_ID: "release-test-0001",
  CLAXEDO_AUTH_METHODS: "github",
  GITHUB_CLIENT_ID: "github-client",
  CLAXEDO_PRODUCTION_API_ORIGIN: "https://api.claxedo.test",
  CLAXEDO_STAGING_API_ORIGIN: "https://api-staging.claxedo.test",
  CLAXEDO_PRODUCTION_APP_ORIGIN: "https://app.claxedo.test",
  CLAXEDO_STAGING_APP_ORIGIN: "https://app-staging.claxedo.test",
  CLAXEDO_PRODUCTION_WORKSPACE_RELAY_URL: "https://relay.claxedo.test",
  CLAXEDO_STAGING_WORKSPACE_RELAY_URL: "https://relay-staging.claxedo.test",
  CLAXEDO_PRODUCTION_AUTH_D1_DATABASE_ID: "11111111-1111-1111-1111-111111111111",
  CLAXEDO_STAGING_AUTH_D1_DATABASE_ID: "22222222-2222-2222-2222-222222222222",
  CLAXEDO_PRODUCTION_AUTH_D1_DATABASE_NAME: "claxedo-auth-production",
  CLAXEDO_STAGING_AUTH_D1_DATABASE_NAME: "claxedo-auth-staging",
  CLAXEDO_PRODUCTION_CONTROL_PLANE_D1_DATABASE_ID: "33333333-3333-3333-3333-333333333333",
  CLAXEDO_STAGING_CONTROL_PLANE_D1_DATABASE_ID: "44444444-4444-4444-4444-444444444444",
  CLAXEDO_PRODUCTION_CONTROL_PLANE_D1_DATABASE_NAME: "claxedo-control-plane-production",
  CLAXEDO_STAGING_CONTROL_PLANE_D1_DATABASE_NAME: "claxedo-control-plane-staging",
}

describe("hosted deploy command selection", () => {
  test("installs Cloudflare Sandbox Worker dependencies from the committed lockfile", () => {
    const commands = hostedDeployCommands({
      staging: false,
      dryRun: false,
      targets: ["cloudflare-sandbox"],
      env: sandboxEnv,
    })

    expect(commands.find((command) => command.name === "cloudflare_sandbox.dependencies")).toMatchObject({
      cmd: "npm",
      args: ["ci"],
    })
  })

  test("refuses to infer the deployment profile from provider credentials", () => {
    expect(() =>
      hostedDeployCommands({
        staging: false,
        dryRun: true,
        targets: ["central"],
        env: {
          CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://authority.test",
        },
      }),
    ).toThrowError(/adapter profile must be/)
  })

  test("rejects the retired app target", () => {
    expect(() =>
      hostedDeployCommands({
        staging: false,
        dryRun: true,
        // @ts-expect-error retired target: app deploys go through the
        // deploy-claxedo-app workflows, not this script.
        targets: ["app"],
        env: betterAuthD1Env,
      }),
    ).toThrow(/supports only the central and cloudflare-sandbox targets/)
  })

  test("refuses to deploy a sandbox resource for control-plane-only", () => {
    expect(() =>
      hostedDeployCommands({
        staging: false,
        dryRun: true,
        targets: ["cloudflare-sandbox"],
        env: {
          CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
          CLAXEDO_PRODUCT_POSTURE: "user-deployed",
          CLAXEDO_SANDBOX_POSTURE: "control-plane-only",
        },
      }),
    ).toThrowError(/full-hosted Cloudflare sandbox profile/)
  })

  test("uses the single-artifact Better Auth D1 release orchestrator", () => {
    const commands = hostedDeployCommands({
      staging: true,
      dryRun: false,
      targets: ["central"],
      env: betterAuthD1Env,
    })
    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatchObject({
      cmd: "bun",
      args: ["run", "scripts/deploy/release-better-auth-d1.ts", "--staging", "--deploy"],
    })
    const all = JSON.stringify(commands)
    expect(all).not.toContain("d1 create")
    expect(all.toLowerCase()).not.toContain("documents")
  })

  test("keeps a Better Auth D1 dry-run mutation-free and requires build-bound inputs", () => {
    const commands = hostedDeployCommands({
      staging: false,
      dryRun: true,
      targets: ["central"],
      env: betterAuthD1Env,
    })
    expect(commands).toHaveLength(1)
    expect(commands[0]?.name).toBe("better_auth_d1.release.preflight")
    expect(() =>
      hostedDeployCommands({
        staging: false,
        dryRun: true,
        targets: ["central"],
        env: { ...betterAuthD1Env, CLAXEDO_RELEASE_ID: undefined },
      }),
    ).toThrow(/CLAXEDO_RELEASE_ID is required/)
    expect(() =>
      hostedDeployCommands({
        staging: false,
        dryRun: true,
        targets: ["central"],
        env: { ...betterAuthD1Env, CLAXEDO_PRODUCTION_API_ORIGIN: "https://candidate.workers.dev" },
      }),
    ).toThrow(/custom API origin/)
  })
})
