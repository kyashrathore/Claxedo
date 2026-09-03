import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { resolveDeploymentProfileFromEnv } from "../../src/deployments/hosted-shared/deployment-profile"
import {
  LOCKED_SERVICE_MANIFEST_ID,
  canaryDeploymentPrewriteRollbackStatements,
  lockedDeploymentReleaseActivationStatement,
  lockedDeploymentReleaseCandidateStatements,
  devOpenDeploymentReleaseStatements,
  lockedDeploymentPrewriteRollbackStatements,
  type DeploymentReleaseIdentity,
  type DeploymentReleaseTransition,
} from "../../src/deployments/hosted-workerd/better-auth-d1-release-state.cf"
import {
  pairedD1RecoveryControlPlaneVerificationSql,
  pairedD1RecoveryRegistrationStatements,
  verifyPairedD1ControlPlaneRecoveryRow,
} from "../../src/deployments/hosted-workerd/paired-d1-recovery.cf"
import {
  BETTER_AUTH_INTROSPECTION_CLIENT_ID,
  betterAuthDatabaseSchemaInspectionSql,
  betterAuthIntrospectionClientSecretCiphertext,
  betterAuthNativeClientProvisioningStatements,
  betterAuthNativeResource,
  verifyBetterAuthDatabaseSchemaInspection,
} from "../../src/platform/auth/better-auth-native-clients"

const serverRoot = path.resolve(import.meta.dirname, "../..")

type PreparationCommand = {
  args: string[]
  verify?: "schema" | "precondition" | "candidate" | "rollback" | "final" | "control-recovery"
}

export type BetterAuthD1PreparationMode = "register-candidate" | "activate-candidate" | "rollback-candidate"
  | "rollback-canary" | "dev-open"

function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required for Better Auth D1 preparation`)
  return value
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string) {
  const value = required(env, name)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function nonNegativeInteger(env: NodeJS.ProcessEnv, name: string) {
  const value = required(env, name)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`)
  return parsed
}

function literal(value: string | number) {
  return typeof value === "number" ? String(value) : `'${value.replaceAll("'", "''")}'`
}

export function betterAuthD1PreparationIdentity(env: NodeJS.ProcessEnv): DeploymentReleaseIdentity {
  const profile = resolveDeploymentProfileFromEnv(env)
  if (
    profile.adapterProfile !== "better-auth-d1" ||
    profile.productPosture !== "user-deployed" ||
    profile.sandboxPosture !== "control-plane-only"
  ) {
    throw new Error("Better Auth D1 locked preparation certifies only user-deployed control-plane-only")
  }
  return {
    deploymentId: required(env, "CLAXEDO_DEPLOYMENT_ID"),
    releaseSequence: positiveInteger(env, "CLAXEDO_RELEASE_SEQUENCE"),
    releaseId: required(env, "CLAXEDO_RELEASE_ID"),
    workerBuildId: required(env, "CLAXEDO_WORKER_BUILD_ID"),
    platformVersionId: required(env, "CLAXEDO_PLATFORM_VERSION_ID"),
    browserBuildId: required(env, "CLAXEDO_BROWSER_BUILD_ID"),
    relayBuildId: required(env, "CLAXEDO_RELAY_BUILD_ID"),
    authConfigurationId: required(env, "CLAXEDO_AUTH_CONFIGURATION_ID"),
    requestLimiterNamespaceId: required(env, "CLAXEDO_REQUEST_LIMITER_NAMESPACE_ID"),
    adapterProfile: profile.adapterProfile,
    productPosture: profile.productPosture,
    sandboxPosture: profile.sandboxPosture,
    serviceManifestId: LOCKED_SERVICE_MANIFEST_ID,
  }
}

