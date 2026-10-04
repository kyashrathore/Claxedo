import { createHash } from "node:crypto"

import { assertSandboxImageReference } from "@claxedo/sandbox-manager/image-name"

import { resolveDeploymentProfileFromEnv, type SandboxDriver } from "../../src/deployments/hosted-shared/deployment-profile"
import {
  requireNonLegacyWorkerName,
  selectHostedWorkerArtifact,
  type CertifiedHostedWorkerArtifact,
} from "../../src/deployments/hosted-workerd/certified-worker-artifacts"
import {
  betterAuthDeploymentConfigurationId,
  resolveBetterAuthMethodSelection,
  type BetterAuthMethod,
} from "../../src/platform/auth/better-auth-configuration"

/** The Worker secret each full-hosted driver needs. */
const SANDBOX_DRIVER_SECRETS: Readonly<Record<SandboxDriver, readonly string[]>> = Object.freeze({
  cloudflare: ["CLOUDFLARE_SANDBOX_API_TOKEN", "CLOUDFLARE_SANDBOX_IDLE_STOP_TOKEN"],
  boat: ["BOAT_API_KEY"],
  fetch: [],
})

/** Secrets the deploy reads itself: it provisions the native OAuth clients with both. */
export const DEPLOY_READ_SECRETS = ["BETTER_AUTH_SECRET", "CLAXEDO_AUTH_INTROSPECTION_SECRET"] as const

export type D1DatabaseBinding = "AUTH_DB" | "CONTROL_PLANE_DB"

/** One deployment of the user-deployed Worker, derived from the environment the deploy command runs in. */
export type UserCloudflareDeployment = UserCloudflareTarget & Readonly<{
  relayUrl: string
  organization: Readonly<{ id: string; name: string }>
  authMethods: readonly BetterAuthMethod[]
  emailFrom?: string
  providerClientIds: Readonly<Record<string, string>>
  /** The GitHub App the GitHub connection's device sign-in runs on; absent, GitHub connects by pasted token. */
  integrationClientIds: Readonly<Record<string, string>>
  requestLimiterNamespaceId: string
  artifact: CertifiedHostedWorkerArtifact
  documentsBucket: string
  agentPluginsBucket?: string
  sandbox?: Readonly<{ driver: SandboxDriver; variables: Readonly<Record<string, string>> }>
  requiredSecrets: readonly string[]
  /** Uploaded when the environment carries them; a deploy without them still publishes. */
  optionalSecrets: readonly string[]
}>

function setting(env: NodeJS.ProcessEnv, name: string, fallback?: string) {
  const value = env[name]?.trim() || fallback
  if (!value) throw new Error(`${name} is required to deploy to Cloudflare`)
  return value
}

function exactHttpsOrigin(env: NodeJS.ProcessEnv, name: string) {
  const value = setting(env, name)
  const url = new URL(value)
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.port ||
    url.username ||
    url.password
  )
    throw new Error(`${name} must be an exact HTTPS origin such as https://api.example.com`)
  return url.origin
}

/**
 * Both Workers render `workers_dev = false` and are reached only through the
 * custom domain `wrangler deploy --domain` attaches, which must sit on a zone
 * in the same Cloudflare account.
 */
function customDomainOrigin(env: NodeJS.ProcessEnv, name: string) {
  const origin = exactHttpsOrigin(env, name)
  const hostname = new URL(origin).hostname
  if (hostname.endsWith(".workers.dev") || hostname.endsWith(".pages.dev")) {
    throw new Error(`${name} must be a custom domain on your Cloudflare zone, not ${hostname}`)
  }
  return origin
}

/** Deterministic per Worker, so a re-deploy keeps the limiter namespace the first deploy chose. */
export function allocatedRequestLimiterNamespaceId(deploymentId: string, workerName: string) {
  const digest = createHash("sha256").update(`claxedo:ratelimit:v1:${deploymentId}:${workerName}`).digest()
  return String(1_000_000_000 + (digest.readUInt32BE(0) % 3_000_000_000))
}

/** Where a deployment lives: the names and origins every deploy command addresses. */
export type UserCloudflareTarget = Readonly<{
  workerName: string
  appWorkerName: string
  sessionHostWorkerName: string
  deploymentId: string
  apiOrigin: string
  appOrigin: string
  databases: Readonly<Record<D1DatabaseBinding, string>>
}>

