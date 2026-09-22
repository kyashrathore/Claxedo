import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { asRecord, numberField, parseJson, stringField } from "@claxedo/server-core/platform/json/index"

import { resolveDeploymentProfileFromEnv } from "../../src/deployments/hosted-shared/deployment-profile"
import { d1Row } from "./d1-json"
import {
  allocatedRequestLimiterNamespaceId,
  betterAuthD1EnvironmentValue,
  betterAuthD1WorkerName,
  parseDeploymentStatus,
  renderBetterAuthD1WranglerConfig,
  type WorkerDeploymentStatus,
} from "./release-better-auth-d1"
import { stageWorkerControlPlaneMigrations } from "./staged-control-plane-migrations"

const serverRoot = path.resolve(import.meta.dirname, "../..")
const ENVIRONMENT = "staging" as const

/**
 * Lifetime of `CLAXEDO_AUTH_DESCRIPTOR_EXPIRES_AT`, which the candidate Worker
 * re-checks on every request: once it passes, composition throws and every
 * `/api/claxedo/*` route answers 503 `deployment_candidate_unavailable` while
 * `/health` still reports the release open. Staging release 84 was minted with
 * a two-day window on 2026-09-05 and the deployment died on 2026-09-07.
 */
const AUTH_DESCRIPTOR_TTL_MS = 90 * 24 * 60 * 60 * 1000

export type StagingLedgerState = Readonly<{
  activeStateRevision: number
  activeReleaseId: string
  activePhase: string
  activePhaseRevision: number
  activeReleaseSequence: number
  maxStateRevision: number
  /** The active release's own identity, enough to finish opening it. */
  activeIdentity: Readonly<Record<string, string>>
}>

export type StagingReleasePredecessor = Readonly<{
  previousReleaseId: string
  previousStateRevision: number
  previousPhase: string
  previousPhaseRevision: number
  releaseSequence: number
}>

export function stagingLedgerSql(deploymentId: string) {
  const id = `'${deploymentId.replaceAll("'", "''")}'`
  return `select
  "active"."stateRevision" as "activeStateRevision",
  "state"."releaseId" as "activeReleaseId",
  "state"."phase" as "activePhase",
  "state"."phaseRevision" as "activePhaseRevision",
  "release"."releaseSequence" as "activeReleaseSequence",
  "release"."workerBuildId" as "activeWorkerBuildId",
  "release"."platformVersionId" as "activePlatformVersionId",
  "release"."browserBuildId" as "activeBrowserBuildId",
  "release"."relayBuildId" as "activeRelayBuildId",
  "release"."authConfigurationId" as "activeAuthConfigurationId",
  "release"."requestLimiterNamespaceId" as "activeRequestLimiterNamespaceId",
  (select max("stateRevision") from "deploymentReleaseStateHistory"
    where "deploymentId" = ${id}) as "maxStateRevision"
from "deploymentReleaseActive" as "active"
join "deploymentReleaseStateHistory" as "state"
  on "state"."deploymentId" = "active"."deploymentId" and "state"."stateRevision" = "active"."stateRevision"
join "deploymentRelease" as "release"
  on "release"."deploymentId" = "state"."deploymentId" and "release"."releaseId" = "state"."releaseId"
where "active"."singleton" = 1 and "active"."deploymentId" = ${id};`
}

