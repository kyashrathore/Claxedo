import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { asRecord, stringField } from "@claxedo/server-core/platform/json/index"

import { BROWSER_BUILD_ATTESTATION, BROWSER_DIRECTORY, buildBrowserApp } from "./browser-app"
import { ensureD1Database, prepareD1Databases } from "./d1-databases"
import { waitForProbe, type ProbeOptions } from "./release-probe"
import { stageWorkerControlPlaneMigrations } from "./staged-control-plane-migrations"
import {
  authConfigurationId,
  deployReadSecrets,
  oauthCallbackUrls,
  sessionHostVariables,
  userCloudflareDeployment,
  workerVariables,
  type UserCloudflareDeployment,
} from "./user-cloudflare-config"
import {
  SERVER_ROOT,
  deployedVersionId,
  isAbsentWorkerFailure,
  probeWrangler,
  runWrangler,
} from "./wrangler-cli"
import { renderAppWranglerConfig, renderSessionHostWranglerConfig, renderWorkerWranglerConfig } from "./wrangler-config"

/**
 * `wrangler deploy --dry-run` bundles offline and never resolves a resource,
 * so the plan bundles against obviously-fake database IDs instead of asking
 * Cloudflare for the real ones.
 */
const SESSION_HOST_TSCONFIG = path.resolve(SERVER_ROOT, "../session-host/tsconfig.json")

const DRY_RUN_DATABASE_IDS = Object.freeze({
  AUTH_DB: "00000000-0000-4000-8000-00000000a001",
  CONTROL_PLANE_DB: "00000000-0000-4000-8000-00000000c001",
})

export type DeployArguments = Readonly<{ dryRun: boolean; agentPlugins: boolean }>

export function parseDeployArguments(argv: readonly string[]): DeployArguments {
  const known = new Set(["--dry-run", "--agent-plugins"])
  const unknown = argv.filter((argument) => !known.has(argument))
  if (unknown.length > 0) throw new Error(`unknown argument ${unknown.join(" ")}; use --dry-run and --agent-plugins`)
  return { dryRun: argv.includes("--dry-run"), agentPlugins: argv.includes("--agent-plugins") }
}

/** The secrets the command uploads with the Worker: every required or optional secret the environment carries. */
export function providedSecrets(deployment: UserCloudflareDeployment, env: NodeJS.ProcessEnv) {
  return Object.fromEntries(
    [...deployment.requiredSecrets, ...deployment.optionalSecrets].flatMap((name) => {
      const value = env[name]?.trim()
      return value ? [[name, value] as const] : []
    }),
  )
}

/** Required secrets neither provided now nor already on the Worker; the deploy refuses before publishing if any remain. */
export function missingSecrets(
  deployment: UserCloudflareDeployment,
  provided: Readonly<Record<string, string>>,
  onWorker: readonly string[],
) {
  return deployment.requiredSecrets.filter((name) => !(name in provided) && !onWorker.includes(name))
}

export function workerSecretNames(secretListOutput: string) {
  const parsed: unknown = JSON.parse(secretListOutput)
  if (!Array.isArray(parsed)) throw new Error("wrangler secret list did not return an array")
  return parsed.flatMap((entry) => {
    const name = stringField(asRecord(entry), "name")
    return name ? [name] : []
  })
}

export function deployPlan(
  deployment: UserCloudflareDeployment,
  variables: Readonly<Record<string, string>>,
  provided: Readonly<Record<string, string>>,
) {
  const host = (origin: string) => new URL(origin).hostname
  return [
    `Worker              ${deployment.workerName} (${deployment.artifact.artifactId})`,
    `API                 ${deployment.apiOrigin}  (custom domain ${host(deployment.apiOrigin)})`,
    `App Worker          ${deployment.appWorkerName}`,
    `Session host        ${deployment.sessionHostWorkerName} (SessionDO, bound by the relay as SESSION_HOST)`,
    `App                 ${deployment.appOrigin}  (custom domain ${host(deployment.appOrigin)})`,
    `D1 databases        AUTH_DB=${deployment.databases.AUTH_DB}  CONTROL_PLANE_DB=${deployment.databases.CONTROL_PLANE_DB}  (created if missing)`,
    `R2 bucket           ${deployment.documentsBucket}  (Pages)`,
    ...(deployment.agentPluginsBucket ? [`R2 bucket           ${deployment.agentPluginsBucket}  (Agent Plugins)`] : []),
    `Organization        ${deployment.organization.name} (${deployment.organization.id})`,
    `OAuth callbacks     ${oauthCallbackUrls(deployment).join("  ")}`,
    `Secrets uploaded    ${Object.keys(provided).join(", ") || "none"}`,
    `Secrets kept        ${deployment.requiredSecrets.filter((name) => !(name in provided)).join(", ") || "none"} (must already be on the Worker)`,
    "Variables",
    ...Object.entries(variables)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `  ${name} = ${value}`),
    "",
    "Steps: find or create both D1 databases -> apply their migrations -> provision the native OAuth clients",
    "       -> build the app -> wrangler deploy the Worker with its secrets -> wait for /health to name the new version",
    "       -> wrangler deploy the session-host Worker, which binds the Worker as CONTROL_PLANE",
    "       -> wrangler deploy the app assets -> wait for the app to serve the new build",
  ].join("\n")
}