export function userCloudflareTarget(env: NodeJS.ProcessEnv): UserCloudflareTarget {
  const workerName = requireNonLegacyWorkerName(setting(env, "CLAXEDO_WORKER_NAME", "claxedo"))
  const appWorkerName = requireNonLegacyWorkerName(setting(env, "CLAXEDO_APP_WORKER_NAME", `${workerName}-app`))
  if (appWorkerName === workerName) throw new Error("the API and app Workers need different names")
  const apiOrigin = customDomainOrigin(env, "CLAXEDO_API_ORIGIN")
  const appOrigin = customDomainOrigin(env, "CLAXEDO_APP_ORIGIN")
  if (apiOrigin === appOrigin) throw new Error("CLAXEDO_API_ORIGIN and CLAXEDO_APP_ORIGIN must be different hosts")
  const databases = {
    AUTH_DB: setting(env, "CLAXEDO_AUTH_D1_DATABASE_NAME", `${workerName}-auth`),
    CONTROL_PLANE_DB: setting(env, "CLAXEDO_CONTROL_PLANE_D1_DATABASE_NAME", `${workerName}-control-plane`),
  }
  if (databases.AUTH_DB === databases.CONTROL_PLANE_DB) {
    throw new Error("the auth and control-plane D1 databases must be different databases")
  }
  return Object.freeze({
    workerName,
    appWorkerName,
    sessionHostWorkerName: requireNonLegacyWorkerName(setting(env, "CLAXEDO_SESSION_HOST_WORKER_NAME", `${workerName}-session-host`)),
    deploymentId: setting(env, "CLAXEDO_DEPLOYMENT_ID", workerName),
    apiOrigin,
    appOrigin,
    databases,
  })
}

export function userCloudflareDeployment(
  env: NodeJS.ProcessEnv,
  options: Readonly<{ agentPlugins: boolean }>,
): UserCloudflareDeployment {
  const profile = resolveDeploymentProfileFromEnv({
    CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
    CLAXEDO_PRODUCT_POSTURE: "user-deployed",
    CLAXEDO_SANDBOX_POSTURE: env.CLAXEDO_SANDBOX_POSTURE?.trim() || "control-plane-only",
    CLAXEDO_SANDBOX_DRIVER: env.CLAXEDO_SANDBOX_DRIVER,
  })
  const fullHosted = profile.sandboxPosture === "full-hosted"
  const artifact = selectHostedWorkerArtifact({ agentPlugins: options.agentPlugins, fullHosted })
  const target = userCloudflareTarget(env)

  const authMethods = resolveBetterAuthMethodSelection(setting(env, "CLAXEDO_AUTH_METHODS", "github"))
  const emailFrom = env.CLAXEDO_EMAIL_FROM?.trim()
  if (emailFrom && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailFrom)) {
    throw new Error("CLAXEDO_EMAIL_FROM must be an email address")
  }
  if (authMethods.includes("email-password") && !emailFrom) {
    throw new Error("email-password requires CLAXEDO_EMAIL_FROM and the Cloudflare Email Service binding")
  }
  const providerClientIds = Object.fromEntries(
    authMethods.filter((method) => method !== "email-password").map((method) => {
      const name = method === "google" ? "GOOGLE_CLIENT_ID" : "GITHUB_CLIENT_ID"
      return [name, setting(env, name)]
    }),
  )

  const githubAppClientId = env.CLAXEDO_INTEGRATION_GITHUB_CLIENT_ID?.trim()
  const integrationClientIds: Record<string, string> = githubAppClientId ? { CLAXEDO_INTEGRATION_GITHUB_CLIENT_ID: githubAppClientId } : {}

  const driver = profile.sandboxPosture === "full-hosted" ? profile.sandboxDriver : undefined
  const sandbox = driver
    ? {
        driver,
        variables: {
          CLAXEDO_SANDBOX_DRIVER: driver,
          ...(driver === "cloudflare"
            ? { CLOUDFLARE_SANDBOX_WORKER_URL: exactHttpsOrigin(env, "CLAXEDO_SANDBOX_WORKER_URL") }
            : {}),
          ...(driver === "boat" ? { CLAXEDO_SANDBOX_IMAGE: assertSandboxImageReference(setting(env, "CLAXEDO_SANDBOX_IMAGE")) } : {}),
          ...(driver === "fetch" ? { CLAXEDO_SANDBOX_DRIVER_URL: exactHttpsOrigin(env, "CLAXEDO_SANDBOX_DRIVER_URL") } : {}),
        },
      }
    : undefined

  return Object.freeze({
    ...target,
    relayUrl: exactHttpsOrigin(env, "CLAXEDO_WORKSPACE_RELAY_URL"),
    organization: {
      id: setting(env, "CLAXEDO_USER_DEPLOYED_ORGANIZATION_ID", target.deploymentId),
      name: setting(env, "CLAXEDO_USER_DEPLOYED_ORGANIZATION_NAME"),
    },
    authMethods,
    ...(emailFrom ? { emailFrom } : {}),
    providerClientIds,
    integrationClientIds,
    requestLimiterNamespaceId: allocatedRequestLimiterNamespaceId(target.deploymentId, target.workerName),
    artifact,
    documentsBucket: setting(env, "CLAXEDO_DOCUMENTS_BUCKET", `${target.workerName}-documents`),
    ...(artifact.agentPlugins
      ? { agentPluginsBucket: setting(env, "CLAXEDO_AGENT_PLUGINS_BUCKET", `${target.workerName}-agent-plugins`) }
      : {}),
    ...(sandbox ? { sandbox } : {}),
    requiredSecrets: [
      ...DEPLOY_READ_SECRETS,
      "CLAXEDO_RELAY_RESOLVER_TOKEN",
      "CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM",
      "CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM",
      "CLAXEDO_RELAY_HOST_VERIFY_PEM",
      ...authMethods.filter((method) => method !== "email-password").map((method) => (method === "google" ? "GOOGLE_CLIENT_SECRET" : "GITHUB_CLIENT_SECRET")),
      ...(artifact.agentPlugins ? ["CLAXEDO_CREDENTIALS_KEK"] : []),
      ...(driver ? SANDBOX_DRIVER_SECRETS[driver] : []),
    ],
    optionalSecrets: ["CLAXEDO_INTEGRATION_GITHUB_CLIENT_SECRET"],
  })
}

