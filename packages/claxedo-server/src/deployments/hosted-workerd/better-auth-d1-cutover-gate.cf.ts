import type { D1Database } from "@cloudflare/workers-types"

import {
  advanceDeploymentReleasePhase,
  recordDeploymentFirstTargetWriteBoundary,
  requireDeploymentReleaseState,
  type DeploymentReleaseIdentity,
  type DeploymentReleasePhase,
  type DeploymentReleaseState,
} from "./better-auth-d1-release-state.cf"

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const SHA256 = /^sha256:[0-9a-f]{64}$/

export const PROVIDER_SYNC_EVIDENCE_KINDS = [
  "callback_capture_ready",
  "callback_inbox_drained",
  "authority_reconciled",
  "billing_closure_absent",
  "polar_reconciled",
  "paired_backup_verified",
] as const

export const LOCKED_EVIDENCE_KINDS = ["migration_conservation_verified", "greenfield_source_absence_verified"] as const

export const MULTIPLAYER_VALIDATION_EVIDENCE_KINDS = [
  "private_session_verified",
  "stream_verified",
  "revocation_verified",
  "wrong_org_verified",
  "replay_verified",
  "outage_verified",
] as const

export type DeploymentAdmissionBinding = Readonly<{
  deploymentId: string
  releaseId: string
  workerBuildId: string
  platformVersionId: string
  browserBuildId: string
  relayBuildId: string
  authConfigurationId: string
  adapterProfile: DeploymentReleaseIdentity["adapterProfile"]
  productPosture: DeploymentReleaseIdentity["productPosture"]
  sandboxPosture: DeploymentReleaseIdentity["sandboxPosture"]
  serviceManifestId: string
  stateRevision: number
  phase: DeploymentReleasePhase
  phaseRevision: number
}>

const ADMISSION_BINDING_KEYS = [
  "deploymentId",
  "releaseId",
  "workerBuildId",
  "platformVersionId",
  "browserBuildId",
  "relayBuildId",
  "authConfigurationId",
  "adapterProfile",
  "productPosture",
  "sandboxPosture",
  "serviceManifestId",
  "stateRevision",
  "phase",
  "phaseRevision",
] as const satisfies readonly (keyof DeploymentAdmissionBinding)[]

export type DeploymentCanaryAdmission = Readonly<{
  receiptId: string
  operationId: string
  operatorSubjectHash: string
  canaryIdentityHash: string
  journeyId: string
  expectedStateRevision: number
  expectedPhaseRevision: number
}>

export type DeploymentCutoverEvidence =
  | Readonly<{
      kind: "migration_conservation_verified"
      receiptId: string
      operationId: string
      sourceSnapshotId: string
      evidenceSha256: string
      sourceSha256: string
    }>
  | Readonly<{
      kind: "greenfield_source_absence_verified"
      receiptId: string
      operationId: string
      targetAbsenceSha256: string
      deploymentManifestSha256: string
    }>
  | Readonly<{
      kind: "canary_journey_complete"
      receiptId: string
      operationId: string
      canaryIdentityHash: string
      journeyId: string
    }>
  | Readonly<{
      kind: "callback_capture_ready" | "billing_closure_absent"
      receiptId: string
      operationId: string
    }>
  | Readonly<{
      kind: "callback_inbox_drained" | "authority_reconciled" | "polar_reconciled"
      receiptId: string
      operationId: string
      observedCount: 0
    }>
  | Readonly<{
      kind: "paired_backup_verified"
      receiptId: string
      operationId: string
      recoveryEpoch: string
      authBackupSha256: string
      controlPlaneBackupSha256: string
    }>
  | Readonly<{
      kind: "multiplayer_identity"
      receiptId: string
      operationId: string
      slot: 1 | 2
      identityHash: string
    }>
  | Readonly<{
      kind: (typeof MULTIPLAYER_VALIDATION_EVIDENCE_KINDS)[number]
      receiptId: string
      operationId: string
      firstIdentityHash: string
      secondIdentityHash: string
    }>