export function parseStagingLedgerState(output: string): StagingLedgerState {
  const row = d1Row(output, "staging release ledger")
  const activeStateRevision = numberField(row, "activeStateRevision")
  const activeReleaseId = stringField(row, "activeReleaseId")
  const activePhase = stringField(row, "activePhase")
  const activePhaseRevision = numberField(row, "activePhaseRevision")
  const activeReleaseSequence = numberField(row, "activeReleaseSequence")
  const maxStateRevision = numberField(row, "maxStateRevision")
  if (
    activeStateRevision === undefined ||
    activeReleaseId === undefined ||
    activePhase === undefined ||
    activePhaseRevision === undefined ||
    activeReleaseSequence === undefined ||
    maxStateRevision === undefined
  ) {
    throw new Error("staging release ledger row is missing an active release column")
  }
  if (
    !Number.isSafeInteger(activeStateRevision) ||
    !Number.isSafeInteger(activePhaseRevision) ||
    !Number.isSafeInteger(maxStateRevision) ||
    !Number.isSafeInteger(activeReleaseSequence) ||
    activeReleaseSequence <= 0
  ) {
    throw new Error("staging release ledger row carries a non-integer revision or sequence")
  }
  const identityColumns = {
    CLAXEDO_WORKER_BUILD_ID: "activeWorkerBuildId",
    CLAXEDO_PLATFORM_VERSION_ID: "activePlatformVersionId",
    CLAXEDO_BROWSER_BUILD_ID: "activeBrowserBuildId",
    CLAXEDO_RELAY_BUILD_ID: "activeRelayBuildId",
    CLAXEDO_AUTH_CONFIGURATION_ID: "activeAuthConfigurationId",
    CLAXEDO_REQUEST_LIMITER_NAMESPACE_ID: "activeRequestLimiterNamespaceId",
  } as const
  const activeIdentity: Record<string, string> = {}
  for (const [name, column] of Object.entries(identityColumns)) {
    const value = stringField(row, column)
    if (value === undefined) throw new Error(`staging release ledger row is missing ${column}`)
    activeIdentity[name] = value
  }
  return Object.freeze({
    activeStateRevision,
    activeReleaseId,
    activePhase,
    activePhaseRevision,
    activeReleaseSequence,
    maxStateRevision,
    activeIdentity: Object.freeze(activeIdentity),
  })
}

export function stagingReleasePredecessor(state: StagingLedgerState): StagingReleasePredecessor {
  if (state.maxStateRevision > state.activeStateRevision) {
    throw new Error(
      `the ledger holds revision ${state.maxStateRevision} above the active ${state.activeStateRevision}: a candidate was registered and never activated. ` +
        "Roll it back before releasing: bun run scripts/deploy/prepare-better-auth-d1.ts --rollback-candidate --staging " +
        "with the stranded release's identity from .artifacts/deployments/staging-<releaseId>.json, the same CLAXEDO_PREVIOUS_* it used, and CLAXEDO_ROLLBACK_OPERATION_ID",
    )
  }
  if (state.activePhase !== "open") {
    throw new Error(
      `the active release ${state.activeReleaseId} is in phase ${state.activePhase}, not open. ` +
        "A locked active row means the previous release never dev-opened: finish it with " +
        "bun run scripts/deploy/prepare-better-auth-d1.ts --dev-open --staging before releasing again",
    )
  }
  return Object.freeze({
    previousReleaseId: state.activeReleaseId,
    previousStateRevision: state.activeStateRevision,
    previousPhase: state.activePhase,
    previousPhaseRevision: state.activePhaseRevision,
    releaseSequence: state.activeReleaseSequence + 1,
  })
}

