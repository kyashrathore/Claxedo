import type { D1Database } from "@cloudflare/workers-types"
import { EMPTY_SERVICE_MANIFEST_ID } from "@claxedo/service-contract"

import type { CertifiedAdapterProfile, ProductPosture, SandboxPosture } from "../hosted-shared/deployment-profile"

export const LOCKED_BROWSER_BUILD_ID = "browser-absent-v1"
export const LOCKED_RELAY_BUILD_ID = "relay-absent-v1"
export const LOCKED_SERVICE_MANIFEST_ID = EMPTY_SERVICE_MANIFEST_ID

export const DEPLOYMENT_RELEASE_PHASES = [
  "locked",
  "canary",
  "provider_sync",
  "multiplayer_validation",
  "open",
] as const

export type DeploymentReleasePhase = (typeof DEPLOYMENT_RELEASE_PHASES)[number]

export type DeploymentReleaseIdentity = {
  deploymentId: string
  releaseSequence: number
  releaseId: string
  workerBuildId: string
  platformVersionId: string
  browserBuildId: string
  relayBuildId: string
  authConfigurationId: string
  requestLimiterNamespaceId: string
  adapterProfile: CertifiedAdapterProfile
  productPosture: ProductPosture
  sandboxPosture: SandboxPosture
  serviceManifestId: string
}

export type DeploymentReleaseState = DeploymentReleaseIdentity & {
  stateRevision: number
  operationId: string
  previousStateRevision: number | null
  restoredStateRevision: number | null
  transitionKind:
    | "initialize"
    | "open_rollforward"
    | "locked_replacement"
    | "prewrite_rollback"
    | "phase_transition"
    | "first_target_write"
  phase: DeploymentReleasePhase
  phaseRevision: number
  firstTargetWriteAt: string | null
  createdAt: string
}

export type DeploymentReleaseTransition = {
  operationId: string
  previousReleaseId: string
  previousStateRevision: number
  previousPhase: DeploymentReleasePhase
  previousPhaseRevision: number
}

export type DeploymentReleaseRollback = {
  deploymentId: string
  operationId: string
  expectedReleaseId: string
  expectedStateRevision: number
}

export type DeploymentReleasePhaseTransition = {
  operationId: string
  expectedStateRevision: number
  expectedPhase: DeploymentReleasePhase
  expectedPhaseRevision: number
  targetPhase: Exclude<DeploymentReleasePhase, "locked">
}

export type DeploymentReleaseFirstTargetWrite = {
  operationId: string
  expectedStateRevision: number
  expectedPhaseRevision: number
}

type SqlDefinition = { sql: string; values: Array<string | number | null> }

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const ARTIFACT_BUILD_ID = /^sha256:[0-9a-f]{64}$/
const RELEASE_INSERT_SQL = `insert into "deploymentRelease" (
  "deploymentId", "releaseSequence", "releaseId", "workerBuildId", "platformVersionId", "browserBuildId", "relayBuildId",
  "authConfigurationId", "requestLimiterNamespaceId", "adapterProfile", "productPosture", "sandboxPosture", "serviceManifestId", "createdAt"
) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
on conflict ("deploymentId", "releaseId") do nothing`
const INITIAL_STATE_INSERT_SQL = `insert into "deploymentReleaseStateHistory" (
  "deploymentId", "stateRevision", "operationId", "releaseId", "previousStateRevision",
  "restoredStateRevision", "transitionKind", "phase", "phaseRevision", "firstTargetWriteAt", "createdAt"
)
select ?, 0, ?, ?, null, null, 'initialize', 'locked', 0, null, ?
where not exists (select 1 from "deploymentReleaseActive")
on conflict do nothing`
const INITIAL_ACTIVE_INSERT_SQL = `insert into "deploymentReleaseActive" (
  "singleton", "deploymentId", "stateRevision", "updatedAt"
)
select 1, ?, 0, ?
from "deploymentReleaseStateHistory" as "state"
join "deploymentRelease" as "release"
  on "release"."deploymentId" = "state"."deploymentId" and "release"."releaseId" = "state"."releaseId"
where "state"."deploymentId" = ? and "state"."stateRevision" = 0
  and "state"."releaseId" = ? and "state"."phase" = 'locked' and "state"."phaseRevision" = 0
  and "release"."releaseSequence" = ? and "release"."workerBuildId" = ?
  and "release"."platformVersionId" = ?
  and "release"."browserBuildId" = ? and "release"."relayBuildId" = ?
  and "release"."authConfigurationId" = ?
  and "release"."requestLimiterNamespaceId" = ?
  and "release"."adapterProfile" = ? and "release"."productPosture" = ?
  and "release"."sandboxPosture" = ? and "release"."serviceManifestId" = ?
on conflict ("singleton") do nothing`
const SUCCESSOR_STATE_INSERT_SQL = `insert into "deploymentReleaseStateHistory" (
  "deploymentId", "stateRevision", "operationId", "releaseId", "previousStateRevision",
  "restoredStateRevision", "transitionKind", "phase", "phaseRevision", "firstTargetWriteAt", "createdAt"
)
select "active"."deploymentId", "current"."stateRevision" + 1, ?, "target"."releaseId",
  "current"."stateRevision", null,
  case when "current"."phase" = 'open' then 'open_rollforward' else 'locked_replacement' end,
  'locked', 0, null, ?
from "deploymentReleaseActive" as "active"
join "deploymentReleaseStateHistory" as "current"
  on "current"."deploymentId" = "active"."deploymentId"
  and "current"."stateRevision" = "active"."stateRevision"
join "deploymentRelease" as "previous"
  on "previous"."deploymentId" = "current"."deploymentId"
  and "previous"."releaseId" = "current"."releaseId"
join "deploymentRelease" as "target"
  on "target"."deploymentId" = "current"."deploymentId" and "target"."releaseId" = ?
where "active"."singleton" = 1 and "active"."deploymentId" = ?
  and "active"."stateRevision" = ? and "current"."releaseId" = ?
  and "current"."phase" = ? and "current"."phaseRevision" = ?
  and ("current"."phase" in ('provider_sync', 'multiplayer_validation', 'open') or
    ("current"."phase" = 'canary' and "current"."firstTargetWriteAt" is not null) or
    ("current"."phase" = 'locked' and (
      "current"."firstTargetWriteAt" is null
    )))
  and "target"."releaseSequence" > "previous"."releaseSequence"
  and "target"."releaseSequence" = ? and "target"."workerBuildId" = ?
  and "target"."platformVersionId" = ?
  and "target"."browserBuildId" = ? and "target"."relayBuildId" = ?
  and "target"."authConfigurationId" = ?
  and "target"."requestLimiterNamespaceId" = ?
  and "target"."adapterProfile" = ? and "target"."productPosture" = ?
  and "target"."sandboxPosture" = ? and "target"."serviceManifestId" = ?
on conflict do nothing`
const SUCCESSOR_ACTIVE_CAS_SQL = `update "deploymentReleaseActive"
set "stateRevision" = ?, "updatedAt" = ?
where "singleton" = 1 and "deploymentId" = ? and "stateRevision" = ?
  and exists (
    select 1 from "deploymentReleaseStateHistory"
    where "deploymentId" = ? and "stateRevision" = ? and "operationId" = ? and "releaseId" = ?
      and "previousStateRevision" = ? and "phase" = 'locked' and "phaseRevision" = 0
  )`
