import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { asRecord, stringField } from "@claxedo/server-core/platform/json/index"

import { BROWSER_BUILD_ATTESTATION, BROWSER_DIRECTORY, buildBrowserApp, publishBrowserApp } from "./browser-app"
import { d1RegionReport, ensureD1Database, prepareD1Databases } from "./d1-databases"
import { waitForProbe, type ProbeOptions } from "./release-probe"
import { stageWorkerControlPlaneMigrations } from "./staged-control-plane-migrations"
import {
  authConfigurationId,
  deployReadSecrets,
  oauthCallbackUrls,
  sessionHostVariables,
  userCloudflareDeployment,
  userCloudflareTarget,
  workerVariables,
  type UserCloudflareDeployment,
  type UserCloudflareTarget,
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

export const DEPLOY_COMPONENTS = ["control-plane", "app"] as const
export type DeployComponent = (typeof DEPLOY_COMPONENTS)[number]

export type DeployArguments = Readonly<{ dryRun: boolean; agentPlugins: boolean; components: readonly DeployComponent[] }>

const isComponent = (value: string): value is DeployComponent => (DEPLOY_COMPONENTS as readonly string[]).includes(value)

export function parseDeployArguments(argv: readonly string[]): DeployArguments {
  const components: DeployComponent[] = []
  for (const argument of argv) {
    if (argument === "--dry-run" || argument === "--agent-plugins") continue
    const component = argument.startsWith("--component=") ? argument.slice("--component=".length) : undefined
    if (component !== undefined && isComponent(component)) {
      components.push(component)
      continue
    }
    throw new Error(`unknown argument ${argument}; use --dry-run, --agent-plugins and --component=${DEPLOY_COMPONENTS.join("|")}`)
  }
  return { dryRun: argv.includes("--dry-run"), agentPlugins: argv.includes("--agent-plugins"), components: components.length > 0 ? components : [...DEPLOY_COMPONENTS] }
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

/** The version tag the deploy stamps on the control-plane Worker; `/health` reports it as `platformVersionTag`. */
export function versionTag(sha: string) {
  return `claxedo-${sha.slice(0, 12)}`
}

/** The app component's plan: the Workers the public origin is made of, which need no secret and no control-plane setting. */
export function appPlan(target: UserCloudflareTarget) {
  return [
    `Relay Worker        ${target.relayWorkerName} (already deployed; bound by the app Worker as RELAY)`,
    `App Worker          ${target.appWorkerName} (binds ${target.workerName} as CONTROL_PLANE and the relay as RELAY)`,
    `Public origin       ${target.appOrigin}  (custom domain ${new URL(target.appOrigin).hostname}: the app, /api and /relay)`,
  ].join("\n")
}

export function deployPlan(
  deployment: UserCloudflareDeployment,
  variables: Readonly<Record<string, string>>,
  provided: Readonly<Record<string, string>>,
) {
  return [
    `Worker              ${deployment.workerName} (${deployment.artifact.artifactId}; reached only through the app Worker)`,
    `Session host        ${deployment.sessionHostWorkerName} (SessionDO, bound by the relay as SESSION_HOST)`,
    appPlan(deployment),
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
    "       -> wrangler deploy the Worker with its secrets -> wrangler deploy the session-host Worker, which binds the Worker as CONTROL_PLANE",
  ].join("\n")
}

const APP_STEPS = [
  "Steps: build the app -> (a first publish: wrangler deploy the app Worker so the origin fronts the control plane)",
  "       -> write the control plane's bootstrap and auth descriptor into the shell, read through the origin",
  "       -> wrangler deploy the app Worker on the public origin",
  "       -> wait for the origin to serve this commit's control plane and the build it just published",
].join("\n")

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

/**
 * The public origin serves this commit's control plane and the browser build
 * just published. The control plane has no address of its own, so the app
 * Worker fronting it is the first place either can be read over HTTP.
 */
export async function verifyPublicOrigin(origin: string, expected: Readonly<{ versionTag: string; browserBuildId: string }>, options: ProbeOptions = {}) {
  await waitForProbe(
    `${origin}/health`,
    (response, body) => {
      if (!response.ok || stringField(asRecord(body), "platformVersionTag") !== expected.versionTag) {
        throw new Error(`/health does not report version ${expected.versionTag}`)
      }
    },
    options,
  )
  await waitForProbe(
    `${origin}/api/claxedo/mode`,
    (response, body) => {
      if (!response.ok || asRecord(body)?.signedAuth !== true) throw new Error("/api/claxedo/mode does not report signed auth")
    },
    options,
  )
  await waitForProbe(
    `${origin}/${BROWSER_BUILD_ATTESTATION}`,
    (response, body) => {
      if (!response.ok || stringField(asRecord(body), "browserBuildId") !== expected.browserBuildId) {
        throw new Error(`the app does not serve build ${expected.browserBuildId}`)
      }
    },
    options,
  )
}

/**
 * Whether the public origin already forwards `/api` to the control plane: the
 * shell's deployment block is read through it, and a deployment's first app
 * publish has no Worker on the origin yet, so that publish deploys once before
 * reading. A hosted bootstrap answers `serverKind: "hosted"`; the single-page
 * fallback, a refused name or an older Worker on the domain answers anything else.
 */
export async function originFrontsControlPlane(origin: string, fetcher: (url: string) => Promise<Response> = (url) => fetch(url, { signal: AbortSignal.timeout(15_000) })) {
  try {
    const response = await fetcher(`${origin}/api/claxedo/bootstrap`)
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("application/json")) return false
    const deployment = asRecord(asRecord(await response.json())?.deployment)
    return deployment?.serverKind === "hosted"
  } catch {
    return false
  }
}

type Publish = Readonly<{ deployment: UserCloudflareDeployment; temporary: string; sha: string; dryRun: boolean }>

async function publishControlPlane(input: Publish, variables: Readonly<Record<string, string>>, provided: Readonly<Record<string, string>>) {
  const { deployment, temporary } = input
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
        ...(deployment.workerPlacementRegion ? { placementRegion: deployment.workerPlacementRegion } : {}),
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
    ...(deployment.workerPlacementRegion ? { placementRegion: deployment.workerPlacementRegion } : {}),
    variables: sessionHostVariables(deployment),
  }))
  const sessionHostArgs = ["deploy", "--config", sessionHostConfig, "--tsconfig", SESSION_HOST_TSCONFIG]
  const { betterAuthSecret, introspectionSecret } = deployReadSecrets(process.env)

  if (input.dryRun) {
    await writeWorkerConfig(DRY_RUN_DATABASE_IDS)
    await runWrangler(
      ["deploy", ...configArgs, "--dry-run", "--outdir", path.join(temporary, "bundle"), "--tsconfig", tsconfig],
      { env: offlineEnvironment() },
    )
    await runWrangler([...sessionHostArgs, "--dry-run", "--outdir", path.join(temporary, "session-host-bundle")], { env: offlineEnvironment() })
    return
  }

  const auth = await ensureD1Database(deployment.databases.AUTH_DB, deployment.d1Location)
  const controlPlane = await ensureD1Database(deployment.databases.CONTROL_PLANE_DB, deployment.d1Location)
  await writeWorkerConfig({ AUTH_DB: auth.id, CONTROL_PLANE_DB: controlPlane.id })
  console.log(`✓ D1 databases ready (${auth.created || controlPlane.created ? "created" : "found"})`)
  for (const [name, database] of [[deployment.databases.AUTH_DB, auth], [deployment.databases.CONTROL_PLANE_DB, controlPlane]] as const) {
    console.log(`  ${d1RegionReport(name, database.region, deployment.d1Location)}`)
  }

  await prepareD1Databases({ configArgs, origin: deployment.appOrigin, betterAuthSecret, introspectionSecret })
  console.log("✓ Migrations applied and native OAuth clients provisioned")

  const missing = missingSecrets(deployment, provided, await secretsAlreadyOnWorker(deployment.workerName))
  if (missing.length > 0) throw new Error(`set these secrets in the environment and run again: ${missing.join(", ")}`)

  const secretsFile = path.join(temporary, "secrets.json")
  await writeFile(secretsFile, JSON.stringify(provided), { mode: 0o600 })
  const outputFile = path.join(temporary, "deploy-output.ndjson")
  await runWrangler(
    [
      "deploy",
      ...configArgs,
      "--keep-vars=false",
      "--secrets-file",
      secretsFile,
      "--tag",
      versionTag(input.sha),
      "--message",
      `Claxedo ${input.sha}`,
      "--tsconfig",
      tsconfig,
    ],
    { env: { ...process.env, WRANGLER_OUTPUT_FILE_PATH: outputFile } },
  )
  const versionId = deployedVersionId(await readFile(outputFile, "utf8"), deployment.workerName)
  console.log(`✓ Worker deployed: ${deployment.workerName} version ${versionId}, tag ${versionTag(input.sha)}`)

  await runWrangler([...sessionHostArgs, "--keep-vars=false"])
  console.log(`✓ Session host deployed: ${deployment.sessionHostWorkerName}`)
}