export function stagingReleaseIdentity(input: { now: Date; commitSha: string }) {
  if (!/^[0-9a-f]{40}$/i.test(input.commitSha)) throw new Error("staging release requires a full git commit SHA")
  const pad = (value: number, width = 2) => String(value).padStart(width, "0")
  const now = input.now
  const stamp = `${pad(now.getUTCFullYear() % 100)}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  const releaseId = `release-staging-${stamp}-${input.commitSha.slice(0, 8).toLowerCase()}`
  return Object.freeze({
    releaseId,
    operationId: `operation-${releaseId}`,
    canaryJourneyId: `journey-${releaseId}`,
    authDescriptorExpiresAt: String(now.getTime() + AUTH_DESCRIPTOR_TTL_MS),
  })
}

export function requireConsolidatedDeployment(status: WorkerDeploymentStatus, workerName: string) {
  if (status.versions.length === 1) return status.versions[0].version_id
  const incumbent = status.versions.find((version) => version.percentage === 100)
  const recovery = incumbent
    ? `wrangler versions deploy '${incumbent.version_id}@100%' --name ${workerName} --yes`
    : `wrangler versions list --name ${workerName} --json`
  throw new Error(
    `${workerName} is deployed as a ${status.versions.length}-version split, which the release refuses at ensureCutoverLiveSyncLifecycle. Consolidate first: ${recovery}`,
  )
}

const RELEASE_RUNTIME = /^(node|bun)(\.exe)?$/
const RELEASE_SCRIPT = /(^|\/)(release-better-auth-d1|prepare-better-auth-d1|staging-release)\.ts$/

/**
 * Only a process whose own argv runs one of the release scripts counts. The
 * shell that launched this one carries the whole command line as a single
 * argument, so a substring match over `ps` output reports the caller as its own
 * competitor.
 */
export function concurrentReleaseProcesses(psOutput: string, selfPid: number) {
  return psOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const match = /^(\d+)\s+(.*)$/.exec(line)
      if (!match) return []
      const pid = Number(match[1])
      const args = match[2].split(/\s+/)
      const runtime = args[0]?.split("/").pop() ?? ""
      if (pid === selfPid || !RELEASE_RUNTIME.test(runtime)) return []
      if (!args.some((argument) => RELEASE_SCRIPT.test(argument))) return []
      return [`${pid} ${match[2]}`]
    })
}

async function capture(executable: string, args: string[]) {
  const child = spawn(executable, args, { cwd: serverRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk
  })
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk
  })
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve))
  if (code !== 0) throw new Error(`${path.basename(executable)} ${args.slice(0, 3).join(" ")} failed: ${stderr.trim()}`)
  return stdout
}

async function inherit(executable: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(executable, args, { cwd: serverRoot, env, stdio: ["ignore", "inherit", "inherit"] })
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve))
  if (code !== 0) throw new Error(`${path.basename(executable)} ${args.slice(0, 3).join(" ")} exited with ${code}`)
}

const wranglerExecutable = path.join(
  serverRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "wrangler.cmd" : "wrangler",
)

async function resolveCommitSha(env: NodeJS.ProcessEnv) {
  const supplied = env.GITHUB_SHA?.trim()
  if (supplied) return supplied
  return (await capture("git", ["rev-parse", "HEAD"])).trim()
}

/**
 * The ledger write and the Worker's read of it are separate round trips, so a
 * probe issued the instant `--dev-open` returns can still see the previous
 * phase. Retry until the deployment reports the release this run published.
 */
export async function verifyOpenRelease(
  input: Readonly<{
    apiOrigin: string
    releaseId: string
    platformVersionId: string
    attempts?: number
    intervalMs?: number
    fetcher?: (url: string) => Promise<Response>
    wait?: (milliseconds: number) => Promise<void>
  }>,
) {
  const fetcher = input.fetcher ?? ((url: string) => fetch(url, { signal: AbortSignal.timeout(15_000) }))
  const wait = input.wait ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const attempts = input.attempts ?? 20
  let failure = new Error(`${input.apiOrigin} was not probed`)
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const health = asRecord(parseJson(await (await fetcher(`${input.apiOrigin}/health`)).text()))
      const release = asRecord(health?.release)
      if (
        stringField(health, "status") !== "open" ||
        stringField(release, "releaseId") !== input.releaseId ||
        stringField(health, "platformVersionId") !== input.platformVersionId
      ) {
        throw new Error(`/health does not report ${input.releaseId} open on ${input.platformVersionId}`)
      }
      const mode = asRecord(parseJson(await (await fetcher(`${input.apiOrigin}/api/claxedo/mode`)).text()))
      if (mode?.signedAuth !== true) throw new Error("/api/claxedo/mode did not report signedAuth")
      return { stateRevision: numberField(release, "stateRevision") }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
    }
    if (attempt < attempts) await wait(input.intervalMs ?? 3_000)
  }
  throw failure
}

async function main() {
  if (!process.argv.includes("--staging")) {
    throw new Error("staging-release releases the staging environment only; pass --staging to name it")
  }
  const dryRun = process.argv.includes("--dry-run")
  const profile = resolveDeploymentProfileFromEnv(process.env)
  if (profile.adapterProfile !== "better-auth-d1" || profile.productPosture !== "user-deployed") {
    throw new Error("the staging release publishes the user-deployed Better Auth D1 control plane")
  }
  const workerName = betterAuthD1WorkerName(ENVIRONMENT)
  const deploymentId = betterAuthD1EnvironmentValue(process.env, ENVIRONMENT, "DEPLOYMENT_ID")
  const apiOrigin = betterAuthD1EnvironmentValue(process.env, ENVIRONMENT, "API_ORIGIN")
  const identity = stagingReleaseIdentity({ now: new Date(), commitSha: await resolveCommitSha(process.env) })

  const temporary = await mkdtemp(path.join(serverRoot, ".claxedo-staging-release-"))
  try {
    const config = path.join(temporary, "wrangler.toml")
    const staged = stageWorkerControlPlaneMigrations({ configDirectory: temporary })
    await writeFile(
      config,
      renderBetterAuthD1WranglerConfig({
        staging: true,
        authDatabaseId: betterAuthD1EnvironmentValue(process.env, ENVIRONMENT, "AUTH_D1_DATABASE_ID"),
        authDatabaseName: betterAuthD1EnvironmentValue(process.env, ENVIRONMENT, "AUTH_D1_DATABASE_NAME"),
        controlPlaneDatabaseId: betterAuthD1EnvironmentValue(process.env, ENVIRONMENT, "CONTROL_PLANE_D1_DATABASE_ID"),
        controlPlaneDatabaseName: betterAuthD1EnvironmentValue(
          process.env,
          ENVIRONMENT,
          "CONTROL_PLANE_D1_DATABASE_NAME",
        ),
        namespaceId: allocatedRequestLimiterNamespaceId(deploymentId, workerName),
        controlPlaneMigrationsDir: staged.migrationsDir,
      }),
    )
    const configArgs = ["--config", config]

    const concurrent = concurrentReleaseProcesses(await capture("ps", ["-A", "-o", "pid=,args="]), process.pid)
    if (concurrent.length > 0) {
      throw new Error(
        `a release process is already alive; its successor CAS inputs would be stale:\n  ${concurrent.join("\n  ")}`,
      )
    }

    for (const binding of ["AUTH_DB", "CONTROL_PLANE_DB"]) {
      await capture(wranglerExecutable, ["d1", "info", binding, ...configArgs, "--json"])
    }
    const incumbentVersionId = requireConsolidatedDeployment(
      parseDeploymentStatus(await capture(wranglerExecutable, ["deployments", "status", ...configArgs, "--json"])),
      workerName,
    )
    const readLedger = async () =>
      parseStagingLedgerState(
        await capture(wranglerExecutable, [
          "d1",
          "execute",
          "AUTH_DB",
          "--remote",
          ...configArgs,
          "--json",
          "--command",
          stagingLedgerSql(deploymentId),
        ]),
      )
    let ledger = await readLedger()
    // A release deploys and then opens, and a failure between the two leaves
    // the active row locked — which refuses every release after it, including
    // the one that would carry the fix. The row itself holds the identity that
    // finishes it, so staging opens it and carries on; production has no
    // `--dev-open` at all and still stops here.
    if (ledger.activePhase === "locked" && dryRun) {
      console.log(
        `the active release ${ledger.activeReleaseId} is locked; a release would finish it first with ` +
          "prepare-better-auth-d1.ts --dev-open --staging, then release over it",
      )
      return
    }
    if (ledger.activePhase === "locked") {
      console.log(`finishing ${ledger.activeReleaseId}, left locked by an interrupted release`)
      await inherit(process.execPath, ["run", "scripts/deploy/prepare-better-auth-d1.ts", "--dev-open", "--staging"], {
        ...process.env,
        ...ledger.activeIdentity,
        CLAXEDO_DEPLOYMENT_ID: deploymentId,
        CLAXEDO_RELEASE_ID: ledger.activeReleaseId,
        CLAXEDO_RELEASE_SEQUENCE: String(ledger.activeReleaseSequence),
        BETTER_AUTH_URL: apiOrigin,
        CLAXEDO_WRANGLER_CONFIG: config,
      })
      ledger = await readLedger()
    }
    const predecessor = stagingReleasePredecessor(ledger)

    const releaseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CLAXEDO_RELEASE_ID: identity.releaseId,
      CLAXEDO_RELEASE_OPERATION_ID: identity.operationId,
      CLAXEDO_RELEASE_SEQUENCE: String(predecessor.releaseSequence),
      CLAXEDO_PREVIOUS_RELEASE_ID: predecessor.previousReleaseId,
      CLAXEDO_PREVIOUS_STATE_REVISION: String(predecessor.previousStateRevision),
      CLAXEDO_PREVIOUS_PHASE: predecessor.previousPhase,
      CLAXEDO_PREVIOUS_PHASE_REVISION: String(predecessor.previousPhaseRevision),
      CLAXEDO_CANARY_JOURNEY_ID: identity.canaryJourneyId,
      CLAXEDO_AUTH_DESCRIPTOR_EXPIRES_AT: identity.authDescriptorExpiresAt,
      // betterAuthD1ReleaseInputs refuses a successor to an `open` predecessor
      // without this: the certified pipeline has no traffic switch, so the new
      // version takes 100% while the ledger still names the open predecessor
      // and every request identity-fails until the candidate is activated.
      CLAXEDO_DEV_OPEN_ROLL_FORWARD: "1",
    }
    const releaseArgs = ["run", "scripts/deploy/release-better-auth-d1.ts", "--staging", "--cutover", "--agent-plugins", "--deploy"]
    const devOpenArgs = ["run", "scripts/deploy/prepare-better-auth-d1.ts", "--dev-open", "--staging"]

    console.log(
      [
        `worker              ${workerName}`,
        `deployment          ${deploymentId}`,
        `api origin          ${apiOrigin}`,
        `incumbent version   ${incumbentVersionId}`,
        `previous release    ${predecessor.previousReleaseId}`,
        `previous revision   ${predecessor.previousStateRevision}`,
        `previous phase      ${predecessor.previousPhase} (phaseRevision ${predecessor.previousPhaseRevision})`,
        `release id          ${identity.releaseId}`,
        `operation id        ${identity.operationId}`,
        `release sequence    ${predecessor.releaseSequence}`,
        `canary journey      ${identity.canaryJourneyId}`,
        `descriptor expires  ${identity.authDescriptorExpiresAt} (${new Date(Number(identity.authDescriptorExpiresAt)).toISOString()})`,
        `wrangler config     ${config}`,
        "",
        `  bun ${releaseArgs.join(" ")}`,
        `  bun ${devOpenArgs.join(" ")}`,
      ].join("\n"),
    )
    if (dryRun) return

    await inherit(process.execPath, releaseArgs, releaseEnv)

    const manifest = asRecord(
      parseJson(
        await readFile(path.join(serverRoot, ".artifacts", "deployments", `${ENVIRONMENT}-${identity.releaseId}.json`), "utf8"),
      ),
    )
    const platformVersionId = stringField(manifest, "platformVersionId")
    const limiter = asRecord(asRecord(manifest?.resources)?.requestLimiter)
    if (!platformVersionId) throw new Error("the release manifest does not name a platform version")
    await inherit(process.execPath, devOpenArgs, {
      ...releaseEnv,
      CLAXEDO_DEPLOYMENT_ID: deploymentId,
      CLAXEDO_WORKER_BUILD_ID: stringField(manifest, "workerBuildId"),
      CLAXEDO_PLATFORM_VERSION_ID: platformVersionId,
      CLAXEDO_BROWSER_BUILD_ID: stringField(manifest, "browserBuildId"),
      CLAXEDO_RELAY_BUILD_ID: stringField(manifest, "relayBuildId"),
      CLAXEDO_AUTH_CONFIGURATION_ID: stringField(manifest, "authConfigurationId"),
      CLAXEDO_REQUEST_LIMITER_NAMESPACE_ID: stringField(limiter, "namespaceId"),
      CLAXEDO_RECOVERY_EPOCH: stringField(manifest, "recoveryEpoch"),
      BETTER_AUTH_URL: apiOrigin,
      CLAXEDO_WRANGLER_CONFIG: config,
    })

    const open = await verifyOpenRelease({ apiOrigin, releaseId: identity.releaseId, platformVersionId })
    console.log(`staging release ${identity.releaseId} is open at state revision ${open.stateRevision}`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) await main()
