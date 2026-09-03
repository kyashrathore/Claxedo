import path from "node:path"
import { fileURLToPath } from "node:url"

import { MULTIPLAYER_VALIDATION_EVIDENCE_KINDS } from "../../src/deployments/hosted-workerd/better-auth-d1-cutover-gate.cf"
import { LOCKED_BROWSER_BUILD_ID } from "../../src/deployments/hosted-workerd/better-auth-d1-release-state.cf"
import {
  betterAuthD1ReleaseInputs,
  fetchReleaseProbe,
  type BetterAuthD1ReleaseEnvironment,
} from "./release-better-auth-d1"

const ACTIONS = [
  "status",
  "record-greenfield-source-absence-verified",
  "record-migration-conservation-verified",
  "begin-canary",
  "record-canary-complete",
  "advance-provider-sync",
  "record-callback-capture-ready",
  "record-callback-inbox-drained",
  "record-authority-reconciled",
  "record-billing-closure-absent",
  "record-polar-reconciled",
  "record-paired-backup-verified",
  "advance-multiplayer-validation",
  "register-multiplayer-identity-1",
  "register-multiplayer-identity-2",
  ...MULTIPLAYER_VALIDATION_EVIDENCE_KINDS.map((kind) => `record-${kind.replaceAll("_", "-")}` as const),
  "open",
] as const

export type BetterAuthD1CutoverAction = (typeof ACTIONS)[number]

type OperatorRelease = {
  deploymentId: string
  releaseId: string
  workerBuildId: string
  platformVersionId: string
  browserBuildId: string
  relayBuildId: string
  authConfigurationId: string
  adapterProfile: "better-auth-d1"
  productPosture: "claxedo-hosted" | "user-deployed"
  sandboxPosture: "control-plane-only" | "full-hosted"
  serviceManifestId: string
  stateRevision: number
  phase: "locked" | "canary" | "provider_sync" | "multiplayer_validation" | "open"
  phaseRevision: number
}

export type BetterAuthD1OperatorRequest = Readonly<{
  method: "GET" | "POST"
  path: string
  body?: Readonly<Record<string, unknown>>
}>