export type DeploymentOperation =
  | Readonly<{ kind: "probe"; probe: "health" | "descriptor" | "migration_status" | "release_status" }>
  | Readonly<{
      kind: "canary_journey"
      canaryIdentityHash: string
      journeyId: string
      access: "read" | "mutation"
      mutationOperationId?: string
    }>
  | Readonly<{
      kind: "provider_sync"
      operation:
        | "callback_capture"
        | "callback_drain"
        | "authority_reconcile"
        | "billing_closure"
        | "polar_reconcile"
        | "paired_backup"
    }>
  | Readonly<{
      kind: "multiplayer_validation"
      operation: "private_session" | "stream" | "revocation" | "wrong_org" | "replay" | "outage"
      identityHash: string
    }>
  | Readonly<{ kind: "ordinary" | "native" | "service" | "background" }>

export type DeploymentOperationEnvelope = Readonly<{
  binding: DeploymentAdmissionBinding
  operation: DeploymentOperation
}>

type CutoverEvidenceRow = {
  evidenceKind: string
  evidenceSlot: number
  primarySubjectHash: string | null
  secondarySubjectHash: string | null
  observedCount: number | null
  evidenceReference: string | null
  recoveryEpoch: string | null
  artifactSha256: string | null
  secondaryArtifactSha256: string | null
}

type CanaryAdmissionRow = {
  receiptId: string
  operationId: string
  canaryIdentityHash: string
  journeyId: string
  sourceStateRevision: number
  sourcePhaseRevision: number
}

function assertIdentifier(name: string, value: string) {
  if (!IDENTIFIER.test(value)) throw new Error(`${name} must be an explicit 8-128 character identifier`)
}

function assertHash(name: string, value: string) {
  if (!SHA256.test(value)) throw new Error(`${name} must be a lowercase SHA-256 identity`)
}

function assertRevision(name: string, value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
}

function identityColumns(prefix = "release") {
  return `${prefix}."deploymentId", ${prefix}."releaseId", ${prefix}."workerBuildId", ${prefix}."platformVersionId",
    ${prefix}."browserBuildId", ${prefix}."relayBuildId", ${prefix}."authConfigurationId", ${prefix}."adapterProfile",
    ${prefix}."productPosture", ${prefix}."sandboxPosture", ${prefix}."serviceManifestId"`
}

function identityValues(identity: DeploymentReleaseIdentity) {
  return [
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
  ] as const
}

function exactIdentityPredicate(prefix = "release") {
  return [
    "deploymentId",
    "releaseId",
    "workerBuildId",
    "platformVersionId",
    "browserBuildId",
    "relayBuildId",
    "authConfigurationId",
    "adapterProfile",
    "productPosture",
    "sandboxPosture",
    "serviceManifestId",
  ]
    .map((column) => `${prefix}."${column}" = ?`)
    .join(" and ")
}

export function deploymentAdmissionBinding(state: DeploymentReleaseState): DeploymentAdmissionBinding {
  return Object.freeze({
    deploymentId: state.deploymentId,
    releaseId: state.releaseId,
    workerBuildId: state.workerBuildId,
    platformVersionId: state.platformVersionId,
    browserBuildId: state.browserBuildId,
    relayBuildId: state.relayBuildId,
    authConfigurationId: state.authConfigurationId,
    adapterProfile: state.adapterProfile,
    productPosture: state.productPosture,
    sandboxPosture: state.sandboxPosture,
    serviceManifestId: state.serviceManifestId,
    stateRevision: state.stateRevision,
    phase: state.phase,
    phaseRevision: state.phaseRevision,
  })
}

function requireExactBinding(state: DeploymentReleaseState, binding: DeploymentAdmissionBinding) {
  const current = deploymentAdmissionBinding(state)
  for (const name of ADMISSION_BINDING_KEYS) {
    if (binding[name] !== current[name]) {
      throw new Error(`deployment operation ${name} is stale or belongs to a different release`)
    }
  }
}

