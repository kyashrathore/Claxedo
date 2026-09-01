import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  betterAuthD1DeploymentManifestPath,
  betterAuthD1ReleaseInputs,
  fetchReleaseProbe,
  renderBetterAuthD1WranglerConfig,
  type BetterAuthD1ReleaseEnvironment,
} from "./release-better-auth-d1"

const serverRoot = path.resolve(import.meta.dirname, "../..")
const SHA256 = /^sha256:[0-9a-f]{64}$/

export const GREENFIELD_AUTH_TABLE_COUNTS = Object.freeze({
  account: 0,
  authenticationEvidence: 0,
  deploymentCutoverCanaryAdmission: 0,
  deploymentCutoverEvidenceReceipt: 0,
  deploymentRelease: 1,
  deploymentReleaseActive: 1,
  deploymentReleaseStateHistory: 1,
  deploymentRecoveryEpoch: 1,
  deviceCode: 0,
  jwks: 0,
  oauthAccessToken: 0,
  oauthClient: 3,
  oauthClientAssertion: 0,
  oauthClientResource: 3,
  oauthConsent: 0,
  oauthRefreshToken: 0,
  oauthResource: 1,
  session: 0,
  user: 0,
  verification: 0,
} as const)

export const GREENFIELD_CONTROL_PLANE_TABLE_COUNTS = Object.freeze({
  agent_extension_installs: 0,
  actors: 0,
  agent_extension_policy_overrides: 0,
  authority_audit_events: 0,
  authority_batch_assertions: 0,
  auth_identities: 0,
  channel_identity_bindings: 0,
  control_plane_recovery_epochs: 1,
  host_enrollment_requests: 0,
  host_enrollments: 0,
  host_signature_uses: 0,
  host_workspace_assignments: 0,
  org_memberships: 0,
  orgs: 0,
  project_memberships: 0,
  projects: 0,
  runtime_access_tokens: 0,
  service_deployment_locks: 0,
  service_deployment_steps: 0,
  service_installation_audit: 0,
  service_installations: 0,
  session_messages: 0,
  session_participants: 0,
  session_registration_operations: 0,
  session_share_grants: 0,
  session_turn_leases: 0,
  session_turn_producers: 0,
  sessions: 0,
  team_memberships: 0,
  team_project_grants: 0,
  teams: 0,
  user_deployed_owner_bootstrap_claims: 0,
  users: 0,
  workspace_direct_memberships: 0,
  workspace_share_grants: 0,
  workspaces: 0,
} as const)

const GREENFIELD_AUTH_APPEND_ONLY_MINIMUM_COUNTS = new Set([
  "deploymentRelease",
  "deploymentReleaseStateHistory",
  "deploymentRecoveryEpoch",
])
const GREENFIELD_CONTROL_PLANE_APPEND_ONLY_MINIMUM_COUNTS = new Set(["control_plane_recovery_epochs"])

type GreenfieldBinding = "AUTH_DB" | "CONTROL_PLANE_DB"
type ExpectedCounts = Readonly<Record<string, number>>
type ActiveRelease = Readonly<{
  deploymentId: string
  releaseId: string
  workerBuildId: string
  platformVersionId: string
  browserBuildId: string
  relayBuildId: string
  authConfigurationId: string
  adapterProfile: string
  productPosture: string
  sandboxPosture: string
  serviceManifestId: string
  phase: string
  phaseRevision: number
}>

export type GreenfieldTargetAbsenceCommand = Readonly<{
  binding: GreenfieldBinding
  kind: "schema" | "counts"
  args: readonly string[]
}>

export type GreenfieldTargetAbsenceProof = Readonly<{
  schemaVersion: 1
  deploymentId: string
  releaseId: string
  deploymentManifestSha256: string
  databases: readonly Readonly<{
    binding: GreenfieldBinding
    databaseId: string
    schemaTables: readonly string[]
    rows: readonly Readonly<{ table: string; count: number }>[]
  }>[]
  targetAbsenceSha256: string
}>

function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required for the greenfield target-absence proof`)
  return value
}

function quotedIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`
}