function commitSha(env: NodeJS.ProcessEnv) {
  const supplied = env.GITHUB_SHA?.trim()
  if (supplied) return supplied
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: SERVER_ROOT, encoding: "utf8" })
  const sha = result.stdout?.trim()
  if (result.status !== 0 || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("deploy from a git checkout of Claxedo")
  return sha
}

/** A Wrangler environment that cannot reach Cloudflare, so a dry run proves it never needed to. */
function offlineEnvironment() {
  const env: NodeJS.ProcessEnv = { ...process.env, WRANGLER_SEND_METRICS: "false" }
  for (const name of ["CF_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_EMAIL"]) {
    delete env[name]
  }
  return env
}

async function secretsAlreadyOnWorker(workerName: string) {
  const result = await probeWrangler(["secret", "list", "--name", workerName, "--format", "json"])
  if (result.code === 0) return workerSecretNames(result.stdout)
  if (isAbsentWorkerFailure(result.stderr)) return []
  process.stderr.write(result.stderr)
  throw new Error(`could not list the secrets of ${workerName}`)
}

export async function verifyDeployedVersion(apiOrigin: string, versionId: string, options: ProbeOptions = {}) {
  await waitForProbe(
    `${apiOrigin}/health`,
    (response, body) => {
      if (!response.ok || stringField(asRecord(body), "platformVersionId") !== versionId) {
        throw new Error(`/health does not report version ${versionId}`)
      }
    },
    options,
  )
  await waitForProbe(
    `${apiOrigin}/api/claxedo/mode`,
    (response, body) => {
      if (!response.ok || asRecord(body)?.signedAuth !== true) throw new Error("/api/claxedo/mode does not report signed auth")
    },
    options,
  )
}

export async function verifyServedBrowserBuild(appOrigin: string, browserBuildId: string, options: ProbeOptions = {}) {
  await waitForProbe(
    `${appOrigin}/${BROWSER_BUILD_ATTESTATION}`,
    (response, body) => {
      if (!response.ok || stringField(asRecord(body), "browserBuildId") !== browserBuildId) {
        throw new Error(`the app does not serve build ${browserBuildId}`)
      }
    },
    options,
  )
}