export async function provisionDeploymentCanaryAdmission(
  database: D1Database,
  identity: DeploymentReleaseIdentity,
  input: DeploymentCanaryAdmission,
  now = new Date(),
) {
  for (const [name, value] of [
    ["receiptId", input.receiptId],
    ["operationId", input.operationId],
    ["journeyId", input.journeyId],
  ] as const)
    assertIdentifier(name, value)
  assertHash("operatorSubjectHash", input.operatorSubjectHash)
  assertHash("canaryIdentityHash", input.canaryIdentityHash)
  assertRevision("expectedStateRevision", input.expectedStateRevision)
  assertRevision("expectedPhaseRevision", input.expectedPhaseRevision)
  const result = await database
    .prepare(
      `insert into "deploymentCutoverCanaryAdmission" (
    "deploymentId", "releaseId", "workerBuildId", "platformVersionId", "browserBuildId", "relayBuildId",
    "authConfigurationId", "adapterProfile", "productPosture", "sandboxPosture", "serviceManifestId",
    "sourceStateRevision", "sourcePhaseRevision", "receiptId", "operationId", "operatorSubjectHash",
    "canaryIdentityHash", "journeyId", "createdAt"
  )
  select ${identityColumns()}, state."stateRevision", state."phaseRevision", ?, ?, ?, ?, ?, ?
  from "deploymentReleaseActive" as active
  join "deploymentReleaseStateHistory" as state
    on state."deploymentId" = active."deploymentId" and state."stateRevision" = active."stateRevision"
  join "deploymentRelease" as release
    on release."deploymentId" = state."deploymentId" and release."releaseId" = state."releaseId"
  where active."singleton" = 1 and state."phase" = 'locked' and state."firstTargetWriteAt" is null
    and state."stateRevision" = ? and state."phaseRevision" = ? and ${exactIdentityPredicate()}
    and (
      exists (
        select 1 from "deploymentCutoverEvidenceReceipt" as evidence
        where evidence."deploymentId" = release."deploymentId" and evidence."releaseId" = release."releaseId"
          and evidence."workerBuildId" = release."workerBuildId"
          and evidence."platformVersionId" = release."platformVersionId"
          and evidence."browserBuildId" = release."browserBuildId"
          and evidence."relayBuildId" = release."relayBuildId"
          and evidence."authConfigurationId" = release."authConfigurationId"
          and evidence."adapterProfile" = release."adapterProfile"
          and evidence."productPosture" = release."productPosture"
          and evidence."sandboxPosture" = release."sandboxPosture"
          and evidence."serviceManifestId" = release."serviceManifestId"
          and evidence."evidenceKind" in ('migration_conservation_verified', 'greenfield_source_absence_verified')
      ) or (
        state."transitionKind" in ('locked_replacement', 'open_rollforward')
        and state."previousStateRevision" is not null
        and exists (
          select 1 from "deploymentReleaseStateHistory" as predecessor
          join "deploymentRelease" as predecessorRelease
            on predecessorRelease."deploymentId" = predecessor."deploymentId"
            and predecessorRelease."releaseId" = predecessor."releaseId"
          where predecessor."deploymentId" = state."deploymentId"
            and predecessor."stateRevision" = state."previousStateRevision"
            and predecessorRelease."releaseSequence" < release."releaseSequence"
            and predecessorRelease."adapterProfile" = release."adapterProfile"
            and predecessorRelease."productPosture" = release."productPosture"
            and predecessorRelease."sandboxPosture" = release."sandboxPosture"
        )
      )
    )
  on conflict do nothing`,
    )
    .bind(
      input.receiptId,
      input.operationId,
      input.operatorSubjectHash,
      input.canaryIdentityHash,
      input.journeyId,
      now.toISOString(),
      input.expectedStateRevision,
      input.expectedPhaseRevision,
      ...identityValues(identity),
    )
    .run()
  if (!result.success) throw new Error("canary admission persistence failed")
  const row = await requireDeploymentCanaryAdmission(database, identity)
  if (
    row.receiptId !== input.receiptId ||
    row.operationId !== input.operationId ||
    row.canaryIdentityHash !== input.canaryIdentityHash ||
    row.journeyId !== input.journeyId ||
    row.sourceStateRevision !== input.expectedStateRevision ||
    row.sourcePhaseRevision !== input.expectedPhaseRevision
  )
    throw new Error("another canary journey already owns this release")
  return row
}

