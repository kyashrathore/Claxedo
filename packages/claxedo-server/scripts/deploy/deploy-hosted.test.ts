import { describe, expect, test } from "vitest"
import { hostedDeployCommands } from "./deploy-hosted"

const claxedoHostedEnv = {
  CLAXEDO_ADAPTER_PROFILE: "clerk-convex",
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
  test("targets the explicit staging Worker environment", () => {
    expect(
      hostedDeployCommands({ staging: true, dryRun: true, targets: ["central"], env: claxedoHostedEnv })[0]!.args,
    ).toEqual(["deploy", "--env", "staging", "--dry-run", "--outdir", "dist-worker"])
  })

  test("targets the top-level production Worker when staging is false", () => {
    expect(
      hostedDeployCommands({ staging: false, dryRun: false, targets: ["central"], env: claxedoHostedEnv })[0]!.args,
    ).toEqual(["deploy", "--env", ""])
  })

  test("installs Cloudflare Sandbox Worker dependencies from the committed lockfile", () => {
    const commands = hostedDeployCommands({
      staging: false,
      dryRun: false,
      targets: ["cloudflare-sandbox"],
      env: claxedoHostedEnv,
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
          CLERK_SECRET_KEY: "clerk-secret",
          CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
        },
      }),
    ).toThrowError(/adapter profile must be/)
  })

  test("does not pretend the Clerk-only browser build is a Better Auth artifact", () => {
    expect(() =>
      hostedDeployCommands({
        staging: false,
        dryRun: true,
        targets: ["app"],
        env: {
          ...betterAuthD1Env,
          VITE_CLERK_PUBLISHABLE_KEY: "must-not-leak",
          VITE_CONVEX_URL: "https://must-not-leak.test",
        },
      }),
    ).toThrow(/supports only the central target/)
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
    ).toThrowError(/supports only the central target/)
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
    expect(all.toLowerCase()).not.toContain("workgraph")
    expect(all.toLowerCase()).not.toContain("documents")
    expect(all.toLowerCase()).not.toContain("clerk")
    expect(all.toLowerCase()).not.toContain("convex")
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