export function betterAuthD1PreparationTransition(env: NodeJS.ProcessEnv) {
  const names = [
    "CLAXEDO_PREVIOUS_RELEASE_ID",
    "CLAXEDO_PREVIOUS_STATE_REVISION",
    "CLAXEDO_PREVIOUS_PHASE",
    "CLAXEDO_PREVIOUS_PHASE_REVISION",
    "CLAXEDO_RELEASE_OPERATION_ID",
  ] as const
  const present = names.filter((name) => env[name]?.trim())
  if (present.length === 0) return undefined
  if (present.length !== names.length)
    throw new Error("all Better Auth D1 successor CAS inputs must be provided together")
  const previousPhase = required(env, "CLAXEDO_PREVIOUS_PHASE")
  if (
    previousPhase !== "locked" &&
    previousPhase !== "canary" &&
    previousPhase !== "provider_sync" &&
    previousPhase !== "multiplayer_validation" &&
    previousPhase !== "open"
  ) {
    throw new Error("CLAXEDO_PREVIOUS_PHASE must be a deployment release phase")
  }
  return {
    operationId: required(env, "CLAXEDO_RELEASE_OPERATION_ID"),
    previousReleaseId: required(env, "CLAXEDO_PREVIOUS_RELEASE_ID"),
    previousStateRevision: nonNegativeInteger(env, "CLAXEDO_PREVIOUS_STATE_REVISION"),
    previousPhase,
    previousPhaseRevision: nonNegativeInteger(env, "CLAXEDO_PREVIOUS_PHASE_REVISION"),
  } satisfies DeploymentReleaseTransition
}

function targetArgs(staging: boolean, env: NodeJS.ProcessEnv) {
  void staging
  return ["--config", required(env, "CLAXEDO_WRANGLER_CONFIG")]
}

function exactIdentityPredicate(identity: DeploymentReleaseIdentity, alias = "release") {
  return [
    [`${alias}."deploymentId"`, identity.deploymentId],
    [`${alias}."releaseSequence"`, identity.releaseSequence],
    [`${alias}."releaseId"`, identity.releaseId],
    [`${alias}."workerBuildId"`, identity.workerBuildId],
    [`${alias}."platformVersionId"`, identity.platformVersionId],
    [`${alias}."browserBuildId"`, identity.browserBuildId],
    [`${alias}."relayBuildId"`, identity.relayBuildId],
    [`${alias}."authConfigurationId"`, identity.authConfigurationId],
    [`${alias}."requestLimiterNamespaceId"`, identity.requestLimiterNamespaceId],
    [`${alias}."adapterProfile"`, identity.adapterProfile],
    [`${alias}."productPosture"`, identity.productPosture],
    [`${alias}."sandboxPosture"`, identity.sandboxPosture],
    [`${alias}."serviceManifestId"`, identity.serviceManifestId],
  ]
    .map(([column, value]) => `${column} = ${literal(value)}`)
    .join(" and ")
}

function activeReleasePredicate(identity: DeploymentReleaseIdentity, stateRevision: number) {
  return `select count(*) from "deploymentReleaseActive" as "active"
    join "deploymentReleaseStateHistory" as "state"
      on "state"."deploymentId" = "active"."deploymentId" and "state"."stateRevision" = "active"."stateRevision"
    join "deploymentRelease" as "release"
      on "release"."deploymentId" = "state"."deploymentId" and "release"."releaseId" = "state"."releaseId"
    where "active"."singleton" = 1 and "state"."stateRevision" = ${stateRevision}
      and "state"."phase" = 'locked' and "state"."phaseRevision" = 0
      and ${exactIdentityPredicate(identity)}`
}

function preconditionSql(identity: DeploymentReleaseIdentity, transition?: DeploymentReleaseTransition) {
  const candidateConflict = `(select count(*) from "deploymentRelease" as "release"
    where "release"."deploymentId" = ${literal(identity.deploymentId)}
      and "release"."releaseId" = ${literal(identity.releaseId)}
      and not (${exactIdentityPredicate(identity)})) = 0`
  const retryRevision = transition ? transition.previousStateRevision + 1 : 0
  const exactRetry = `(${activeReleasePredicate(identity, retryRevision)}) = 1`
  if (!transition) {
    return `select case when ${candidateConflict} and (
      (select count(*) from "deploymentReleaseActive") = 0 or ${exactRetry}
    ) then 1 else 0 end as "eligible";`
  }
  const source = `(select count(*) from "deploymentReleaseActive" as "active"
    join "deploymentReleaseStateHistory" as "state"
      on "state"."deploymentId" = "active"."deploymentId" and "state"."stateRevision" = "active"."stateRevision"
    where "active"."singleton" = 1
      and "active"."deploymentId" = ${literal(identity.deploymentId)}
      and "active"."stateRevision" = ${transition.previousStateRevision}
      and "state"."releaseId" = ${literal(transition.previousReleaseId)}
      and "state"."phase" = ${literal(transition.previousPhase)}
      and "state"."phaseRevision" = ${transition.previousPhaseRevision}) = 1`
  return `select case when ${candidateConflict} and (${source} or ${exactRetry})
    then 1 else 0 end as "eligible";`
}