export async function requireDeploymentCanaryAdmission(
  database: D1Database,
  identity: DeploymentReleaseIdentity,
) {
  const row = await database
    .prepare(
      `select admission."receiptId", admission."operationId",
    admission."canaryIdentityHash", admission."journeyId", admission."sourceStateRevision", admission."sourcePhaseRevision"
  from "deploymentCutoverCanaryAdmission" as admission
  join "deploymentRelease" as release
    on release."deploymentId" = admission."deploymentId" and release."releaseId" = admission."releaseId"
  where ${exactIdentityPredicate()}`,
    )
    .bind(...identityValues(identity))
    .first<CanaryAdmissionRow>()
  if (!row) throw new Error("the exact release has no deployment-authorized canary admission")
  return row
}

export async function beginDeploymentCanary(
  database: D1Database,
  identity: DeploymentReleaseIdentity,
  input: DeploymentCanaryAdmission,
  now = new Date(),
) {
  await provisionDeploymentCanaryAdmission(database, identity, input, now)
  return advanceDeploymentReleasePhase(
    database,
    identity,
    {
      operationId: input.operationId,
      expectedStateRevision: input.expectedStateRevision,
      expectedPhase: "locked",
      expectedPhaseRevision: input.expectedPhaseRevision,
      targetPhase: "canary",
    },
    now,
  )
}

function evidenceValues(evidence: DeploymentCutoverEvidence) {
  if (evidence.kind === "greenfield_source_absence_verified") {
    assertHash("targetAbsenceSha256", evidence.targetAbsenceSha256)
    assertHash("deploymentManifestSha256", evidence.deploymentManifestSha256)
    return {
      slot: 0,
      primary: null,
      secondary: null,
      count: null,
      reference: "greenfield-source-absence-v1",
      epoch: null,
      first: evidence.targetAbsenceSha256,
      second: evidence.deploymentManifestSha256,
    }
  }
  if (evidence.kind === "migration_conservation_verified") {
    assertIdentifier("sourceSnapshotId", evidence.sourceSnapshotId)
    assertHash("evidenceSha256", evidence.evidenceSha256)
    assertHash("sourceSha256", evidence.sourceSha256)
    return {
      slot: 0,
      primary: null,
      secondary: null,
      count: null,
      reference: evidence.sourceSnapshotId,
      epoch: null,
      first: evidence.evidenceSha256,
      second: evidence.sourceSha256,
    }
  }
  if (evidence.kind === "canary_journey_complete") {
    assertHash("canaryIdentityHash", evidence.canaryIdentityHash)
    assertIdentifier("journeyId", evidence.journeyId)
    return {
      slot: 0,
      primary: evidence.canaryIdentityHash,
      secondary: null,
      count: null,
      reference: null,
      epoch: null,
      first: null,
      second: null,
    }
  }
  if (evidence.kind === "multiplayer_identity") {
    assertHash("identityHash", evidence.identityHash)
    return {
      slot: evidence.slot,
      primary: evidence.identityHash,
      secondary: null,
      count: null,
      reference: null,
      epoch: null,
      first: null,
      second: null,
    }
  }
  if ("firstIdentityHash" in evidence) {
    assertHash("firstIdentityHash", evidence.firstIdentityHash)
    assertHash("secondIdentityHash", evidence.secondIdentityHash)
    if (evidence.firstIdentityHash === evidence.secondIdentityHash)
      throw new Error("multiplayer evidence requires two identities")
    return {
      slot: 0,
      primary: evidence.firstIdentityHash,
      secondary: evidence.secondIdentityHash,
      count: null,
      reference: null,
      epoch: null,
      first: null,
      second: null,
    }
  }
  if (evidence.kind === "paired_backup_verified") {
    assertIdentifier("recoveryEpoch", evidence.recoveryEpoch)
    assertHash("authBackupSha256", evidence.authBackupSha256)
    assertHash("controlPlaneBackupSha256", evidence.controlPlaneBackupSha256)
    return {
      slot: 0,
      primary: null,
      secondary: null,
      count: null,
      reference: null,
      epoch: evidence.recoveryEpoch,
      first: evidence.authBackupSha256,
      second: evidence.controlPlaneBackupSha256,
    }
  }
  const count = "observedCount" in evidence ? evidence.observedCount : null
  if (count !== null && count !== 0) throw new Error(`${evidence.kind} must attest zero unresolved rows`)
  return { slot: 0, primary: null, secondary: null, count, reference: null, epoch: null, first: null, second: null }
}