export function greenfieldTargetSchemaSql() {
  return `select name as "table" from sqlite_schema
    where type = 'table'
      and name not like 'sqlite\\_%' escape '\\'
      and name not like '\\_cf\\_%' escape '\\'
      and name <> 'd1_migrations'
    order by name;`
}

export function greenfieldTargetCountsSql(expected: ExpectedCounts) {
  return `select\n${Object.keys(expected)
    .sort()
    .map((table) => `  (select count(*) from ${quotedIdentifier(table)}) as ${quotedIdentifier(table)}`)
    .join(",\n")};`
}

export function greenfieldTargetAbsenceCommands(configPath: string): readonly GreenfieldTargetAbsenceCommand[] {
  const configArgs = ["--remote", "--config", configPath, "--json"] as const
  return Object.freeze(
    (
      [
        ["AUTH_DB", "schema", greenfieldTargetSchemaSql()],
        ["AUTH_DB", "counts", greenfieldTargetCountsSql(GREENFIELD_AUTH_TABLE_COUNTS)],
        ["CONTROL_PLANE_DB", "schema", greenfieldTargetSchemaSql()],
        ["CONTROL_PLANE_DB", "counts", greenfieldTargetCountsSql(GREENFIELD_CONTROL_PLANE_TABLE_COUNTS)],
      ] as const
    ).map(([binding, kind, sql]) =>
      Object.freeze({
        binding,
        kind,
        args: Object.freeze(["d1", "execute", binding, ...configArgs, "--command", sql]),
      }),
    ),
  )
}

function d1Rows(output: string, label: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new Error(`${label} did not return JSON`)
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error(`${label} returned an unexpected result set`)
  const result = parsed[0] as { success?: unknown; results?: unknown }
  if (result.success !== true || !Array.isArray(result.results)) throw new Error(`${label} query failed`)
  return result.results as Array<Record<string, unknown>>
}

function canonicalSchema(output: string, expected: ExpectedCounts, binding: GreenfieldBinding) {
  const rows = d1Rows(output, `${binding} schema`)
  const names = rows.map((row, index) => {
    if (typeof row.table !== "string" || !row.table) throw new Error(`${binding} schema row ${index} is malformed`)
    return row.table
  })
  if (new Set(names).size !== names.length) throw new Error(`${binding} schema contains duplicate table names`)
  const expectedNames = Object.keys(expected).sort()
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    const missing = expectedNames.filter((name) => !names.includes(name))
    const unexpected = names.filter((name) => !expectedNames.includes(name))
    throw new Error(
      `${binding} schema is not the exact certified greenfield schema (missing: ${missing.join(",") || "none"}; unexpected: ${unexpected.join(",") || "none"})`,
    )
  }
  return Object.freeze(names)
}

function canonicalCounts(
  output: string,
  expected: ExpectedCounts,
  binding: GreenfieldBinding,
  appendOnlyMinimums: ReadonlySet<string>,
) {
  const expectedNames = Object.keys(expected).sort()
  const resultRows = d1Rows(output, `${binding} counts`)
  if (resultRows.length !== 1) throw new Error(`${binding} counts must return exactly one row`)
  const result = resultRows[0]!
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(expectedNames)) {
    throw new Error(`${binding} counts do not cover the exact certified schema`)
  }
  const rows = expectedNames.map((table) => {
    const count = result[table]
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new Error(`${binding}.${table} count is malformed`)
    }
    return Object.freeze({ table, count: count as number })
  })
  for (const row of rows) {
    const expectedCount = expected[row.table]
    if (appendOnlyMinimums.has(row.table) ? row.count < expectedCount : row.count !== expectedCount) {
      throw new Error(`${binding}.${row.table} expected ${expected[row.table]} rows but observed ${row.count}`)
    }
  }
  return Object.freeze(rows)
}

function digest(value: string | Uint8Array) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