const PREWRITE_ROLLBACK_STATE_INSERT_SQL = `insert into "deploymentReleaseStateHistory" (
  "deploymentId", "stateRevision", "operationId", "releaseId", "previousStateRevision",
  "restoredStateRevision", "transitionKind", "phase", "phaseRevision", "firstTargetWriteAt", "createdAt"
)
select "current"."deploymentId", "current"."stateRevision" + 1, ?, "previous"."releaseId",
  "current"."stateRevision", "previous"."stateRevision", 'prewrite_rollback',
  "previous"."phase", "previous"."phaseRevision", "previous"."firstTargetWriteAt", ?
from "deploymentReleaseStateHistory" as "current"
join "deploymentReleaseStateHistory" as "previous"
  on "previous"."deploymentId" = "current"."deploymentId"
  and "previous"."stateRevision" = "current"."previousStateRevision"
join "deploymentReleaseActive" as "active"
  on "active"."deploymentId" = "current"."deploymentId"
where "active"."singleton" = 1 and "active"."deploymentId" = ?
  and "active"."stateRevision" in (?, ?) and "current"."stateRevision" = ?
  and "current"."releaseId" = ?
  and "current"."phase" = 'locked' and "current"."phaseRevision" = 0
  and "current"."firstTargetWriteAt" is null
on conflict do nothing`
const PREWRITE_ROLLBACK_ACTIVE_CAS_SQL = `update "deploymentReleaseActive"
set "stateRevision" = ?, "updatedAt" = ?
where "singleton" = 1 and "deploymentId" = ? and "stateRevision" in (?, ?)
  and exists (
    select 1 from "deploymentReleaseStateHistory" as "rollback"
    where "rollback"."deploymentId" = ? and "rollback"."stateRevision" = ?
      and "rollback"."operationId" = ? and "rollback"."transitionKind" = 'prewrite_rollback'
      and "rollback"."previousStateRevision" = ? and "rollback"."restoredStateRevision" = ?
  )`
const CANARY_PREWRITE_ROLLBACK_STATE_INSERT_SQL = `insert into "deploymentReleaseStateHistory" (
  "deploymentId", "stateRevision", "operationId", "releaseId", "previousStateRevision",
  "restoredStateRevision", "transitionKind", "phase", "phaseRevision", "firstTargetWriteAt", "createdAt"
)
select "current"."deploymentId", "current"."stateRevision" + 1, ?, "previous"."releaseId",
  "current"."stateRevision", "previous"."stateRevision", 'prewrite_rollback',
  "previous"."phase", "previous"."phaseRevision", "previous"."firstTargetWriteAt", ?
from "deploymentReleaseActive" as "active"
join "deploymentReleaseStateHistory" as "current"
  on "current"."deploymentId" = "active"."deploymentId"
  and "current"."stateRevision" = "active"."stateRevision"
join "deploymentReleaseStateHistory" as "candidate"
  on "candidate"."deploymentId" = "current"."deploymentId"
  and "candidate"."stateRevision" = "current"."previousStateRevision"
join "deploymentReleaseStateHistory" as "previous"
  on "previous"."deploymentId" = "candidate"."deploymentId"
  and "previous"."stateRevision" = "candidate"."previousStateRevision"
where "active"."singleton" = 1 and "active"."deploymentId" = ?
  and "active"."stateRevision" = ? and "current"."stateRevision" = ?
  and "current"."releaseId" = ? and "current"."phase" = 'canary'
  and "current"."phaseRevision" = 1 and "current"."firstTargetWriteAt" is null
  and "candidate"."releaseId" = "current"."releaseId"
  and "candidate"."phase" = 'locked' and "candidate"."phaseRevision" = 0
  and "candidate"."firstTargetWriteAt" is null
on conflict do nothing`
const CANARY_PREWRITE_ROLLBACK_ACTIVE_CAS_SQL = `update "deploymentReleaseActive"
set "stateRevision" = ?, "updatedAt" = ?
where "singleton" = 1 and "deploymentId" = ? and "stateRevision" in (?, ?)
  and exists (
    select 1 from "deploymentReleaseStateHistory" as "rollback"
    where "rollback"."deploymentId" = ? and "rollback"."stateRevision" = ?
      and "rollback"."operationId" = ? and "rollback"."transitionKind" = 'prewrite_rollback'
      and "rollback"."previousStateRevision" = ? and "rollback"."restoredStateRevision" = ?
  )`
