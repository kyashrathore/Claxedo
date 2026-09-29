import { describe, expect, test } from "vitest"

import {
  allocatedRequestLimiterNamespaceId,
  authConfigurationId,
  deployReadSecrets,
  oauthCallbackUrls,
  userCloudflareDeployment,
  userCloudflareTarget,
  workerVariables,
} from "./user-cloudflare-config"

const env = {
  CLAXEDO_API_ORIGIN: "https://api.example.com",
  CLAXEDO_APP_ORIGIN: "https://app.example.com",
  CLAXEDO_WORKSPACE_RELAY_URL: "https://relay.example.com",
  CLAXEDO_USER_DEPLOYED_ORGANIZATION_NAME: "Acme",
  GITHUB_CLIENT_ID: "github-client",
} satisfies NodeJS.ProcessEnv

describe("user-deployed Cloudflare configuration", () => {
  test("a minimal environment deploys the plain Worker under plain default names", () => {
    const deployment = userCloudflareDeployment(env, { agentPlugins: false })
    expect(deployment).toMatchObject({
      workerName: "claxedo",
      appWorkerName: "claxedo-app",
      deploymentId: "claxedo",
      organization: { id: "claxedo", name: "Acme" },
      authMethods: ["github"],
      databases: { AUTH_DB: "claxedo-auth", CONTROL_PLANE_DB: "claxedo-control-plane" },
      requestLimiterNamespaceId: allocatedRequestLimiterNamespaceId("claxedo", "claxedo"),
    })
    expect(deployment.artifact.artifactId).toBe("user-deployed-better-auth-d1")
    expect(deployment.workerName).not.toContain("locked")
    expect(deployment.requiredSecrets).toEqual([
      "BETTER_AUTH_SECRET",
      "CLAXEDO_AUTH_INTROSPECTION_SECRET",
      "CLAXEDO_RELAY_RESOLVER_TOKEN",
      "CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM",
      "CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM",
      "CLAXEDO_RELAY_HOST_VERIFY_PEM",
      "GITHUB_CLIENT_SECRET",
    ])
    expect(oauthCallbackUrls(deployment)).toEqual(["https://api.example.com/api/auth/callback/github"])
  })

  test("every name is a per-deployment setting, so an existing deployment keeps its Workers and databases", () => {
    const target = userCloudflareTarget({
      ...env,
      CLAXEDO_WORKER_NAME: "claxedo-user-deployed-locked-staging",
      CLAXEDO_APP_WORKER_NAME: "claxedo-user-deployed-app-staging",
      CLAXEDO_DEPLOYMENT_ID: "deployment-staging",
      CLAXEDO_AUTH_D1_DATABASE_NAME: "claxedo-auth-staging",
      CLAXEDO_CONTROL_PLANE_D1_DATABASE_NAME: "claxedo-control-plane-staging",
    })
    expect(target).toEqual({
      workerName: "claxedo-user-deployed-locked-staging",
      appWorkerName: "claxedo-user-deployed-app-staging",
      deploymentId: "deployment-staging",
      apiOrigin: "https://api.example.com",
      appOrigin: "https://app.example.com",
      databases: { AUTH_DB: "claxedo-auth-staging", CONTROL_PLANE_DB: "claxedo-control-plane-staging" },
    })
  })

  test("refuses origins the custom-domain Workers cannot serve", () => {
    expect(() => userCloudflareTarget({ ...env, CLAXEDO_API_ORIGIN: "https://candidate.workers.dev" })).toThrow(
      /custom domain/,
    )
    expect(() => userCloudflareTarget({ ...env, CLAXEDO_APP_ORIGIN: "https://app.pages.dev" })).toThrow(/custom domain/)
    expect(() => userCloudflareTarget({ ...env, CLAXEDO_API_ORIGIN: "http://api.example.com" })).toThrow(/exact HTTPS/)
    expect(() => userCloudflareTarget({ ...env, CLAXEDO_API_ORIGIN: "https://api.example.com/v1" })).toThrow(/exact HTTPS/)
    expect(() => userCloudflareTarget({ ...env, CLAXEDO_APP_ORIGIN: env.CLAXEDO_API_ORIGIN })).toThrow(/different hosts/)
    expect(() => userCloudflareTarget({ ...env, CLAXEDO_API_ORIGIN: "" })).toThrow(/CLAXEDO_API_ORIGIN is required/)
  })

  test("refuses shared databases, reserved Worker names and a sign-in method with no email sender", () => {
    expect(() =>
      userCloudflareTarget({ ...env, CLAXEDO_AUTH_D1_DATABASE_NAME: "db", CLAXEDO_CONTROL_PLANE_D1_DATABASE_NAME: "db" }),
    ).toThrow(/different databases/)
    expect(() => userCloudflareTarget({ ...env, CLAXEDO_WORKER_NAME: "claxedo-control-plane" })).toThrow(/reserved/)
    expect(() => userCloudflareDeployment({ ...env, CLAXEDO_AUTH_METHODS: "email-password" }, { agentPlugins: false }))
      .toThrow(/email-sender/)
    expect(() => userCloudflareDeployment({ ...env, CLAXEDO_AUTH_METHODS: "google" }, { agentPlugins: false })).toThrow(
      /GOOGLE_CLIENT_ID is required/,
    )
  })

  test("full-hosted selects the full-hosted Agent Plugins Worker with its driver configuration and secret", () => {
    const deployment = userCloudflareDeployment(
      {
        ...env,
        CLAXEDO_SANDBOX_POSTURE: "full-hosted",
        CLAXEDO_SANDBOX_DRIVER: "cloudflare",
        CLAXEDO_SANDBOX_WORKER_URL: "https://sandbox.example.com",
      },
      { agentPlugins: true },
    )
    expect(deployment.artifact.artifactId).toBe("user-deployed-better-auth-d1-agent-plugins-full-hosted")
    expect(deployment.agentPluginsBucket).toBe("claxedo-agent-plugins")
    expect(deployment.sandbox?.variables).toEqual({
      CLAXEDO_SANDBOX_DRIVER: "cloudflare",
      CLOUDFLARE_SANDBOX_WORKER_URL: "https://sandbox.example.com",
    })
    expect(deployment.requiredSecrets).toContain("CLAXEDO_CREDENTIALS_KEK")
    expect(deployment.requiredSecrets).toContain("CLOUDFLARE_SANDBOX_API_TOKEN")
    expect(() =>
      userCloudflareDeployment(
        { ...env, CLAXEDO_SANDBOX_POSTURE: "full-hosted", CLAXEDO_SANDBOX_DRIVER: "cloudflare" },
        { agentPlugins: false },
      ),
    ).toThrow(/--agent-plugins/)
  })

  test("renders every Worker variable, secrets excluded", async () => {
    const deployment = userCloudflareDeployment(env, { agentPlugins: true })
    const configurationId = await authConfigurationId(deployment)
    expect(configurationId).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(workerVariables(deployment, configurationId)).toEqual({
      CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
      CLAXEDO_PRODUCT_POSTURE: "user-deployed",
      CLAXEDO_SANDBOX_POSTURE: "control-plane-only",
      CLAXEDO_DEPLOYMENT_MODE: "hosted",
      CLAXEDO_DEPLOYMENT_ID: "claxedo",
      CLAXEDO_AUTH_METHODS: "github",
      CLAXEDO_AUTH_CONFIGURATION_ID: configurationId,
      BETTER_AUTH_URL: "https://api.example.com",
      CLAXEDO_APP_ORIGIN: "https://app.example.com",
      CLAXEDO_WORKSPACE_RELAY_URL: "https://relay.example.com",
      CLAXEDO_USER_DEPLOYED_ORGANIZATION_ID: "claxedo",
      CLAXEDO_USER_DEPLOYED_ORGANIZATION_NAME: "Acme",
      GITHUB_CLIENT_ID: "github-client",
      CLAXEDO_HOSTED_CREDENTIALS_ENABLED: "1",
      CLAXEDO_PUBLIC_URL: "https://api.example.com",
    })
  })

  test("reads the two secrets the deploy needs itself and refuses weak or reused ones", () => {
    const strong = "a".repeat(32)
    const other = "b".repeat(32)
    expect(deployReadSecrets({ BETTER_AUTH_SECRET: strong, CLAXEDO_AUTH_INTROSPECTION_SECRET: other })).toEqual({
      betterAuthSecret: strong,
      introspectionSecret: other,
    })
    expect(() => deployReadSecrets({ BETTER_AUTH_SECRET: "short", CLAXEDO_AUTH_INTROSPECTION_SECRET: other })).toThrow(
      /at least 32 characters/,
    )
    expect(() => deployReadSecrets({ BETTER_AUTH_SECRET: strong, CLAXEDO_AUTH_INTROSPECTION_SECRET: strong })).toThrow(
      /different secrets/,
    )
  })
})