function expectedEvidencePhase(kind: DeploymentCutoverEvidence["kind"]): DeploymentReleasePhase {
  if (LOCKED_EVIDENCE_KINDS.some((candidate) => candidate === kind)) return "locked"
  if (kind === "canary_journey_complete") return "canary"
  if (PROVIDER_SYNC_EVIDENCE_KINDS.some((candidate) => candidate === kind)) return "provider_sync"
  return "multiplayer_validation"
}

export async function recordDeploymentCutoverEvidence(
  database: D1Database,
  identity: DeploymentReleaseIdentity,
  binding: DeploymentAdmissionBinding,
  evidence: DeploymentCutoverEvidence,
  now = new Date(),
) {
  assertIdentifier("receiptId", evidence.receiptId)
  assertIdentifier("operationId", evidence.operationId)
  const state = await requireDeploymentReleaseState(database, identity)
  requireExactBinding(state, binding)
  const expectedPhase = expectedEvidencePhase(evidence.kind)
  if (state.phase !== expectedPhase) throw new Error(`${evidence.kind} evidence is not accepted during ${state.phase}`)
  if (evidence.kind === "billing_closure_absent" && state.productPosture !== "user-deployed") {
    throw new Error("billing-closure evidence is only valid for the user-deployed product")
  }
  if (evidence.kind === "polar_reconciled" && state.productPosture !== "claxedo-hosted") {
    throw new Error("Polar evidence is only valid for the Claxedo-hosted product")
  }
  if (evidence.kind === "canary_journey_complete") {
    if (state.firstTargetWriteAt === null)
      throw new Error("canary completion requires the serialized first-write boundary")
    const admission = await requireDeploymentCanaryAdmission(database, identity)
    if (admission.canaryIdentityHash !== evidence.canaryIdentityHash || admission.journeyId !== evidence.journeyId) {
      throw new Error("canary completion does not belong to the admitted journey")
    }
  }
  const values = evidenceValues(evidence)
  const result = await database
    .prepare(
      `insert into "deploymentCutoverEvidenceReceipt" (
    "deploymentId", "releaseId", "workerBuildId", "platformVersionId", "browserBuildId", "relayBuildId",
    "authConfigurationId", "adapterProfile", "productPosture", "sandboxPosture", "serviceManifestId",
    "sourceStateRevision", "sourcePhaseRevision", "receiptId", "operationId", "evidenceKind", "evidenceSlot",
    "primarySubjectHash", "secondarySubjectHash", "observedCount", "evidenceReference", "recoveryEpoch", "artifactSha256",
    "secondaryArtifactSha256", "createdAt"
  ) select ${identityColumns()}, state."stateRevision", state."phaseRevision", ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  from "deploymentReleaseActive" as active
  join "deploymentReleaseStateHistory" as state
    on state."deploymentId" = active."deploymentId" and state."stateRevision" = active."stateRevision"
  join "deploymentRelease" as release
    on release."deploymentId" = state."deploymentId" and release."releaseId" = state."releaseId"
  where active."singleton" = 1 and state."stateRevision" = ? and state."phaseRevision" = ?
    and state."phase" = ? and ${exactIdentityPredicate()}
  on conflict do nothing`,
    )
    .bind(
      evidence.receiptId,
      evidence.operationId,
      evidence.kind,
      values.slot,
      values.primary,
      values.secondary,
      values.count,
      values.reference,
      values.epoch,
      values.first,
      values.second,
      now.toISOString(),
      state.stateRevision,
      state.phaseRevision,
      expectedPhase,
      ...identityValues(identity),
    )
    .run()
  if (!result.success) throw new Error("cutover evidence persistence failed")
  const persisted = await database
    .prepare(
      `select "evidenceKind", "evidenceSlot", "primarySubjectHash", "secondarySubjectHash", "observedCount",
        "evidenceReference", "recoveryEpoch", "artifactSha256", "secondaryArtifactSha256"
    from "deploymentCutoverEvidenceReceipt"
    where "deploymentId" = ? and "releaseId" = ? and "receiptId" = ? and "operationId" = ?`,
    )
    .bind(identity.deploymentId, identity.releaseId, evidence.receiptId, evidence.operationId)
    .first<CutoverEvidenceRow>()
  if (
    !persisted ||
    persisted.evidenceKind !== evidence.kind ||
    persisted.evidenceSlot !== values.slot ||
    persisted.primarySubjectHash !== values.primary ||
    persisted.secondarySubjectHash !== values.secondary ||
    persisted.observedCount !== values.count ||
    persisted.evidenceReference !== values.reference ||
    persisted.recoveryEpoch !== values.epoch ||
    persisted.artifactSha256 !== values.first ||
    persisted.secondaryArtifactSha256 !== values.second
  ) {
    throw new Error("cutover evidence replay conflicts with the persisted receipt")
  }
  return persisted
}