const PHASE_TRANSITION_STATE_INSERT_SQL = `insert into "deploymentReleaseStateHistory" (
  "deploymentId", "stateRevision", "operationId", "releaseId", "previousStateRevision",
  "restoredStateRevision", "transitionKind", "phase", "phaseRevision", "firstTargetWriteAt", "createdAt"
)
select "current"."deploymentId", "current"."stateRevision" + 1, ?, "current"."releaseId",
  "current"."stateRevision", null, 'phase_transition', ?, "current"."phaseRevision" + 1,
  "current"."firstTargetWriteAt", ?
from "deploymentReleaseActive" as "active"
join "deploymentReleaseStateHistory" as "current"
  on "current"."deploymentId" = "active"."deploymentId"
  and "current"."stateRevision" = "active"."stateRevision"
where "active"."singleton" = 1 and "active"."deploymentId" = ?
  and "active"."stateRevision" = ? and "current"."releaseId" = ?
  and "current"."phase" = ? and "current"."phaseRevision" = ?
  and (? <> 'provider_sync' or "current"."firstTargetWriteAt" is not null)
on conflict do nothing`
const PHASE_TRANSITION_ACTIVE_CAS_SQL = `update "deploymentReleaseActive"
set "stateRevision" = ?, "updatedAt" = ?
where "singleton" = 1 and "deploymentId" = ? and "stateRevision" = ?
  and exists (
    select 1 from "deploymentReleaseStateHistory"
    where "deploymentId" = ? and "stateRevision" = ? and "operationId" = ? and "releaseId" = ?
      and "previousStateRevision" = ? and "transitionKind" = 'phase_transition'
      and "phase" = ? and "phaseRevision" = ?
  )`
const FIRST_TARGET_WRITE_STATE_INSERT_SQL = `insert into "deploymentReleaseStateHistory" (
  "deploymentId", "stateRevision", "operationId", "releaseId", "previousStateRevision",
  "restoredStateRevision", "transitionKind", "phase", "phaseRevision", "firstTargetWriteAt", "createdAt"
)
select "current"."deploymentId", "current"."stateRevision" + 1, ?, "current"."releaseId",
  "current"."stateRevision", null, 'first_target_write', 'canary', "current"."phaseRevision" + 1, ?, ?
from "deploymentReleaseActive" as "active"
join "deploymentReleaseStateHistory" as "current"
  on "current"."deploymentId" = "active"."deploymentId"
  and "current"."stateRevision" = "active"."stateRevision"
where "active"."singleton" = 1 and "active"."deploymentId" = ?
  and "active"."stateRevision" = ? and "current"."releaseId" = ?
  and "current"."phase" = 'canary' and "current"."phaseRevision" = ?
  and "current"."firstTargetWriteAt" is null
on conflict do nothing`
const FIRST_TARGET_WRITE_ACTIVE_CAS_SQL = `update "deploymentReleaseActive"
set "stateRevision" = ?, "updatedAt" = ?
where "singleton" = 1 and "deploymentId" = ? and "stateRevision" = ?
  and exists (
    select 1 from "deploymentReleaseStateHistory"
    where "deploymentId" = ? and "stateRevision" = ? and "operationId" = ? and "releaseId" = ?
      and "previousStateRevision" = ? and "transitionKind" = 'first_target_write'
      and "phase" = 'canary' and "phaseRevision" = ? and "firstTargetWriteAt" = ?
  )`

const NEXT_RELEASE_PHASE = {
  locked: "canary",
  canary: "provider_sync",
  provider_sync: "multiplayer_validation",
  multiplayer_validation: "open",
} as const satisfies Record<Exclude<DeploymentReleasePhase, "open">, Exclude<DeploymentReleasePhase, "locked">>

function assertIdentity(identity: DeploymentReleaseIdentity) {
  for (const [name, value] of Object.entries(identity)) {
    if (
      name === "releaseSequence" ||
      name === "requestLimiterNamespaceId" ||
      name.endsWith("Profile") ||
      name.endsWith("Posture")
    )
      continue
    if (!IDENTIFIER.test(value as string)) {
      throw new Error(`${name} must be an explicit 8-128 character deployment identifier`)
    }
  }
  if (!Number.isSafeInteger(identity.releaseSequence) || identity.releaseSequence <= 0) {
    throw new Error("releaseSequence must be a positive integer")
  }
  if (!/^\d{4,12}$/.test(identity.requestLimiterNamespaceId)) {
    throw new Error("requestLimiterNamespaceId must be the explicit numeric Cloudflare namespace")
  }
}