async function main() {
  const args = parseDeployArguments(process.argv.slice(2))
  const deployment = userCloudflareDeployment(process.env, { agentPlugins: args.agentPlugins })
  const { betterAuthSecret, introspectionSecret } = deployReadSecrets(process.env)
  const variables = workerVariables(deployment, await authConfigurationId(deployment))
  const provided = providedSecrets(deployment, process.env)
  console.log(deployPlan(deployment, variables, provided))

  const temporary = await mkdtemp(path.join(SERVER_ROOT, ".claxedo-cloudflare-deploy-"))
  try {
    const staged = stageWorkerControlPlaneMigrations({ configDirectory: temporary })
    const workerConfig = path.join(temporary, "wrangler.toml")
    const writeWorkerConfig = (ids: Readonly<Record<"AUTH_DB" | "CONTROL_PLANE_DB", string>>) =>
      writeFile(
        workerConfig,
        renderWorkerWranglerConfig({
          workerName: deployment.workerName,
          artifact: deployment.artifact,
          configDirectory: temporary,
          authDatabase: { name: deployment.databases.AUTH_DB, id: ids.AUTH_DB },
          controlPlaneDatabase: { name: deployment.databases.CONTROL_PLANE_DB, id: ids.CONTROL_PLANE_DB },
          controlPlaneMigrationsDir: staged.migrationsDir,
          requestLimiterNamespaceId: deployment.requestLimiterNamespaceId,
          documentsBucket: deployment.documentsBucket,
          ...(deployment.agentPluginsBucket ? { agentPluginsBucket: deployment.agentPluginsBucket } : {}),
          variables,
        }),
      )
    const configArgs = ["--config", workerConfig]
    const tsconfig = path.join(SERVER_ROOT, "tsconfig.auth-d1.json")
    const sessionHostConfig = path.join(temporary, "session-host-wrangler.toml")
    await writeFile(sessionHostConfig, renderSessionHostWranglerConfig({
      workerName: deployment.sessionHostWorkerName,
      controlPlaneWorkerName: deployment.workerName,
      configDirectory: temporary,
      variables: sessionHostVariables(deployment),
    }))
    const sessionHostArgs = ["deploy", "--config", sessionHostConfig, "--tsconfig", SESSION_HOST_TSCONFIG]

    if (args.dryRun) {
      await writeWorkerConfig(DRY_RUN_DATABASE_IDS)
      await runWrangler(
        ["deploy", ...configArgs, "--dry-run", "--outdir", path.join(temporary, "bundle"), "--tsconfig", tsconfig],
        { env: offlineEnvironment() },
      )
      await runWrangler([...sessionHostArgs, "--dry-run", "--outdir", path.join(temporary, "session-host-bundle")], { env: offlineEnvironment() })
      console.log(`\nDry run: the ${deployment.artifact.artifactId} and session-host Workers bundle; nothing was sent to Cloudflare.`)
      return
    }

    const auth = await ensureD1Database(deployment.databases.AUTH_DB)
    const controlPlane = await ensureD1Database(deployment.databases.CONTROL_PLANE_DB)
    await writeWorkerConfig({ AUTH_DB: auth.id, CONTROL_PLANE_DB: controlPlane.id })
    console.log(`✓ D1 databases ready (${auth.created || controlPlane.created ? "created" : "found"})`)

    await prepareD1Databases({ configArgs, apiOrigin: deployment.apiOrigin, betterAuthSecret, introspectionSecret })
    console.log("✓ Migrations applied and native OAuth clients provisioned")

    const missing = missingSecrets(deployment, provided, await secretsAlreadyOnWorker(deployment.workerName))
    if (missing.length > 0) throw new Error(`set these secrets in the environment and run again: ${missing.join(", ")}`)

    const browserBuildId = await buildBrowserApp(deployment.apiOrigin, deployment.relayUrl)

    const secretsFile = path.join(temporary, "secrets.json")
    await writeFile(secretsFile, JSON.stringify(provided), { mode: 0o600 })
    const outputFile = path.join(temporary, "deploy-output.ndjson")
    const sha = commitSha(process.env)
    await runWrangler(
      [
        "deploy",
        ...configArgs,
        "--domain",
        new URL(deployment.apiOrigin).hostname,
        "--keep-vars=false",
        "--secrets-file",
        secretsFile,
        "--tag",
        `claxedo-${sha.slice(0, 12)}`,
        "--message",
        `Claxedo ${sha}`,
        "--tsconfig",
        tsconfig,
      ],
      { env: { ...process.env, WRANGLER_OUTPUT_FILE_PATH: outputFile } },
    )
    const versionId = deployedVersionId(await readFile(outputFile, "utf8"), deployment.workerName)
    await verifyDeployedVersion(deployment.apiOrigin, versionId)
    console.log(`✓ Worker deployed: ${deployment.apiOrigin} serves version ${versionId}`)

    await runWrangler([...sessionHostArgs, "--keep-vars=false"])
    console.log(`✓ Session host deployed: ${deployment.sessionHostWorkerName}`)

    const appConfig = path.join(temporary, "app-wrangler.toml")
    await writeFile(appConfig, renderAppWranglerConfig({ appWorkerName: deployment.appWorkerName, browserDirectory: BROWSER_DIRECTORY }))
    await runWrangler(["deploy", "--config", appConfig, "--domain", new URL(deployment.appOrigin).hostname])
    await verifyServedBrowserBuild(deployment.appOrigin, browserBuildId)
    console.log(`✓ App published: ${deployment.appOrigin}`)

    console.log(
      [
        "",
        `Sign in at ${deployment.appOrigin}, then make that account the owner:`,
        "  bun run deploy:user-cloudflare:claim-owner -- --email <the email you signed in with>",
      ].join("\n"),
    )
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) await main()