export function verifyGreenfieldDeploymentManifest(input: {
  manifest: unknown
  activeRelease: ActiveRelease
  environment: BetterAuthD1ReleaseEnvironment
  apiOrigin: string
  appOrigin: string
  authDatabaseId: string
  controlPlaneDatabaseId: string
  recoveryEpoch: string
}) {
  const manifest = object(input.manifest, "deployment manifest")
  const resources = object(manifest.resources, "deployment manifest resources")
  const authDatabase = object(resources.authDatabase, "deployment manifest AUTH_DB")
  const controlPlaneDatabase = object(resources.controlPlaneDatabase, "deployment manifest CONTROL_PLANE_DB")
  const exact = [
    [manifest.schemaVersion, 1, "schemaVersion"],
    [manifest.deploymentId, input.activeRelease.deploymentId, "deploymentId"],
    [manifest.releaseId, input.activeRelease.releaseId, "releaseId"],
    [manifest.environment, input.environment, "environment"],
    [manifest.workerBuildId, input.activeRelease.workerBuildId, "workerBuildId"],
    [manifest.platformVersionId, input.activeRelease.platformVersionId, "platformVersionId"],
    [manifest.browserBuildId, input.activeRelease.browserBuildId, "browserBuildId"],
    [manifest.relayBuildId, input.activeRelease.relayBuildId, "relayBuildId"],
    [manifest.authConfigurationId, input.activeRelease.authConfigurationId, "authConfigurationId"],
    [manifest.adapterProfile, "better-auth-d1", "adapterProfile"],
    [manifest.adapterProfile, input.activeRelease.adapterProfile, "active adapterProfile"],
    [manifest.productPosture, "user-deployed", "productPosture"],
    [manifest.productPosture, input.activeRelease.productPosture, "active productPosture"],
    [manifest.sandboxPosture, "control-plane-only", "sandboxPosture"],
    [manifest.sandboxPosture, input.activeRelease.sandboxPosture, "active sandboxPosture"],
    [manifest.serviceManifestId, "empty-services-v1", "serviceManifestId"],
    [manifest.serviceManifestId, input.activeRelease.serviceManifestId, "active serviceManifestId"],
    [manifest.apiOrigin, input.apiOrigin, "apiOrigin"],
    [manifest.appOrigin, input.appOrigin, "appOrigin"],
    [manifest.recoveryEpoch, input.recoveryEpoch, "recoveryEpoch"],
    [authDatabase.binding, "AUTH_DB", "AUTH_DB binding"],
    [authDatabase.databaseId, input.authDatabaseId, "AUTH_DB databaseId"],
    [controlPlaneDatabase.binding, "CONTROL_PLANE_DB", "CONTROL_PLANE_DB binding"],
    [controlPlaneDatabase.databaseId, input.controlPlaneDatabaseId, "CONTROL_PLANE_DB databaseId"],
    [input.activeRelease.phase, "locked", "active phase"],
    [input.activeRelease.phaseRevision, 0, "active phaseRevision"],
  ] as const
  for (const [actual, expected, label] of exact) {
    if (actual !== expected) throw new Error(`deployment manifest ${label} does not match the live locked release`)
  }
  return manifest
}

export function verifyGreenfieldTargetAbsence(input: {
  deploymentId: string
  releaseId: string
  deploymentManifestSha256: string
  authDatabaseId: string
  controlPlaneDatabaseId: string
  outputs: Readonly<Record<`${GreenfieldBinding}:${"schema" | "counts"}`, string>>
}): GreenfieldTargetAbsenceProof {
  if (!SHA256.test(input.deploymentManifestSha256)) {
    throw new Error("deployment manifest identity must be a lowercase SHA-256")
  }
  const databases = Object.freeze([
    Object.freeze({
      binding: "AUTH_DB" as const,
      databaseId: input.authDatabaseId,
      schemaTables: canonicalSchema(input.outputs["AUTH_DB:schema"], GREENFIELD_AUTH_TABLE_COUNTS, "AUTH_DB"),
      rows: canonicalCounts(
        input.outputs["AUTH_DB:counts"],
        GREENFIELD_AUTH_TABLE_COUNTS,
        "AUTH_DB",
        GREENFIELD_AUTH_APPEND_ONLY_MINIMUM_COUNTS,
      ),
    }),
    Object.freeze({
      binding: "CONTROL_PLANE_DB" as const,
      databaseId: input.controlPlaneDatabaseId,
      schemaTables: canonicalSchema(
        input.outputs["CONTROL_PLANE_DB:schema"],
        GREENFIELD_CONTROL_PLANE_TABLE_COUNTS,
        "CONTROL_PLANE_DB",
      ),
      rows: canonicalCounts(
        input.outputs["CONTROL_PLANE_DB:counts"],
        GREENFIELD_CONTROL_PLANE_TABLE_COUNTS,
        "CONTROL_PLANE_DB",
        GREENFIELD_CONTROL_PLANE_APPEND_ONLY_MINIMUM_COUNTS,
      ),
    }),
  ])
  const evidence = Object.freeze({
    schemaVersion: 1 as const,
    deploymentId: input.deploymentId,
    releaseId: input.releaseId,
    deploymentManifestSha256: input.deploymentManifestSha256,
    databases,
  })
  return Object.freeze({ ...evidence, targetAbsenceSha256: digest(JSON.stringify(evidence)) })
}