export async function recordDeploymentCanaryFirstWrite(
  database: D1Database,
  identity: DeploymentReleaseIdentity,
  envelope: DeploymentOperationEnvelope,
  now = new Date(),
) {
  if (
    envelope.operation.kind !== "canary_journey" ||
    envelope.operation.access !== "mutation" ||
    !envelope.operation.mutationOperationId
  )
    throw new Error("a canary mutation operation is required")
  const state = await requireDeploymentReleaseState(database, identity)
  const isExactRetry =
    state.transitionKind === "first_target_write" &&
    state.operationId === envelope.operation.mutationOperationId &&
    state.previousStateRevision === envelope.binding.stateRevision &&
    state.phase === "canary"
  if (!isExactRetry) requireExactBinding(state, envelope.binding)
  const admission = await requireDeploymentCanaryAdmission(database, identity)
  if (
    admission.canaryIdentityHash !== envelope.operation.canaryIdentityHash ||
    admission.journeyId !== envelope.operation.journeyId
  )
    throw new Error("canary mutation is not the admitted journey")
  const boundary = isExactRetry
    ? state
    : await recordDeploymentFirstTargetWriteBoundary(
        database,
        identity,
        {
          operationId: envelope.operation.mutationOperationId,
          expectedStateRevision: envelope.binding.stateRevision,
          expectedPhaseRevision: envelope.binding.phaseRevision,
        },
        now,
      )
  const boundaryBinding = deploymentAdmissionBinding(boundary)
  await recordFirstWriteEvidence(
    database,
    identity,
    boundaryBinding,
    admission,
    envelope.operation.mutationOperationId,
    now,
  )
  return boundary
}

async function recordFirstWriteEvidence(
  database: D1Database,
  identity: DeploymentReleaseIdentity,
  binding: DeploymentAdmissionBinding,
  admission: CanaryAdmissionRow,
  operationId: string,
  now: Date,
) {
  const receiptId = operationId
  assertIdentifier("first-write receiptId", receiptId)
  const result = await database
    .prepare(
      `insert into "deploymentCutoverEvidenceReceipt" (
    "deploymentId", "releaseId", "workerBuildId", "platformVersionId", "browserBuildId", "relayBuildId",
    "authConfigurationId", "adapterProfile", "productPosture", "sandboxPosture", "serviceManifestId",
    "sourceStateRevision", "sourcePhaseRevision", "receiptId", "operationId", "evidenceKind", "evidenceSlot",
    "primarySubjectHash", "secondarySubjectHash", "observedCount", "recoveryEpoch", "artifactSha256",
    "secondaryArtifactSha256", "createdAt"
  ) select ${identityColumns()}, state."stateRevision", state."phaseRevision", ?, ?, 'canary_first_write', 0,
    ?, null, null, null, null, null, ?
  from "deploymentReleaseActive" as active
  join "deploymentReleaseStateHistory" as state
    on state."deploymentId" = active."deploymentId" and state."stateRevision" = active."stateRevision"
  join "deploymentRelease" as release
    on release."deploymentId" = state."deploymentId" and release."releaseId" = state."releaseId"
  where active."singleton" = 1 and state."phase" = 'canary' and state."firstTargetWriteAt" is not null
    and state."stateRevision" = ? and state."phaseRevision" = ? and ${exactIdentityPredicate()}
  on conflict do nothing`,
    )
    .bind(
      receiptId,
      operationId,
      admission.canaryIdentityHash,
      now.toISOString(),
      binding.stateRevision,
      binding.phaseRevision,
      ...identityValues(identity),
    )
    .run()
  if (!result.success) throw new Error("canary first-write evidence persistence failed")
  const persisted = await database
    .prepare(
      `select "primarySubjectHash" from "deploymentCutoverEvidenceReceipt"
    where "deploymentId" = ? and "releaseId" = ? and "receiptId" = ? and "operationId" = ?
      and "evidenceKind" = 'canary_first_write' and "evidenceSlot" = 0`,
    )
    .bind(identity.deploymentId, identity.releaseId, receiptId, operationId)
    .first<{ primarySubjectHash: string }>()
  if (persisted?.primarySubjectHash !== admission.canaryIdentityHash) {
    throw new Error("canary first-write evidence conflicts with a persisted receipt")
  }
}