function assertTransition(identity: DeploymentReleaseIdentity, transition: DeploymentReleaseTransition) {
  for (const [name, value] of [
    ["operationId", transition.operationId],
    ["previousReleaseId", transition.previousReleaseId],
  ] as const) {
    if (!IDENTIFIER.test(value)) throw new Error(`${name} must be an explicit 8-128 character identifier`)
  }
  if (transition.previousReleaseId === identity.releaseId) {
    throw new Error("a successor transition requires a different releaseId")
  }
  for (const [name, value] of [
    ["previousStateRevision", transition.previousStateRevision],
    ["previousPhaseRevision", transition.previousPhaseRevision],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  }
  if (!DEPLOYMENT_RELEASE_PHASES.includes(transition.previousPhase)) {
    throw new Error("successor transition source phase must be a deployment release phase")
  }
}

function assertRollback(input: DeploymentReleaseRollback) {
  for (const [name, value] of [
    ["deploymentId", input.deploymentId],
    ["operationId", input.operationId],
    ["expectedReleaseId", input.expectedReleaseId],
  ] as const) {
    if (!IDENTIFIER.test(value)) throw new Error(`${name} must be an explicit 8-128 character identifier`)
  }
  if (!Number.isSafeInteger(input.expectedStateRevision) || input.expectedStateRevision <= 0) {
    throw new Error("rollback expectedStateRevision must identify a successor state")
  }
}

function assertOperationId(operationId: string) {
  if (!IDENTIFIER.test(operationId)) {
    throw new Error("operationId must be an explicit 8-128 character identifier")
  }
}

function assertExpectedRevision(name: string, value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
}

function assertPhaseTransition(input: DeploymentReleasePhaseTransition) {
  assertOperationId(input.operationId)
  assertExpectedRevision("expectedStateRevision", input.expectedStateRevision)
  assertExpectedRevision("expectedPhaseRevision", input.expectedPhaseRevision)
  if (input.expectedPhase === "open") throw new Error("open is the terminal deployment release phase")
  if (NEXT_RELEASE_PHASE[input.expectedPhase] !== input.targetPhase) {
    throw new Error(`deployment release phase must advance from ${input.expectedPhase} to its immediate successor`)
  }
}

function assertFirstTargetWrite(input: DeploymentReleaseFirstTargetWrite) {
  assertOperationId(input.operationId)
  assertExpectedRevision("expectedStateRevision", input.expectedStateRevision)
  assertExpectedRevision("expectedPhaseRevision", input.expectedPhaseRevision)
}

function identityValues(identity: DeploymentReleaseIdentity) {
  return [
    identity.releaseSequence,
    identity.workerBuildId,
    identity.platformVersionId,
    identity.browserBuildId,
    identity.relayBuildId,
    identity.authConfigurationId,
    identity.requestLimiterNamespaceId,
    identity.adapterProfile,
    identity.productPosture,
    identity.sandboxPosture,
    identity.serviceManifestId,
  ] as const
}

function definitions(
  identity: DeploymentReleaseIdentity,
  now: Date,
  transition?: DeploymentReleaseTransition,
): SqlDefinition[] {
  assertIdentity(identity)
  if (transition) assertTransition(identity, transition)
  const timestamp = now.toISOString()
  const release: SqlDefinition = {
    sql: RELEASE_INSERT_SQL,
    values: [
      identity.deploymentId,
      identity.releaseSequence,
      identity.releaseId,
      identity.workerBuildId,
      identity.platformVersionId,
      identity.browserBuildId,
      identity.relayBuildId,
      identity.authConfigurationId,
      identity.requestLimiterNamespaceId,
      identity.adapterProfile,
      identity.productPosture,
      identity.sandboxPosture,
      identity.serviceManifestId,
      timestamp,
    ],
  }
  if (!transition) {
    return [
      release,
      {
        sql: INITIAL_STATE_INSERT_SQL,
        values: [identity.deploymentId, `initialize:${identity.releaseId}`, identity.releaseId, timestamp],
      },
      {
        sql: INITIAL_ACTIVE_INSERT_SQL,
        values: [
          identity.deploymentId,
          timestamp,
          identity.deploymentId,
          identity.releaseId,
          ...identityValues(identity),
        ],
      },
    ]
  }
  const nextRevision = transition.previousStateRevision + 1
  return [
    release,
    {
      sql: SUCCESSOR_STATE_INSERT_SQL,
      values: [
        transition.operationId,
        timestamp,
        identity.releaseId,
        identity.deploymentId,
        transition.previousStateRevision,
        transition.previousReleaseId,
        transition.previousPhase,
        transition.previousPhaseRevision,
        ...identityValues(identity),
      ],
    },
    {
      sql: SUCCESSOR_ACTIVE_CAS_SQL,
      values: [
        nextRevision,
        timestamp,
        identity.deploymentId,
        transition.previousStateRevision,
        identity.deploymentId,
        nextRevision,
        transition.operationId,
        identity.releaseId,
        transition.previousStateRevision,
      ],
    },
  ]
}

function rollbackDefinitions(input: DeploymentReleaseRollback, now: Date): SqlDefinition[] {
  assertRollback(input)
  const timestamp = now.toISOString()
  const rollbackRevision = input.expectedStateRevision + 1
  const restoredRevision = input.expectedStateRevision - 1
  return [
    {
      sql: PREWRITE_ROLLBACK_STATE_INSERT_SQL,
      values: [
        input.operationId,
        timestamp,
        input.deploymentId,
        input.expectedStateRevision,
        restoredRevision,
        input.expectedStateRevision,
        input.expectedReleaseId,
      ],
    },
    {
      sql: PREWRITE_ROLLBACK_ACTIVE_CAS_SQL,
      values: [
        rollbackRevision,
        timestamp,
        input.deploymentId,
        input.expectedStateRevision,
        restoredRevision,
        input.deploymentId,
        rollbackRevision,
        input.operationId,
        input.expectedStateRevision,
        restoredRevision,
      ],
    },
  ]
}

function canaryRollbackDefinitions(input: DeploymentReleaseRollback, now: Date): SqlDefinition[] {
  assertRollback(input)
  if (input.expectedStateRevision < 2) throw new Error("canary rollback requires a successor canary revision")
  const timestamp = now.toISOString()
  const rollbackRevision = input.expectedStateRevision + 1
  const restoredRevision = input.expectedStateRevision - 2
  return [
    {
      sql: CANARY_PREWRITE_ROLLBACK_STATE_INSERT_SQL,
      values: [
        input.operationId,
        timestamp,
        input.deploymentId,
        input.expectedStateRevision,
        input.expectedStateRevision,
        input.expectedReleaseId,
      ],
    },
    {
      sql: CANARY_PREWRITE_ROLLBACK_ACTIVE_CAS_SQL,
      values: [
        rollbackRevision,
        timestamp,
        input.deploymentId,
        input.expectedStateRevision,
        rollbackRevision,
        input.deploymentId,
        rollbackRevision,
        input.operationId,
        input.expectedStateRevision,
        restoredRevision,
      ],
    },
  ]
}

function phaseTransitionDefinitions(
  identity: DeploymentReleaseIdentity,
  input: DeploymentReleasePhaseTransition,
  now: Date,
): SqlDefinition[] {
  assertIdentity(identity)
  assertPhaseTransition(input)
  const timestamp = now.toISOString()
  const nextStateRevision = input.expectedStateRevision + 1
  const nextPhaseRevision = input.expectedPhaseRevision + 1
  return [
    {
      sql: PHASE_TRANSITION_STATE_INSERT_SQL,
      values: [
        input.operationId,
        input.targetPhase,
        timestamp,
        identity.deploymentId,
        input.expectedStateRevision,
        identity.releaseId,
        input.expectedPhase,
        input.expectedPhaseRevision,
        input.targetPhase,
      ],
    },
    {
      sql: PHASE_TRANSITION_ACTIVE_CAS_SQL,
      values: [
        nextStateRevision,
        timestamp,
        identity.deploymentId,
        input.expectedStateRevision,
        identity.deploymentId,
        nextStateRevision,
        input.operationId,
        identity.releaseId,
        input.expectedStateRevision,
        input.targetPhase,
        nextPhaseRevision,
      ],
    },
  ]
}

function firstTargetWriteDefinitions(
  identity: DeploymentReleaseIdentity,
  input: DeploymentReleaseFirstTargetWrite,
  now: Date,
): SqlDefinition[] {
  assertIdentity(identity)
  assertFirstTargetWrite(input)
  const timestamp = now.toISOString()
  const nextStateRevision = input.expectedStateRevision + 1
  const nextPhaseRevision = input.expectedPhaseRevision + 1
  return [
    {
      sql: FIRST_TARGET_WRITE_STATE_INSERT_SQL,
      values: [
        input.operationId,
        timestamp,
        timestamp,
        identity.deploymentId,
        input.expectedStateRevision,
        identity.releaseId,
        input.expectedPhaseRevision,
      ],
    },
    {
      sql: FIRST_TARGET_WRITE_ACTIVE_CAS_SQL,
      values: [
        nextStateRevision,
        timestamp,
        identity.deploymentId,
        input.expectedStateRevision,
        identity.deploymentId,
        nextStateRevision,
        input.operationId,
        identity.releaseId,
        input.expectedStateRevision,
        nextPhaseRevision,
        timestamp,
      ],
    },
  ]
}

function sqliteLiteral(value: string | number | null) {
  if (value === null) return "null"
  if (typeof value === "number") return String(value)
  return `'${value.replaceAll("'", "''")}'`
}

function render(definition: SqlDefinition) {
  let index = 0
  const sql = definition.sql.replaceAll("?", () => {
    if (index >= definition.values.length) throw new Error("Release provisioning statement is missing a value")
    return sqliteLiteral(definition.values[index++]!)
  })
  if (index !== definition.values.length) throw new Error("Release provisioning statement has unused values")
  return `${sql};`
}

/** Candidate registration and history insertion are inert until the final CAS. */
export function lockedDeploymentReleaseProvisioningStatements(
  identity: DeploymentReleaseIdentity,
  now = new Date(),
  transition?: DeploymentReleaseTransition,
) {
  return definitions(identity, now, transition).map(render)
}

export function lockedDeploymentReleaseCandidateStatements(
  identity: DeploymentReleaseIdentity,
  now = new Date(),
  transition?: DeploymentReleaseTransition,
) {
  return definitions(identity, now, transition).slice(0, 2).map(render)
}

export function lockedDeploymentReleaseActivationStatement(
  identity: DeploymentReleaseIdentity,
  now = new Date(),
  transition?: DeploymentReleaseTransition,
) {
  return render(definitions(identity, now, transition)[2]!)
}

export function lockedDeploymentPrewriteRollbackStatements(input: DeploymentReleaseRollback, now = new Date()) {
  return rollbackDefinitions(input, now).map(render)
}

export function canaryDeploymentPrewriteRollbackStatements(input: DeploymentReleaseRollback, now = new Date()) {
  return canaryRollbackDefinitions(input, now).map(render)
}

export async function registerLockedDeploymentReleaseCandidate(
  database: D1Database,
  identity: DeploymentReleaseIdentity,
  now = new Date(),
  transition?: DeploymentReleaseTransition,
) {
  const statements = definitions(identity, now, transition).slice(0, 2)
  const results = await database.batch(
    statements.map((statement) => database.prepare(statement.sql).bind(...statement.values)),
  )
  if (results.some((result) => !result.success)) throw new Error("deployment release candidate registration failed")
  return requireDeploymentReleaseCandidate(database, identity, transition)
}

export async function activateLockedDeploymentReleaseCandidate(
  database: D1Database,
  identity: DeploymentReleaseIdentity,
  now = new Date(),
  transition?: DeploymentReleaseTransition,
) {
  const statement = definitions(identity, now, transition)[2]!
  const result = await database
    .prepare(statement.sql)
    .bind(...statement.values)
    .run()
  if (!result.success) throw new Error("deployment release candidate activation failed")
  const state = await requireDeploymentReleaseState(database, identity)
  const expectedRevision = transition ? transition.previousStateRevision + 1 : 0
  if (state.phase !== "locked" || state.phaseRevision !== 0 || state.stateRevision !== expectedRevision) {
    throw new Error("active deployment release is not the exact locked candidate")
  }
  return state
}

export async function rollbackLockedDeploymentReleaseCandidate(
  database: D1Database,
  input: DeploymentReleaseRollback,
  now = new Date(),
) {
  const definitions = rollbackDefinitions(input, now)
  const results = await database.batch(
    definitions.map((definition) => database.prepare(definition.sql).bind(...definition.values)),
  )
  if (results.some((result) => !result.success)) throw new Error("deployment release rollback failed")
  const state = await database
    .prepare(
      `${RELEASE_STATE_COLUMNS}
    ${RELEASE_STATE_FROM_ACTIVE}
    where "active"."singleton" = 1 and "active"."deploymentId" = ?
      and "state"."operationId" = ? and "state"."transitionKind" = 'prewrite_rollback'`,
    )
    .bind(input.deploymentId, input.operationId)
    .first<DeploymentReleaseState>()
  if (
    !state ||
    state.stateRevision !== input.expectedStateRevision + 1 ||
    state.previousStateRevision !== input.expectedStateRevision ||
    state.restoredStateRevision !== input.expectedStateRevision - 1
  )
    throw new Error("deployment release rollback did not restore the immediate predecessor")
  return state
}

export async function rollbackDeploymentCanaryBeforeWrite(
  database: D1Database,
  input: DeploymentReleaseRollback,
  now = new Date(),
) {
  const definitions = canaryRollbackDefinitions(input, now)
  const results = await database.batch(
    definitions.map((definition) => database.prepare(definition.sql).bind(...definition.values)),
  )
  if (results.some((result) => !result.success)) throw new Error("deployment canary rollback failed")
  const state = await database
    .prepare(
      `${RELEASE_STATE_COLUMNS}
    ${RELEASE_STATE_FROM_ACTIVE}
    where "active"."singleton" = 1 and "active"."deploymentId" = ?
      and "state"."operationId" = ? and "state"."transitionKind" = 'prewrite_rollback'`,
    )
    .bind(input.deploymentId, input.operationId)
    .first<DeploymentReleaseState>()
  if (
    !state ||
    state.stateRevision !== input.expectedStateRevision + 1 ||
    state.previousStateRevision !== input.expectedStateRevision ||
    state.restoredStateRevision !== input.expectedStateRevision - 2
  )
    throw new Error("deployment canary rollback did not restore the pre-candidate predecessor")
  return state
}

export async function provisionLockedDeploymentReleaseState(
  database: D1Database,
  identity: DeploymentReleaseIdentity,
  now = new Date(),
  transition?: DeploymentReleaseTransition,
) {
  await registerLockedDeploymentReleaseCandidate(database, identity, now, transition)
  return activateLockedDeploymentReleaseCandidate(database, identity, now, transition)
}

export async function advanceDeploymentReleasePhase(
  database: D1Database,
  identity: DeploymentReleaseIdentity,
  input: DeploymentReleasePhaseTransition,
  now = new Date(),
) {
  assertIdentity(identity)
  assertPhaseTransition(input)
  await requireDeploymentCutoverEvidence(database, identity, input)
  const statements = phaseTransitionDefinitions(identity, input, now)
  const results = await database.batch(
    statements.map((statement) => database.prepare(statement.sql).bind(...statement.values)),
  )
  if (results.some((result) => !result.success)) throw new Error("deployment release phase transition failed")
  const state = await requireDeploymentReleaseState(database, identity)
  if (
    state.operationId !== input.operationId ||
    state.previousStateRevision !== input.expectedStateRevision ||
    state.stateRevision !== input.expectedStateRevision + 1 ||
    state.phase !== input.targetPhase ||
    state.phaseRevision !== input.expectedPhaseRevision + 1 ||
    state.transitionKind !== "phase_transition"
  ) {
    throw new Error("deployment release phase transition lost its compare-and-swap")
  }
  if (input.targetPhase === "canary" && state.firstTargetWriteAt !== null) {
    throw new Error("canary admission must begin before the first target write")
  }
  if (input.targetPhase !== "canary" && state.firstTargetWriteAt === null) {
    throw new Error("deployment release cannot advance past canary before the first target write")
  }
  return state
}

async function requireDeploymentCutoverEvidence(
  database: D1Database,
  identity: DeploymentReleaseIdentity,
  input: DeploymentReleasePhaseTransition,
) {
  const state = await requireDeploymentReleaseState(database, identity)
  if (
    state.stateRevision !== input.expectedStateRevision ||
    state.phase !== input.expectedPhase ||
    state.phaseRevision !== input.expectedPhaseRevision
  )
    throw new Error("deployment cutover evidence was requested for a stale state revision")

  if (input.targetPhase === "canary") {
    const migrationEvidence = await database
      .prepare(
        `select count(*) as "count"
      from "deploymentCutoverEvidenceReceipt"
      where "deploymentId" = ? and "releaseId" = ? and "workerBuildId" = ? and "platformVersionId" = ?
        and "browserBuildId" = ? and "relayBuildId" = ? and "authConfigurationId" = ?
        and "adapterProfile" = ? and "productPosture" = ? and "sandboxPosture" = ? and "serviceManifestId" = ?
        and "evidenceKind" in ('migration_conservation_verified', 'greenfield_source_absence_verified')`,
      )
      .bind(
        identity.deploymentId,
        identity.releaseId,
        identity.workerBuildId,
        identity.platformVersionId,
        identity.browserBuildId,
        identity.relayBuildId,
        identity.authConfigurationId,
        identity.adapterProfile,
        identity.productPosture,
        identity.sandboxPosture,
        identity.serviceManifestId,
      )
      .first<{ count: number }>()
    const successorContinuity =
      migrationEvidence?.count === 0
        ? await database
            .prepare(
              `select count(*) as "count"
        from "deploymentReleaseStateHistory" as "current"
        join "deploymentRelease" as "release"
          on "release"."deploymentId" = "current"."deploymentId" and "release"."releaseId" = "current"."releaseId"
        join "deploymentReleaseStateHistory" as "predecessor"
          on "predecessor"."deploymentId" = "current"."deploymentId"
          and "predecessor"."stateRevision" = "current"."previousStateRevision"
        join "deploymentRelease" as "predecessorRelease"
          on "predecessorRelease"."deploymentId" = "predecessor"."deploymentId"
          and "predecessorRelease"."releaseId" = "predecessor"."releaseId"
        where "current"."deploymentId" = ? and "current"."stateRevision" = ?
          and "current"."releaseId" = ? and "current"."transitionKind" in ('locked_replacement', 'open_rollforward')
          and "predecessorRelease"."releaseSequence" < "release"."releaseSequence"
          and "predecessorRelease"."adapterProfile" = "release"."adapterProfile"
          and "predecessorRelease"."productPosture" = "release"."productPosture"
          and "predecessorRelease"."sandboxPosture" = "release"."sandboxPosture"`,
            )
            .bind(identity.deploymentId, state.stateRevision, identity.releaseId)
            .first<{ count: number }>()
        : undefined
    if (migrationEvidence?.count !== 1 && successorContinuity?.count !== 1) {
      throw new Error("canary requires exactly one release-bound source-boundary evidence receipt")
    }
    const admission = await database
      .prepare(
        `select count(*) as "count"
      from "deploymentCutoverCanaryAdmission" as admission
      where admission."deploymentId" = ? and admission."releaseId" = ?
        and admission."workerBuildId" = ? and admission."platformVersionId" = ?
        and admission."browserBuildId" = ? and admission."relayBuildId" = ?
        and admission."authConfigurationId" = ? and admission."adapterProfile" = ?
        and admission."productPosture" = ? and admission."sandboxPosture" = ?
        and admission."serviceManifestId" = ? and admission."sourceStateRevision" = ?
        and admission."sourcePhaseRevision" = ? and admission."operationId" = ?`,
      )
      .bind(
        identity.deploymentId,
        identity.releaseId,
        identity.workerBuildId,
        identity.platformVersionId,
        identity.browserBuildId,
        identity.relayBuildId,
        identity.authConfigurationId,
        identity.adapterProfile,
        identity.productPosture,
        identity.sandboxPosture,
        identity.serviceManifestId,
        input.expectedStateRevision,
        input.expectedPhaseRevision,
        input.operationId,
      )
      .first<{ count: number }>()
    if (admission?.count !== 1) throw new Error("canary requires one exact deployment-authorized admission receipt")
    return
  }

  const evidence = await database
    .prepare(
      `select "evidenceKind", "evidenceSlot", "primarySubjectHash", "secondarySubjectHash"
    from "deploymentCutoverEvidenceReceipt"
    where "deploymentId" = ? and "releaseId" = ? and "workerBuildId" = ? and "platformVersionId" = ?
      and "browserBuildId" = ? and "relayBuildId" = ? and "authConfigurationId" = ?
      and "adapterProfile" = ? and "productPosture" = ? and "sandboxPosture" = ? and "serviceManifestId" = ?`,
    )
    .bind(
      identity.deploymentId,
      identity.releaseId,
      identity.workerBuildId,
      identity.platformVersionId,
      identity.browserBuildId,
      identity.relayBuildId,
      identity.authConfigurationId,
      identity.adapterProfile,
      identity.productPosture,
      identity.sandboxPosture,
      identity.serviceManifestId,
    )
    .all<{
      evidenceKind: string
      evidenceSlot: number
      primarySubjectHash: string | null
      secondarySubjectHash: string | null
    }>()
  const rows = evidence.results ?? []
  const kinds = new Set(rows.map((row) => row.evidenceKind))
  if (input.targetPhase === "provider_sync") {
    if (!kinds.has("canary_first_write") || !kinds.has("canary_journey_complete")) {
      throw new Error("provider sync requires the exact canary first-write and completed-journey receipts")
    }
    return
  }
  if (input.targetPhase === "multiplayer_validation") {
    const common = [
      "callback_capture_ready",
      "callback_inbox_drained",
      "authority_reconciled",
      "paired_backup_verified",
    ]
    const productEvidence = identity.productPosture === "user-deployed" ? "billing_closure_absent" : "polar_reconciled"
    if ([...common, productEvidence].some((kind) => !kinds.has(kind))) {
      throw new Error(`multiplayer validation requires complete ${identity.productPosture} provider-sync evidence`)
    }
    return
  }
  const identities = rows
    .filter((row) => row.evidenceKind === "multiplayer_identity")
    .sort((left, right) => left.evidenceSlot - right.evidenceSlot)
  const requiredValidation = [
    "private_session_verified",
    "stream_verified",
    "revocation_verified",
    "wrong_org_verified",
    "replay_verified",
    "outage_verified",
  ]
  if (
    !ARTIFACT_BUILD_ID.test(identity.browserBuildId) ||
    (identity.productPosture === "claxedo-hosted" && !ARTIFACT_BUILD_ID.test(identity.relayBuildId)) ||
    identities.length !== 2 ||
    identities[0]?.evidenceSlot !== 1 ||
    identities[1]?.evidenceSlot !== 2 ||
    identities[0]?.primarySubjectHash === identities[1]?.primarySubjectHash ||
    requiredValidation.some((kind) => !kinds.has(kind))
  )
    throw new Error("open requires a browser artifact and complete evidence from exactly two release-bound identities")
  for (const kind of requiredValidation) {
    const row = rows.find((candidate) => candidate.evidenceKind === kind)
    const observed = new Set([row?.primarySubjectHash, row?.secondarySubjectHash])
    if (!identities.every((candidate) => observed.has(candidate.primarySubjectHash))) {
      throw new Error(`${kind} is not bound to the exact multiplayer identities`)
    }
  }
}

/**
 * Serializes the irreversible boundary before the authorized canary mutation.
 * Once this succeeds, recovery is roll-forward-only even if the following mutation fails.
 */
export async function recordDeploymentFirstTargetWriteBoundary(
  database: D1Database,
  identity: DeploymentReleaseIdentity,
  input: DeploymentReleaseFirstTargetWrite,
  now = new Date(),
) {
  const statements = firstTargetWriteDefinitions(identity, input, now)
  const results = await database.batch(
    statements.map((statement) => database.prepare(statement.sql).bind(...statement.values)),
  )
  if (results.some((result) => !result.success)) throw new Error("first target write boundary failed")
  const state = await requireDeploymentReleaseState(database, identity)
  if (
    state.operationId !== input.operationId ||
    state.previousStateRevision !== input.expectedStateRevision ||
    state.stateRevision !== input.expectedStateRevision + 1 ||
    state.phase !== "canary" ||
    state.phaseRevision !== input.expectedPhaseRevision + 1 ||
    state.transitionKind !== "first_target_write" ||
    state.firstTargetWriteAt === null
  ) {
    throw new Error("first target write boundary lost its compare-and-swap")
  }
  return state
}

function verifyStateIdentity(
  state: DeploymentReleaseState | null,
  expected: DeploymentReleaseIdentity,
  missingMessage = "deployment release state is not initialized",
) {
  if (!state) throw new Error(missingMessage)
  for (const [name, value] of Object.entries(expected)) {
    if (state[name as keyof DeploymentReleaseIdentity] !== value) {
      throw new Error(`deployment release state ${name} does not match this Worker build`)
    }
  }
  if (!DEPLOYMENT_RELEASE_PHASES.includes(state.phase)) throw new Error("deployment release state has an unknown phase")
  if (
    !Number.isSafeInteger(state.phaseRevision) ||
    state.phaseRevision < 0 ||
    !Number.isSafeInteger(state.stateRevision) ||
    state.stateRevision < 0
  )
    throw new Error("deployment release state has an invalid revision")
  return state
}

const RELEASE_STATE_COLUMNS = `select
  "release"."deploymentId", "release"."releaseSequence", "release"."releaseId",
  "release"."workerBuildId", "release"."platformVersionId", "release"."browserBuildId", "release"."relayBuildId",
  "release"."authConfigurationId", "release"."requestLimiterNamespaceId",
  "release"."adapterProfile", "release"."productPosture", "release"."sandboxPosture",
  "release"."serviceManifestId", "state"."stateRevision", "state"."operationId",
  "state"."previousStateRevision", "state"."restoredStateRevision", "state"."transitionKind",
  "state"."phase", "state"."phaseRevision", "state"."firstTargetWriteAt", "state"."createdAt"`

const RELEASE_STATE_FROM_HISTORY = `from "deploymentReleaseStateHistory" as "state"
  join "deploymentRelease" as "release"
    on "release"."deploymentId" = "state"."deploymentId"
    and "release"."releaseId" = "state"."releaseId"`

const RELEASE_STATE_FROM_ACTIVE = `from "deploymentReleaseActive" as "active"
  join "deploymentReleaseStateHistory" as "state"
    on "state"."deploymentId" = "active"."deploymentId"
    and "state"."stateRevision" = "active"."stateRevision"
  join "deploymentRelease" as "release"
    on "release"."deploymentId" = "state"."deploymentId"
    and "release"."releaseId" = "state"."releaseId"`

export async function requireDeploymentReleaseCandidate(
  database: D1Database,
  expected: DeploymentReleaseIdentity,
  transition?: DeploymentReleaseTransition,
) {
  assertIdentity(expected)
  if (transition) assertTransition(expected, transition)
  const stateRevision = transition ? transition.previousStateRevision + 1 : 0
  const operationId = transition?.operationId ?? `initialize:${expected.releaseId}`
  return requireDeploymentReleaseCandidateAtRevision(database, expected, stateRevision, operationId)
}

export async function requireDeploymentReleaseCandidateAtRevision(
  database: D1Database,
  expected: DeploymentReleaseIdentity,
  stateRevision: number,
  operationId: string,
) {
  assertIdentity(expected)
  if (!Number.isSafeInteger(stateRevision) || stateRevision < 0) {
    throw new Error("candidate state revision must be a non-negative integer")
  }
  if (!IDENTIFIER.test(operationId)) throw new Error("candidate operation ID must be an explicit identifier")
  const state = await database
    .prepare(
      `${RELEASE_STATE_COLUMNS}
    ${RELEASE_STATE_FROM_HISTORY}
    where "state"."deploymentId" = ? and "state"."stateRevision" = ?
      and "state"."operationId" = ? and "state"."releaseId" = ?`,
    )
    .bind(expected.deploymentId, stateRevision, operationId, expected.releaseId)
    .first<DeploymentReleaseState>()
  const verified = verifyStateIdentity(state, expected, "deployment release candidate was not registered")
  if (verified.phase !== "locked" || verified.phaseRevision !== 0 || verified.firstTargetWriteAt !== null) {
    throw new Error("deployment release candidate is not locked and write-free")
  }
  return verified
}

export async function requireDeploymentReleaseState(
  database: D1Database,
  expected: DeploymentReleaseIdentity,
): Promise<DeploymentReleaseState> {
  assertIdentity(expected)
  const state = await database
    .prepare(
      `${RELEASE_STATE_COLUMNS}
    ${RELEASE_STATE_FROM_ACTIVE}
    where "active"."singleton" = 1`,
    )
    .first<DeploymentReleaseState>()
  return verifyStateIdentity(state, expected)
}