function verificationSql(
  identity: DeploymentReleaseIdentity,
  transition: DeploymentReleaseTransition | undefined,
  apiOrigin: string,
  active: boolean,
  recoveryEpoch: string,
) {
  const expectedRevision = transition ? transition.previousStateRevision + 1 : 0
  const operationId = transition?.operationId ?? `initialize:${identity.releaseId}`
  const resource = betterAuthNativeResource(apiOrigin)
  return `select
    "release"."deploymentId", "release"."releaseSequence", "release"."releaseId",
    "release"."workerBuildId", "release"."platformVersionId", "release"."browserBuildId", "release"."relayBuildId",
    "release"."authConfigurationId", "release"."requestLimiterNamespaceId",
    "release"."adapterProfile", "release"."productPosture", "release"."sandboxPosture",
    "release"."serviceManifestId", "state"."phase", "state"."phaseRevision", "state"."stateRevision",
    (select count(*) from "oauthClient" where "clientId" = 'claxedo-cli') as "cliClient",
    (select count(*) from "oauthClient" where "clientId" = 'claxedo-desktop') as "desktopClient",
    (select count(*) from "oauthClient" where "clientId" = ${literal(BETTER_AUTH_INTROSPECTION_CLIENT_ID)}) as "introspectionClient",
    (select count(*) from "oauthResource" where "identifier" = ${literal(resource)}) as "resource",
    (select count(*) from "oauthClientResource"
      where "clientId" in ('claxedo-cli', 'claxedo-desktop', ${literal(BETTER_AUTH_INTROSPECTION_CLIENT_ID)})
        and "resourceId" = ${literal(resource)}) as "resourceLinks",
    (select count(*) from "deploymentRecoveryEpoch"
      where "deploymentId" = ${literal(identity.deploymentId)} and "releaseId" = ${literal(identity.releaseId)}
        and "recoveryEpoch" = ${literal(recoveryEpoch)}) as "authRecoveryEpoch"
    ${
      active
        ? `from "deploymentReleaseActive" as "active"
    join "deploymentReleaseStateHistory" as "state"
      on "state"."deploymentId" = "active"."deploymentId" and "state"."stateRevision" = "active"."stateRevision"`
        : `from "deploymentReleaseStateHistory" as "state"`
    }
    join "deploymentRelease" as "release"
      on "release"."deploymentId" = "state"."deploymentId" and "release"."releaseId" = "state"."releaseId"
    where ${active ? `"active"."singleton" = 1 and ` : ""}"state"."deploymentId" = ${literal(identity.deploymentId)}
      and "state"."operationId" = ${literal(operationId)} and "state"."stateRevision" = ${expectedRevision}
      and "state"."phase" = 'locked' and "state"."phaseRevision" = 0
      and ${exactIdentityPredicate(identity)};`
}

function rollbackVerificationSql(
  identity: DeploymentReleaseIdentity,
  transition: DeploymentReleaseTransition,
  operationId: string,
) {
  const candidateRevision = transition.previousStateRevision + 1
  return `select case when count(*) = 1 then 1 else 0 end as "rolledBack"
    from "deploymentReleaseActive" as "active"
    join "deploymentReleaseStateHistory" as "state"
      on "state"."deploymentId" = "active"."deploymentId" and "state"."stateRevision" = "active"."stateRevision"
    where "active"."singleton" = 1 and "active"."deploymentId" = ${literal(identity.deploymentId)}
      and "state"."stateRevision" = ${candidateRevision + 1}
      and "state"."operationId" = ${literal(operationId)}
      and "state"."releaseId" = ${literal(transition.previousReleaseId)}
      and "state"."previousStateRevision" = ${candidateRevision}
      and "state"."restoredStateRevision" = ${transition.previousStateRevision}
      and "state"."transitionKind" = 'prewrite_rollback'
      and "state"."phase" = ${literal(transition.previousPhase)}
      and "state"."phaseRevision" = ${transition.previousPhaseRevision};`
}