async function run(command: GreenfieldTargetAbsenceCommand) {
  const executable = path.join(
    serverRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  )
  const child = spawn(executable, command.args, {
    cwd: serverRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "inherit"],
    shell: process.platform === "win32",
  })
  let output = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    output += chunk
  })
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve))
  if (code !== 0) throw new Error(`wrangler target-absence query failed for ${command.binding}:${command.kind}`)
  return output
}

async function main() {
  const environment: BetterAuthD1ReleaseEnvironment = process.argv.includes("--staging") ? "staging" : "production"
  const release = betterAuthD1ReleaseInputs(process.env, environment)
  const manifestPath = betterAuthD1DeploymentManifestPath(process.env, environment)
  const manifest = await readFile(manifestPath)
  let parsedManifest: unknown
  try {
    parsedManifest = JSON.parse(manifest.toString("utf8"))
  } catch {
    throw new Error("deployment manifest is not valid JSON")
  }
  const statusResponse = await fetchReleaseProbe(`${release.apiOrigin}/__release/operator/status`, {
    headers: { authorization: `Bearer ${required(process.env, "CLAXEDO_RELEASE_OPERATOR_SECRET")}` },
    signal: AbortSignal.timeout(15_000),
  })
  const status = (await statusResponse.json()) as { release?: ActiveRelease; error?: { code?: string } }
  if (!statusResponse.ok || !status.release) {
    throw new Error(`live release status is unavailable (${status.error?.code ?? statusResponse.status})`)
  }
  verifyGreenfieldDeploymentManifest({
    manifest: parsedManifest,
    activeRelease: status.release,
    environment,
    apiOrigin: release.apiOrigin,
    appOrigin: release.authConfiguration.appOrigin,
    authDatabaseId: release.authDatabaseId,
    controlPlaneDatabaseId: release.controlPlaneDatabaseId,
    recoveryEpoch:
      release.runtimeVariables.find(([name]) => name === "CLAXEDO_RECOVERY_EPOCH")?.[1] ??
      required(process.env, "CLAXEDO_RECOVERY_EPOCH"),
  })
  const temporary = await mkdtemp(path.join(serverRoot, ".claxedo-greenfield-proof-"))
  try {
    const configPath = path.join(temporary, "wrangler.toml")
    await writeFile(configPath, renderBetterAuthD1WranglerConfig({ staging: environment === "staging", ...release }))
    const outputs = {} as Record<`${GreenfieldBinding}:${"schema" | "counts"}`, string>
    for (const command of greenfieldTargetAbsenceCommands(configPath)) {
      outputs[`${command.binding}:${command.kind}`] = await run(command)
    }
    const proof = verifyGreenfieldTargetAbsence({
      deploymentId:
        release.runtimeVariables.find(([name]) => name === "CLAXEDO_DEPLOYMENT_ID")?.[1] ??
        required(process.env, `CLAXEDO_${environment.toUpperCase()}_DEPLOYMENT_ID`),
      releaseId: required(process.env, "CLAXEDO_RELEASE_ID"),
      deploymentManifestSha256: digest(manifest),
      authDatabaseId: release.authDatabaseId,
      controlPlaneDatabaseId: release.controlPlaneDatabaseId,
      outputs,
    })
    process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) await main()
