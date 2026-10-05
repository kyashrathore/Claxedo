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
  test("names the GitHub App the connection signs in with only when one is configured", () => {
    expect(workerVariables(userCloudflareDeployment(env, { agentPlugins: false }), "sha256:config")).not.toHaveProperty("CLAXEDO_INTEGRATION_GITHUB_CLIENT_ID")
    const deployment = userCloudflareDeployment({ ...env, CLAXEDO_INTEGRATION_GITHUB_CLIENT_ID: " Iv1.app " }, { agentPlugins: false })
    expect(workerVariables(deployment, "sha256:config").CLAXEDO_INTEGRATION_GITHUB_CLIENT_ID).toBe("Iv1.app")
    expect(deployment.requiredSecrets).not.toContain("CLAXEDO_INTEGRATION_GITHUB_CLIENT_SECRET")
  })

  test("product telemetry is sent only when the deploy turns it on, and then needs the PostHog key", () => {
    const off = userCloudflareDeployment({ ...env, CLAXEDO_POSTHOG_HOST: "https://eu.i.posthog.com" }, { agentPlugins: false })
    expect(workerVariables(off, "sha256:config")).not.toHaveProperty("CLAXEDO_TELEMETRY_MODE")
    expect(workerVariables(off, "sha256:config")).not.toHaveProperty("CLAXEDO_POSTHOG_HOST")
    expect(off.requiredSecrets).not.toContain("CLAXEDO_POSTHOG_KEY")

    const on = userCloudflareDeployment({ ...env, CLAXEDO_TELEMETRY_MODE: " ON ", CLAXEDO_POSTHOG_HOST: "https://eu.i.posthog.com" }, { agentPlugins: false })
    expect(workerVariables(on, "sha256:config")).toMatchObject({ CLAXEDO_TELEMETRY_MODE: "on", CLAXEDO_POSTHOG_HOST: "https://eu.i.posthog.com" })
    expect(on.requiredSecrets).toContain("CLAXEDO_POSTHOG_KEY")

    expect(() => userCloudflareDeployment({ ...env, CLAXEDO_TELEMETRY_MODE: "yes" }, { agentPlugins: false })).toThrow(/CLAXEDO_TELEMETRY_MODE/)
    expect(() => userCloudflareDeployment({ ...env, CLAXEDO_TELEMETRY_MODE: "on", CLAXEDO_POSTHOG_HOST: "http://ph.example.com" }, { agentPlugins: false })).toThrow(/CLAXEDO_POSTHOG_HOST/)
  })

  test("carries the email sender as a named deploy variable", () => {
    const deployment = userCloudflareDeployment({ ...env, CLAXEDO_EMAIL_FROM: "auth@example.com" }, { agentPlugins: false })
    expect(workerVariables(deployment, "sha256:config").CLAXEDO_EMAIL_FROM).toBe("auth@example.com")
    expect(() => userCloudflareDeployment({ ...env, CLAXEDO_EMAIL_FROM: "invalid" }, { agentPlugins: false })).toThrow(/CLAXEDO_EMAIL_FROM/)
    expect(workerVariables(userCloudflareDeployment(env, { agentPlugins: false }), "sha256:config").CLAXEDO_EMAIL_FROM).toBeUndefined()
  })

  test("deploys email-password only with the Cloudflare sender configured", () => {
    const deployment = userCloudflareDeployment({ ...env, CLAXEDO_AUTH_METHODS: "email-password", CLAXEDO_EMAIL_FROM: "auth@example.com" }, { agentPlugins: false })
    expect(deployment.authMethods).toEqual(["email-password"])
    expect(deployment.providerClientIds).toEqual({})
    expect(oauthCallbackUrls(deployment)).toEqual([])
    expect(deployment.requiredSecrets).not.toContain("GITHUB_CLIENT_SECRET")
    expect(workerVariables(deployment, "sha256:config").CLAXEDO_AUTH_METHODS).toBe("email-password")
  })

  test("a minimal environment deploys the plain Worker under plain default names", () => {
    const deployment = userCloudflareDeployment(env, { agentPlugins: false })
    expect(deployment).toMatchObject({
      workerName: "claxedo",
      appWorkerName: "claxedo-app",
      deploymentId: "claxedo",
      organization: { id: "claxedo", name: "Acme" },
      authMethods: ["github"],
      databases: { AUTH_DB: "claxedo-auth", CONTROL_PLANE_DB: "claxedo-control-plane" },
      documentsBucket: "claxedo-documents",
      requestLimiterNamespaceId: allocatedRequestLimiterNamespaceId("claxedo", "claxedo"),
    })
    expect(userCloudflareDeployment({ ...env, CLAXEDO_DOCUMENTS_BUCKET: "pages-staging" }, { agentPlugins: false }))
      .toMatchObject({ documentsBucket: "pages-staging" })
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
      CLAXEDO_SESSION_HOST_WORKER_NAME: "claxedo-user-deployed-session-host-staging",
      CLAXEDO_DEPLOYMENT_ID: "deployment-staging",
      CLAXEDO_AUTH_D1_DATABASE_NAME: "claxedo-auth-staging",
      CLAXEDO_CONTROL_PLANE_D1_DATABASE_NAME: "claxedo-control-plane-staging",
    })
    expect(target).toEqual({
      workerName: "claxedo-user-deployed-locked-staging",
      appWorkerName: "claxedo-user-deployed-app-staging",
      sessionHostWorkerName: "claxedo-user-deployed-session-host-staging",
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
      .toThrow(/CLAXEDO_EMAIL_FROM/)
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
    expect(deployment.requiredSecrets).toContain("CLOUDFLARE_SANDBOX_IDLE_STOP_TOKEN")
    expect(() =>
      userCloudflareDeployment(
        { ...env, CLAXEDO_SANDBOX_POSTURE: "full-hosted", CLAXEDO_SANDBOX_DRIVER: "cloudflare" },
        { agentPlugins: false },
      ),
    ).toThrow(/--agent-plugins/)
  })

  test("full-hosted on Boat names the runtime image it boots and needs the Boat API key", () => {
    const boat = { ...env, CLAXEDO_SANDBOX_POSTURE: "full-hosted", CLAXEDO_SANDBOX_DRIVER: "boat" }
    const image = "ghcr.io/kyashrathore/claxedo-sandbox:workspace-runtime-0-10-0-149c6f9a9d-agent-plugins-v8"
    const deployment = userCloudflareDeployment({ ...boat, CLAXEDO_SANDBOX_IMAGE: image }, { agentPlugins: true })
    expect(deployment.sandbox?.variables).toEqual({ CLAXEDO_SANDBOX_DRIVER: "boat", CLAXEDO_SANDBOX_IMAGE: image })
    expect(deployment.requiredSecrets).toContain("BOAT_API_KEY")
    expect(deployment.requiredSecrets).not.toContain("CLOUDFLARE_SANDBOX_API_TOKEN")
    expect(() => userCloudflareDeployment(boat, { agentPlugins: true })).toThrow(/CLAXEDO_SANDBOX_IMAGE is required/)
    const plain = "ghcr.io/kyashrathore/claxedo-sandbox:workspace-runtime-0-10-0-149c6f9a9d-v8"
    expect(() => userCloudflareDeployment({ ...boat, CLAXEDO_SANDBOX_IMAGE: plain }, { agentPlugins: true }))
      .toThrow(/is not an Agent Plugins build, and this deployment enables Agent Plugins/)
    expect(() => userCloudflareDeployment({ ...boat, CLAXEDO_SANDBOX_IMAGE: "--privileged" }, { agentPlugins: true }))
      .toThrow(/not a legal image identifier/)
    expect(() => userCloudflareDeployment({ ...boat, CLAXEDO_SANDBOX_DRIVER: "modal" }, { agentPlugins: true }))
      .toThrow(/"cloudflare" or "boat" or "fetch"/)
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