function canaryRollbackPreconditionSql(
  identity: DeploymentReleaseIdentity,
  transition: DeploymentReleaseTransition,
  operationId: string,
) {
  const canaryRevision = transition.previousStateRevision + 2
  const rollbackRevision = canaryRevision + 1
  return `select case when
    (select count(*) from "deploymentReleaseActive" as "active"
      join "deploymentReleaseStateHistory" as "state"
        on "state"."deploymentId" = "active"."deploymentId" and "state"."stateRevision" = "active"."stateRevision"
      join "deploymentRelease" as "release"
        on "release"."deploymentId" = "state"."deploymentId" and "release"."releaseId" = "state"."releaseId"
      where "active"."singleton" = 1 and "active"."deploymentId" = ${literal(identity.deploymentId)}
        and "active"."stateRevision" = ${canaryRevision} and "state"."releaseId" = ${literal(identity.releaseId)}
        and "state"."phase" = 'canary' and "state"."phaseRevision" = 1
        and "state"."firstTargetWriteAt" is null and ${exactIdentityPredicate(identity)}) = 1
    or (select count(*) from "deploymentReleaseActive" as "active"
      join "deploymentReleaseStateHistory" as "state"
        on "state"."deploymentId" = "active"."deploymentId" and "state"."stateRevision" = "active"."stateRevision"
      where "active"."singleton" = 1 and "active"."deploymentId" = ${literal(identity.deploymentId)}
        and "active"."stateRevision" = ${rollbackRevision} and "state"."operationId" = ${literal(operationId)}
        and "state"."transitionKind" = 'prewrite_rollback'
        and "state"."previousStateRevision" = ${canaryRevision}
        and "state"."restoredStateRevision" = ${transition.previousStateRevision}) = 1
    then 1 else 0 end as "eligible";`
}

function canaryRollbackVerificationSql(
  identity: DeploymentReleaseIdentity,
  transition: DeploymentReleaseTransition,
  operationId: string,
) {
  const canaryRevision = transition.previousStateRevision + 2
  return `select case when count(*) = 1 then 1 else 0 end as "rolledBack"
    from "deploymentReleaseActive" as "active"
    join "deploymentReleaseStateHistory" as "state"
      on "state"."deploymentId" = "active"."deploymentId" and "state"."stateRevision" = "active"."stateRevision"
    where "active"."singleton" = 1 and "active"."deploymentId" = ${literal(identity.deploymentId)}
      and "state"."stateRevision" = ${canaryRevision + 1}
      and "state"."operationId" = ${literal(operationId)}
      and "state"."releaseId" = ${literal(transition.previousReleaseId)}
      and "state"."previousStateRevision" = ${canaryRevision}
      and "state"."restoredStateRevision" = ${transition.previousStateRevision}
      and "state"."transitionKind" = 'prewrite_rollback'
      and "state"."phase" = ${literal(transition.previousPhase)}
      and "state"."phaseRevision" = ${transition.previousPhaseRevision};`
}