export async function advanceDeploymentCutover(
  database: D1Database,
  identity: DeploymentReleaseIdentity,
  input: Readonly<{
    operationId: string
    binding: DeploymentAdmissionBinding
    targetPhase: "provider_sync" | "multiplayer_validation" | "open"
  }>,
  now = new Date(),
) {
  const state = await requireDeploymentReleaseState(database, identity)
  requireExactBinding(state, input.binding)
  const expected =
    input.targetPhase === "provider_sync"
      ? "canary"
      : input.targetPhase === "multiplayer_validation"
        ? "provider_sync"
        : "multiplayer_validation"
  if (state.phase !== expected) throw new Error(`deployment is not ready to advance from ${expected}`)
  return advanceDeploymentReleasePhase(
    database,
    identity,
    {
      operationId: input.operationId,
      expectedStateRevision: state.stateRevision,
      expectedPhase: expected,
      expectedPhaseRevision: state.phaseRevision,
      targetPhase: input.targetPhase,
    },
    now,
  )
}

export async function admitDeploymentOperation(
  database: D1Database,
  identity: DeploymentReleaseIdentity,
  envelope: DeploymentOperationEnvelope,
) {
  const state = await requireDeploymentReleaseState(database, identity)
  requireExactBinding(state, envelope.binding)
  const operation = envelope.operation
  if (state.phase === "open") return Object.freeze({ allowed: true as const, state })
  if (operation.kind === "probe") return Object.freeze({ allowed: true as const, state })
  if (state.phase === "locked") throw new Error("locked admits non-mutating probes only")
  if (state.phase === "canary" && operation.kind === "canary_journey") {
    const admission = await requireDeploymentCanaryAdmission(database, identity)
    if (admission.canaryIdentityHash !== operation.canaryIdentityHash || admission.journeyId !== operation.journeyId) {
      throw new Error("request does not belong to the exclusive canary journey")
    }
    if (operation.access === "mutation" && state.firstTargetWriteAt === null) {
      throw new Error("canary mutation must cross the serialized first-write boundary")
    }
    return Object.freeze({ allowed: true as const, state })
  }
  if (state.phase === "provider_sync" && operation.kind === "provider_sync") {
    if (operation.operation === "billing_closure" && state.productPosture !== "user-deployed") {
      throw new Error("billing closure is not a Claxedo-hosted provider-sync operation")
    }
    if (operation.operation === "polar_reconcile" && state.productPosture !== "claxedo-hosted") {
      throw new Error("Polar reconciliation is not a user-deployed provider-sync operation")
    }
    return Object.freeze({ allowed: true as const, state })
  }
  if (state.phase === "multiplayer_validation" && operation.kind === "multiplayer_validation") {
    const identityRow = await database
      .prepare(
        `select 1 as present from "deploymentCutoverEvidenceReceipt"
      where "deploymentId" = ? and "releaseId" = ? and "evidenceKind" = 'multiplayer_identity'
        and "primarySubjectHash" = ?`,
      )
      .bind(identity.deploymentId, identity.releaseId, operation.identityHash)
      .first<{ present: number }>()
    if (identityRow?.present !== 1)
      throw new Error("multiplayer request identity is not one of the two release-bound identities")
    return Object.freeze({ allowed: true as const, state })
  }
  throw new Error(`${operation.kind} is denied during ${state.phase}`)
}
