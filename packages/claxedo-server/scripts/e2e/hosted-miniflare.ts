import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Miniflare } from "miniflare"
import { unstable_getMiniflareWorkerOptions } from "wrangler"
import { betterAuthDeploymentConfigurationId } from "../../src/platform/auth/better-auth-configuration"
import { betterAuthD1PreparationCommands } from "../deploy/prepare-better-auth-d1"
import { generateCanonicalOwnerClaim, ownerClaimMutationSql } from "../deploy/provision-user-deployed-owner-claim"
import { userDeployedOwnerBootstrapClaimHash, userDeployedOwnerIdentityHash } from "../../src/authority/adapters/d1/workspace-authority"

type Input = {
  config: string
  root: string
  port: number
  certificate: string
  key: string
  sandboxOrigin: string
  gitUrl: string
  relayUrl: string
  signingPrivateKey: string
  signingPublicKey: string
}

const serverRoot = path.resolve(import.meta.dirname, "../..")
const wrangler = path.join(serverRoot, "node_modules/.bin/wrangler")

function runWrangler(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, WRANGLER_SEND_METRICS: "false" }
  for (const name of ["CF_API_TOKEN", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL"]) delete env[name]
  const result = spawnSync(wrangler, args, { cwd: serverRoot, env, encoding: "utf8" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`wrangler ${args.join(" ")} failed: ${result.stdout}\n${result.stderr}`)
}

async function main(input: Input) {
  const bundleDir = path.join(input.root, "hosted-bundle")
  const persistence = path.join(input.root, "hosted-d1")
  runWrangler(["deploy", "--config", input.config, "--dry-run", "--outdir", bundleDir, "--tsconfig", path.join(serverRoot, "tsconfig.auth-d1.json")])
  for (const binding of ["AUTH_DB", "CONTROL_PLANE_DB"]) {
    runWrangler(["d1", "migrations", "apply", binding, "--local", "--persist-to", persistence, "--config", input.config])
  }
  const converted = unstable_getMiniflareWorkerOptions(input.config)
  if (!converted.main) throw new Error("certified config has no Worker main")
  const bundle = path.join(bundleDir, path.basename(converted.main).replace(/\.ts$/, ".js"))
  const apiOrigin = `https://127.0.0.1:${input.port}`
  const env: Record<string, string> = {
    CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
    CLAXEDO_PRODUCT_POSTURE: "user-deployed",
    CLAXEDO_SANDBOX_POSTURE: "full-hosted",
    CLAXEDO_SANDBOX_DRIVER: "cloudflare",
    CLOUDFLARE_SANDBOX_WORKER_URL: input.sandboxOrigin,
    CLOUDFLARE_SANDBOX_API_TOKEN: "hosted-sandbox-test-token",
    CLAXEDO_PRIVATE_REPO_HOSTS: new URL(input.gitUrl).hostname,
    CLAXEDO_DEPLOYMENT_MODE: "hosted",
    CLAXEDO_DEPLOYMENT_ID: "hosted-e2e-deployment",
    CLAXEDO_RELEASE_SEQUENCE: "1",
    CLAXEDO_RELEASE_ID: "hosted-e2e-release",
    CLAXEDO_WORKER_BUILD_ID: `sha256:${"1".repeat(64)}`,
    CLAXEDO_BROWSER_BUILD_ID: "browser-absent-v1",
    CLAXEDO_RELAY_BUILD_ID: "relay-absent-v1",
    CLAXEDO_CANDIDATE_STATE_REVISION: "0",
    CLAXEDO_CANDIDATE_OPERATION_ID: "initialize:hosted-e2e-release",
    CLAXEDO_REQUEST_LIMITER_NAMESPACE_ID: "1930000001",
    CLAXEDO_AUTH_METHODS: "github",
    BETTER_AUTH_URL: apiOrigin,
    CLAXEDO_APP_ORIGIN: apiOrigin,
    BETTER_AUTH_SECRET: "hosted-e2e-better-auth-secret-at-least-32-characters",
    CLAXEDO_AUTH_INTROSPECTION_SECRET: "hosted-e2e-introspection-secret-at-least-32-characters",
    CLAXEDO_RELEASE_OPERATOR_SECRET: "hosted-e2e-operator-secret-at-least-32-characters",
    GITHUB_CLIENT_ID: "hosted-e2e-github-client",
    GITHUB_CLIENT_SECRET: "hosted-e2e-github-secret",
    CLAXEDO_WORKSPACE_RELAY_URL: input.relayUrl,
    CLAXEDO_RELAY_RESOLVER_TOKEN: "hosted-e2e-relay-resolver-token",
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: input.signingPrivateKey,
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: input.signingPublicKey,
    CLAXEDO_RELAY_HOST_VERIFY_PEM: input.signingPublicKey,
    CLAXEDO_CREDENTIALS_KEK: Buffer.alloc(32, 7).toString("base64"),
    CLAXEDO_HOSTED_CREDENTIALS_ENABLED: "1",
    CLAXEDO_PUBLIC_URL: apiOrigin,
    CLAXEDO_AGENT_PLUGINS_MCP_GATEWAY_URL: "https://gateway.hosted-e2e.test/",
    CLAXEDO_MCP_OAUTH_CLIENTS: JSON.stringify({ "https://auth.hosted-e2e.test": { clientId: "hosted-e2e-mcp-client" } }),
    CLAXEDO_ENVIRONMENT_ID: "hosted-e2e-environment",
    CLAXEDO_USER_DEPLOYED_ORGANIZATION_ID: "hosted-e2e-organization",
    CLAXEDO_USER_DEPLOYED_ORGANIZATION_NAME: "Hosted E2E",
    CLAXEDO_CANARY_JOURNEY_ID: "hosted-e2e-journey",
    CLAXEDO_AUTH_DESCRIPTOR_EXPIRES_AT: String(Date.now() + 60 * 60 * 1000),
    CLAXEDO_RECOVERY_EPOCH: `paired-d1-v1:sha256:${"2".repeat(64)}`,
    CLAXEDO_DEV_DISABLE_RELEASE_GATES: "1",
  }
  env.CLAXEDO_AUTH_CONFIGURATION_ID = await betterAuthDeploymentConfigurationId({
    methods: ["github"], apiOrigin, appOrigin: apiOrigin, githubClientId: env.GITHUB_CLIENT_ID,
  })
  const mf = new Miniflare({
    ...converted.workerOptions,
    versionMetadata: undefined,
    bindings: {
      ...converted.workerOptions.bindings,
      ...env,
      CF_VERSION_METADATA: { id: "11111111-1111-4111-8111-111111111111", tag: "hosted-e2e-release" },
    },
    modules: [{ type: "ESModule", path: "worker.js", contents: readFileSync(bundle, "utf8") }],
    d1Persist: path.join(persistence, "v3", "d1"),
    durableObjectsPersist: path.join(input.root, "hosted-do"),
    r2Persist: path.join(input.root, "hosted-r2"),
    host: "127.0.0.1",
    port: input.port,
    https: true,
    httpsKey: readFileSync(input.key, "utf8"),
    httpsCert: readFileSync(input.certificate, "utf8"),
    outboundService: async (request: Request) => {
      const headers = new Headers(request.headers)
      headers.delete("host")
      headers.delete("content-length")
      headers.set("x-claxedo-e2e-target-url", request.url)
      return fetch(`${input.sandboxOrigin}/__outbound`, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
      })
    },
  })
  try {
    const auth = await mf.getD1Database("AUTH_DB")
    const control = await mf.getD1Database("CONTROL_PLANE_DB")
    for (const mode of ["register-candidate", "activate-candidate", "dev-open"] as const) {
      const commands = await betterAuthD1PreparationCommands({
        env: { ...env, CLAXEDO_PLATFORM_VERSION_ID: "11111111-1111-4111-8111-111111111111",
          CLAXEDO_BROWSER_BUILD_ID: "browser-absent-v1", CLAXEDO_RELAY_BUILD_ID: "relay-absent-v1",
          CLAXEDO_WRANGLER_CONFIG: input.config },
        staging: true,
        mode,
      })
      for (const command of commands) {
        if (command.args[1] === "migrations") continue
        const binding = command.args[2]
        const sql = command.args[command.args.indexOf("--command") + 1]
        const target = binding === "AUTH_DB" ? auth : control
        const result = await target.prepare(sql).all()
        if (command.verify && result.results.length === 0) throw new Error(`${mode} ${command.verify} returned no rows`)
      }
    }
    await mf.ready
    process.on("message", (message: unknown) => {
      if (!message || typeof message !== "object" || !("subject" in message) || typeof message.subject !== "string" ||
        !("id" in message) || typeof message.id !== "number") return
      const subject = message.subject
      void (async () => {
        try {
          const claim = generateCanonicalOwnerClaim()
          const identity = { adapter: "better-auth" as const, issuer: `${apiOrigin}/api/auth`, subject }
          const provisioning = {
            deploymentId: env.CLAXEDO_DEPLOYMENT_ID,
            identity,
            claimHash: await userDeployedOwnerBootstrapClaimHash(claim),
            identityHash: await userDeployedOwnerIdentityHash(identity),
            expiresAt: Date.now() + 5 * 60_000,
            createdAt: Date.now(),
          }
          await control.prepare(ownerClaimMutationSql(provisioning, "provision")).run()
          process.send?.({ id: message.id, claim })
        } catch (error) {
          process.send?.({ id: message.id, error: error instanceof Error ? error.message : String(error) })
        }
      })()
    })
    console.log("[hosted-miniflare] ready")
    process.once("SIGTERM", () => { void mf.dispose().then(() => process.exit(0)) })
  } catch (error) {
    await mf.dispose()
    throw error
  }
}

if (import.meta.main) {
  const raw = process.env.CLAXEDO_E2E_HOSTED_MINIFLARE
  if (!raw) throw new Error("missing hosted Miniflare configuration")
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== "object") throw new Error("hosted Miniflare configuration must be an object")
  const field = (name: string): unknown => Object.entries(parsed).find(([key]) => key === name)?.[1]
  const required = (name: string) => {
    const value = field(name)
    if (typeof value !== "string" || !value) throw new Error(`hosted Miniflare ${name} is required`)
    return value
  }
  const port = field("port")
  if (typeof port !== "number" || !Number.isInteger(port)) throw new Error("hosted Miniflare port is invalid")
  await main({
    config: required("config"),
    root: required("root"),
    port,
    certificate: required("certificate"),
    key: required("key"),
    sandboxOrigin: required("sandboxOrigin"),
    gitUrl: required("gitUrl"),
    relayUrl: required("relayUrl"),
    signingPrivateKey: required("signingPrivateKey"),
    signingPublicKey: required("signingPublicKey"),
  })
}