export async function betterAuthD1PreparationCommands(input: {
  env: NodeJS.ProcessEnv
  staging: boolean
  mode: BetterAuthD1PreparationMode
  now?: Date
}): Promise<PreparationCommand[]> {
  const identity = betterAuthD1PreparationIdentity(input.env)
  const transition = betterAuthD1PreparationTransition(input.env)
  const apiOrigin = required(input.env, "BETTER_AUTH_URL")
  const introspectionSecretCiphertext = await betterAuthIntrospectionClientSecretCiphertext(
    required(input.env, "BETTER_AUTH_SECRET"),
    required(input.env, "CLAXEDO_AUTH_INTROSPECTION_SECRET"),
  )
  betterAuthNativeResource(apiOrigin)
  const target = targetArgs(input.staging, input.env)
  const execute = (sql: string, verify?: PreparationCommand["verify"]): PreparationCommand => ({
    args: ["d1", "execute", "AUTH_DB", "--remote", ...target, "--command", sql, ...(verify ? ["--json"] : [])],
    verify,
  })
  const executeControlPlane = (sql: string, verify?: PreparationCommand["verify"]): PreparationCommand => ({
    args: ["d1", "execute", "CONTROL_PLANE_DB", "--remote", ...target, "--command", sql, ...(verify ? ["--json"] : [])],
    verify,
  })
  if (input.mode === "dev-open") {
    // Development staging only: skip the gate ceremony and serve the release
    // open immediately. Refused for production so the certified pipeline
    // stays the only road to an open production release.
    if (!input.staging) throw new Error("dev-open is a development-staging convenience; production opens through evidence")
    return [
      execute(betterAuthDatabaseSchemaInspectionSql(), "schema"),
      ...devOpenDeploymentReleaseStatements(identity, input.now).map((sql) => execute(sql)),
      execute(devOpenVerificationSql(identity), "rollback"),
    ]
  }
  if (input.mode === "rollback-canary") {
    if (!transition) throw new Error("canary rollback requires a successor CAS contract")
    const operationId = required(input.env, "CLAXEDO_ROLLBACK_OPERATION_ID")
    const canaryRevision = transition.previousStateRevision + 2
    return [
      execute(betterAuthDatabaseSchemaInspectionSql(), "schema"),
      execute(canaryRollbackPreconditionSql(identity, transition, operationId), "precondition"),
      ...canaryDeploymentPrewriteRollbackStatements(
        {
          deploymentId: identity.deploymentId,
          operationId,
          expectedReleaseId: identity.releaseId,
          expectedStateRevision: canaryRevision,
        },
        input.now,
      ).map((sql) => execute(sql)),
      execute(canaryRollbackVerificationSql(identity, transition, operationId), "rollback"),
    ]
  }
  if (input.mode === "rollback-candidate") {
    if (!transition) throw new Error("candidate rollback requires a successor CAS contract")
    const operationId = required(input.env, "CLAXEDO_ROLLBACK_OPERATION_ID")
    return [
      execute(betterAuthDatabaseSchemaInspectionSql(), "schema"),
      execute(preconditionSql(identity, transition), "precondition"),
      ...lockedDeploymentPrewriteRollbackStatements(
        {
          deploymentId: identity.deploymentId,
          operationId,
          expectedReleaseId: identity.releaseId,
          expectedStateRevision: transition.previousStateRevision + 1,
        },
        input.now,
      ).map((sql) => execute(sql)),
      execute(rollbackVerificationSql(identity, transition, operationId), "rollback"),
    ]
  }
  if (input.mode === "register-candidate") {
    const recovery = {
      deploymentId: identity.deploymentId,
      releaseId: identity.releaseId,
      recoveryEpoch: required(input.env, "CLAXEDO_RECOVERY_EPOCH"),
    }
    const recoveryStatements = pairedD1RecoveryRegistrationStatements(recovery, input.now)
    return [
      { args: ["d1", "migrations", "apply", "AUTH_DB", "--remote", ...target] },
      { args: ["d1", "migrations", "apply", "CONTROL_PLANE_DB", "--remote", ...target] },
      execute(betterAuthDatabaseSchemaInspectionSql(), "schema"),
      execute(preconditionSql(identity, transition), "precondition"),
      ...betterAuthNativeClientProvisioningStatements(apiOrigin, introspectionSecretCiphertext).map((sql) =>
        execute(sql),
      ),
      ...lockedDeploymentReleaseCandidateStatements(identity, input.now, transition).map((sql) => execute(sql)),
      execute(recoveryStatements.auth),
      executeControlPlane(recoveryStatements.controlPlane),
      execute(verificationSql(identity, transition, apiOrigin, false, recovery.recoveryEpoch), "candidate"),
      executeControlPlane(pairedD1RecoveryControlPlaneVerificationSql(recovery), "control-recovery"),
    ]
  }
  return [
    execute(betterAuthDatabaseSchemaInspectionSql(), "schema"),
    execute(preconditionSql(identity, transition), "precondition"),
    execute(lockedDeploymentReleaseActivationStatement(identity, input.now, transition)),
    execute(
      verificationSql(identity, transition, apiOrigin, true, required(input.env, "CLAXEDO_RECOVERY_EPOCH")),
      "final",
    ),
  ]
}

function verificationRow(output: string, label: string) {
  const parsed = JSON.parse(output) as unknown
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error(`D1 ${label} verification returned no result`)
  const result = parsed[0] as { success?: boolean; results?: Array<Record<string, unknown>> }
  const row = result.results?.[0]
  if (!result.success || result.results?.length !== 1 || !row) {
    throw new Error(`D1 ${label} verification did not return exactly one row`)
  }
  return row
}

export function verifyBetterAuthD1PreparationPrecondition(output: string) {
  const row = verificationRow(output, "precondition")
  if (row.eligible !== 1) throw new Error("D1 preparation precondition rejected stale or conflicting release state")
  return row
}