async function publishApp(target: UserCloudflareTarget, input: Omit<Publish, "deployment">) {
  const { temporary } = input
  const appConfig = path.join(temporary, "app-wrangler.toml")
  const render = (browserDirectory: string) =>
    writeFile(appConfig, renderAppWranglerConfig({
      appWorkerName: target.appWorkerName,
      controlPlaneWorkerName: target.workerName,
      relayWorkerName: target.relayWorkerName,
      browserDirectory,
    }))

  if (input.dryRun) {
    const placeholder = path.join(temporary, "app-placeholder")
    await mkdir(placeholder, { recursive: true })
    await writeFile(path.join(placeholder, "index.html"), "<!doctype html>\n")
    await render(placeholder)
    await runWrangler(["deploy", "--config", appConfig, "--dry-run", "--outdir", path.join(temporary, "app-bundle")], { env: offlineEnvironment() })
    return
  }

  await buildBrowserApp()
  await render(BROWSER_DIRECTORY)
  const deploy = () => runWrangler(["deploy", "--config", appConfig, "--domain", new URL(target.appOrigin).hostname])
  if (!(await originFrontsControlPlane(target.appOrigin))) {
    await deploy()
    console.log(`✓ ${target.appOrigin} fronts the control plane for the first time; the shell is published next`)
  }
  const browserBuildId = await publishBrowserApp(target.appOrigin)
  console.log(`✓ App shell carries ${target.appOrigin}'s bootstrap and auth descriptor`)
  await deploy()
  await verifyPublicOrigin(target.appOrigin, { versionTag: versionTag(input.sha), browserBuildId })
  console.log(`✓ ${target.appOrigin} serves the app build ${browserBuildId} and the control plane ${versionTag(input.sha)}`)
}