function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required for the cutover operator`)
  return value
}

function receipt(env: NodeJS.ProcessEnv) {
  return {
    receiptId: required(env, "CLAXEDO_CUTOVER_RECEIPT_ID"),
    operationId: required(env, "CLAXEDO_CUTOVER_OPERATION_ID"),
  }
}

function validationKind(action: BetterAuthD1CutoverAction) {
  if (!action.startsWith("record-") || !action.endsWith("-verified")) return undefined
  const kind = action.slice("record-".length).replaceAll("-", "_")
  return MULTIPLAYER_VALIDATION_EVIDENCE_KINDS.find((candidate) => candidate === kind)
}

export function betterAuthD1OperatorRequest(
  action: BetterAuthD1CutoverAction,
  env: NodeJS.ProcessEnv,
  release: OperatorRelease,
): BetterAuthD1OperatorRequest {
  if (action === "status") return { method: "GET", path: "/__release/operator/status" }
  if (action === "begin-canary") {
    if (release.phase !== "locked") throw new Error("begin-canary requires the exact locked release")
    if (release.browserBuildId === LOCKED_BROWSER_BUILD_ID) {
      throw new Error("the locked-only Worker has no browser artifact and cannot admit a canary")
    }
    return {
      method: "POST",
      path: "/__release/operator/begin-canary",
      body: {
        ...receipt(env),
        binding: release,
        canaryIdentityHash: required(env, "CLAXEDO_CUTOVER_CANARY_IDENTITY_HASH"),
        journeyId: required(env, "CLAXEDO_CUTOVER_CANARY_JOURNEY_ID"),
      },
    }
  }
  if (action === "advance-provider-sync" || action === "advance-multiplayer-validation" || action === "open") {
    const targetPhase =
      action === "advance-provider-sync"
        ? "provider_sync"
        : action === "advance-multiplayer-validation"
          ? "multiplayer_validation"
          : "open"
    return {
      method: "POST",
      path: "/__release/operator/advance",
      body: { ...receipt(env), binding: release, targetPhase },
    }
  }
  const common = receipt(env)
  let evidence: Record<string, unknown>
  if (action === "record-greenfield-source-absence-verified")
    evidence = {
      ...common,
      kind: "greenfield_source_absence_verified",
      targetAbsenceSha256: required(env, "CLAXEDO_CUTOVER_TARGET_ABSENCE_SHA256"),
      deploymentManifestSha256: required(env, "CLAXEDO_CUTOVER_DEPLOYMENT_MANIFEST_SHA256"),
    }
  else if (action === "record-migration-conservation-verified")
    evidence = {
      ...common,
      kind: "migration_conservation_verified",
      sourceSnapshotId: required(env, "CLAXEDO_CUTOVER_SOURCE_SNAPSHOT_ID"),
      evidenceSha256: required(env, "CLAXEDO_CUTOVER_MIGRATION_EVIDENCE_SHA256"),
      sourceSha256: required(env, "CLAXEDO_CUTOVER_SOURCE_SHA256"),
    }
  else if (action === "record-canary-complete")
    evidence = {
      ...common,
      kind: "canary_journey_complete",
      canaryIdentityHash: required(env, "CLAXEDO_CUTOVER_CANARY_IDENTITY_HASH"),
      journeyId: required(env, "CLAXEDO_CUTOVER_CANARY_JOURNEY_ID"),
    }
  else if (action === "record-callback-capture-ready") evidence = { ...common, kind: "callback_capture_ready" }
  else if (action === "record-callback-inbox-drained")
    evidence = { ...common, kind: "callback_inbox_drained", observedCount: 0 }
  else if (action === "record-authority-reconciled")
    evidence = { ...common, kind: "authority_reconciled", observedCount: 0 }
  else if (action === "record-billing-closure-absent") evidence = { ...common, kind: "billing_closure_absent" }
  else if (action === "record-polar-reconciled") evidence = { ...common, kind: "polar_reconciled", observedCount: 0 }
  else if (action === "record-paired-backup-verified")
    evidence = {
      ...common,
      kind: "paired_backup_verified",
      recoveryEpoch: required(env, "CLAXEDO_CUTOVER_RECOVERY_EPOCH"),
      authBackupSha256: required(env, "CLAXEDO_CUTOVER_AUTH_BACKUP_SHA256"),
      controlPlaneBackupSha256: required(env, "CLAXEDO_CUTOVER_CONTROL_PLANE_BACKUP_SHA256"),
    }
  else if (action === "register-multiplayer-identity-1" || action === "register-multiplayer-identity-2") {
    const slot = action.endsWith("-1") ? 1 : 2
    evidence = {
      ...common,
      kind: "multiplayer_identity",
      slot,
      identityHash: required(env, `CLAXEDO_CUTOVER_MULTIPLAYER_IDENTITY_${slot}_HASH`),
    }
  } else {
    const kind = validationKind(action)
    if (!kind) throw new Error(`unsupported cutover action ${action}`)
    evidence = {
      ...common,
      kind,
      firstIdentityHash: required(env, "CLAXEDO_CUTOVER_MULTIPLAYER_IDENTITY_1_HASH"),
      secondIdentityHash: required(env, "CLAXEDO_CUTOVER_MULTIPLAYER_IDENTITY_2_HASH"),
    }
  }
  return { method: "POST", path: "/__release/operator/evidence", body: { ...evidence, binding: release } }
}

export function selectedBetterAuthD1CutoverAction(argv: readonly string[]) {
  const selected = ACTIONS.filter((action) => argv.includes(`--${action}`))
  if (selected.length !== 1)
    throw new Error(`select exactly one cutover action: ${ACTIONS.map((action) => `--${action}`).join(", ")}`)
  const action = selected[0]
  if (!action) throw new Error("the selected cutover action disappeared")
  return action
}

async function operatorFetch(apiOrigin: string, secret: string, request: BetterAuthD1OperatorRequest) {
  const response = await fetchReleaseProbe(`${apiOrigin}${request.path}`, {
    method: request.method,
    headers: {
      authorization: `Bearer ${secret}`,
      ...(request.body ? { "content-type": "application/json" } : {}),
    },
    ...(request.body ? { body: JSON.stringify(request.body) } : {}),
    signal: AbortSignal.timeout(15_000),
  })
  const body = (await response.json()) as { release?: OperatorRelease; error?: { code?: string } }
  if (!response.ok) throw new Error(`cutover operator rejected the request (${body.error?.code ?? response.status})`)
  return body
}

async function main() {
  const staging = process.argv.includes("--staging")
  const environment: BetterAuthD1ReleaseEnvironment = staging ? "staging" : "production"
  const action = selectedBetterAuthD1CutoverAction(process.argv)
  const releaseInput = betterAuthD1ReleaseInputs(process.env, environment)
  const operatorSecret = required(process.env, "CLAXEDO_RELEASE_OPERATOR_SECRET")
  if (operatorSecret.length < 32) throw new Error("CLAXEDO_RELEASE_OPERATOR_SECRET must contain at least 32 characters")
  const status = await operatorFetch(releaseInput.apiOrigin, operatorSecret, {
    method: "GET",
    path: "/__release/operator/status",
  })
  if (!status.release) throw new Error("operator status omitted the persisted release binding")
  if (action === "status") {
    process.stdout.write(`${JSON.stringify(status.release, null, 2)}\n`)
    return
  }
  const request = betterAuthD1OperatorRequest(action, process.env, status.release)
  const result = await operatorFetch(releaseInput.apiOrigin, operatorSecret, request)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) await main()