export function verifyBetterAuthD1PreparationSchema(output: string) {
  const row = verificationRow(output, "schema")
  verifyBetterAuthDatabaseSchemaInspection(row)
  return row
}

export function verifyBetterAuthD1PreparationOutput(output: string) {
  const row = verificationRow(output, "final")
  if (
    row.phase !== "locked" ||
    row.phaseRevision !== 0 ||
    row.cliClient !== 1 ||
    row.desktopClient !== 1 ||
    row.introspectionClient !== 1 ||
    row.resource !== 1 ||
    row.resourceLinks !== 3 ||
    row.authRecoveryEpoch !== 1
  )
    throw new Error("D1 preparation verification found an incomplete or non-locked deployment")
  return row
}

export function verifyBetterAuthD1ControlPlaneRecoveryOutput(
  output: string,
  binding: { deploymentId: string; releaseId: string; recoveryEpoch: string },
) {
  return verifyPairedD1ControlPlaneRecoveryRow(verificationRow(output, "control recovery"), binding)
}

export function verifyBetterAuthD1PreparationRollback(output: string) {
  const row = verificationRow(output, "rollback")
  if (row.rolledBack !== 1) throw new Error("D1 preparation rollback did not restore the predecessor")
  return row
}

export function isTransientWranglerFailure(stderr: string) {
  return /fetch failed|connectivity issue|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|\b100146\b/i.test(stderr)
}

async function run(command: PreparationCommand) {
  const executable = path.join(
    serverRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  )
  let output = ""
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const child = spawn(executable, command.args, {
      cwd: serverRoot,
      env: process.env,
      stdio: ["ignore", command.verify ? "pipe" : "inherit", "pipe"],
      shell: process.platform === "win32",
    })
    output = ""
    let stderr = ""
    if (command.verify && child.stdout) {
      child.stdout.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => {
        output += chunk
      })
    }
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk
      process.stderr.write(chunk)
    })
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve))
    if (code === 0) break
    if (attempt === 5 || !isTransientWranglerFailure(stderr)) {
      throw new Error(`wrangler ${command.args.slice(0, 3).join(" ")} failed`)
    }
    const delayMs = attempt * 1_000
    console.warn(`Wrangler connectivity failure; retrying idempotent D1 command in ${delayMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  if (command.verify === "schema") verifyBetterAuthD1PreparationSchema(output)
  if (command.verify === "precondition") verifyBetterAuthD1PreparationPrecondition(output)
  if (command.verify === "candidate") verifyBetterAuthD1PreparationOutput(output)
  if (command.verify === "rollback") verifyBetterAuthD1PreparationRollback(output)
  if (command.verify === "final") verifyBetterAuthD1PreparationOutput(output)
  if (command.verify === "control-recovery") {
    const identity = betterAuthD1PreparationIdentity(process.env)
    verifyBetterAuthD1ControlPlaneRecoveryOutput(output, {
      deploymentId: identity.deploymentId,
      releaseId: identity.releaseId,
      recoveryEpoch: required(process.env, "CLAXEDO_RECOVERY_EPOCH"),
    })
  }
}

function devOpenVerificationSql(identity: { deploymentId: string; releaseId: string }) {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
  return `select case when exists (
    select 1 from "deploymentReleaseActive" as "active"
    join "deploymentReleaseStateHistory" as "state"
      on "state"."deploymentId" = "active"."deploymentId" and "state"."stateRevision" = "active"."stateRevision"
    where "active"."singleton" = 1 and "active"."deploymentId" = ${quote(identity.deploymentId)}
      and "state"."releaseId" = ${quote(identity.releaseId)} and "state"."phase" = 'open'
      and "state"."operationId" = ${quote(`dev-open:${identity.releaseId}`)}
  ) then 1 else 0 end as "rolledBack";`
}

async function main() {
  const modes = ["register-candidate", "activate-candidate", "rollback-candidate", "rollback-canary", "dev-open"] as const
  const selected = modes.filter((mode) => process.argv.includes(`--${mode}`))
  if (selected.length !== 1) throw new Error("select exactly one preparation mode")
  for (const command of await betterAuthD1PreparationCommands({
    env: process.env,
    staging: process.argv.includes("--staging"),
    mode: selected[0]!,
  }))
    await run(command)
  console.log(`Better Auth D1 ${selected[0]} verified`)
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) await main()