async function main() {
  const args = parseDeployArguments(process.argv.slice(2))
  const controlPlane = args.components.includes("control-plane")
  const app = args.components.includes("app")
  const target = userCloudflareTarget(process.env)
  const deployment = controlPlane ? userCloudflareDeployment(process.env, { agentPlugins: args.agentPlugins }) : undefined
  const variables = deployment ? workerVariables(deployment, await authConfigurationId(deployment)) : {}
  const provided = deployment ? providedSecrets(deployment, process.env) : {}
  console.log(`Components          ${args.components.join(", ")}`)
  console.log(deployment ? deployPlan(deployment, variables, provided) : appPlan(target))
  if (app) console.log(`${deployment ? "\n" : ""}${APP_STEPS}`)

  const temporary = await mkdtemp(path.join(SERVER_ROOT, ".claxedo-cloudflare-deploy-"))
  try {
    const publish = { temporary, sha: commitSha(process.env), dryRun: args.dryRun }
    if (deployment) await publishControlPlane({ deployment, ...publish }, variables, provided)
    if (app) await publishApp(target, publish)
    if (args.dryRun) {
      console.log(`\nDry run: the ${args.components.join(" and ")} Workers bundle; nothing was sent to Cloudflare.`)
      return
    }
    if (app) {
      console.log(
        [
          "",
          `Sign in at ${target.appOrigin}, then make that account the owner:`,
          "  bun run deploy:user-cloudflare:claim-owner -- --email <the email you signed in with>",
        ].join("\n"),
      )
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) await main()