/** The secret values the deploy itself needs, checked before anything touches Cloudflare. */
export function deployReadSecrets(env: NodeJS.ProcessEnv) {
  const [betterAuthSecret, introspectionSecret] = DEPLOY_READ_SECRETS.map((name) => {
    const value = env[name]?.trim()
    if (!value || value.length < 32) throw new Error(`${name} must be set to a secret of at least 32 characters`)
    return value
  })
  if (betterAuthSecret === introspectionSecret) {
    throw new Error("BETTER_AUTH_SECRET and CLAXEDO_AUTH_INTROSPECTION_SECRET must be different secrets")
  }
  return { betterAuthSecret: betterAuthSecret, introspectionSecret: introspectionSecret }
}

export function authConfigurationId(deployment: UserCloudflareDeployment) {
  return betterAuthDeploymentConfigurationId({
    methods: [...deployment.authMethods],
    apiOrigin: deployment.apiOrigin,
    appOrigin: deployment.appOrigin,
    ...(deployment.providerClientIds.GITHUB_CLIENT_ID ? { githubClientId: deployment.providerClientIds.GITHUB_CLIENT_ID } : {}),
    ...(deployment.providerClientIds.GOOGLE_CLIENT_ID ? { googleClientId: deployment.providerClientIds.GOOGLE_CLIENT_ID } : {}),
  })
}

/** Every plain-text variable the Worker reads; secrets travel separately. */
export function workerVariables(deployment: UserCloudflareDeployment, configurationId: string): Record<string, string> {
  return {
    CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
    CLAXEDO_PRODUCT_POSTURE: "user-deployed",
    CLAXEDO_SANDBOX_POSTURE: deployment.artifact.sandboxPosture,
    CLAXEDO_DEPLOYMENT_MODE: "hosted",
    CLAXEDO_DEPLOYMENT_ID: deployment.deploymentId,
    CLAXEDO_AUTH_METHODS: deployment.authMethods.join(","),
    CLAXEDO_AUTH_CONFIGURATION_ID: configurationId,
    BETTER_AUTH_URL: deployment.apiOrigin,
    CLAXEDO_APP_ORIGIN: deployment.appOrigin,
    CLAXEDO_WORKSPACE_RELAY_URL: deployment.relayUrl,
    CLAXEDO_USER_DEPLOYED_ORGANIZATION_ID: deployment.organization.id,
    CLAXEDO_USER_DEPLOYED_ORGANIZATION_NAME: deployment.organization.name,
    ...(deployment.emailFrom ? { CLAXEDO_EMAIL_FROM: deployment.emailFrom } : {}),
    ...deployment.providerClientIds,
    ...deployment.integrationClientIds,
    ...deployment.sandbox?.variables,
    ...(deployment.artifact.agentPlugins
      ? { CLAXEDO_HOSTED_CREDENTIALS_ENABLED: "1", CLAXEDO_PUBLIC_URL: deployment.apiOrigin }
      : {}),
  }
}

/** The session-host Worker's variables: where its control plane authorizes sessions and where the relay publishes its host-token keys. */
export function sessionHostVariables(deployment: UserCloudflareDeployment): Record<string, string> {
  return {
    WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL: `${deployment.apiOrigin}/api/runtime-authority/session-authorize`,
    WORKSPACE_RUNTIME_RELAY_JWKS_URL: `${deployment.relayUrl}/.well-known/jwks.json`,
  }
}

export function oauthCallbackUrls(deployment: UserCloudflareDeployment) {
  return deployment.authMethods.filter((method) => method !== "email-password").map((method) => `${deployment.apiOrigin}/api/auth/callback/${method}`)
}
