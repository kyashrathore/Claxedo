import type { D1Database } from "@cloudflare/workers-types"
import {
  requestIsHttps,
  securityHeaderEntries,
  withSecurityHeaders,
} from "@claxedo/server-core/platform/http/security-headers"

import {
  MULTIPLAYER_VALIDATION_EVIDENCE_KINDS,
  advanceDeploymentCutover,
  admitDeploymentOperation,
  beginDeploymentCanary,
  deploymentAdmissionBinding,
  recordDeploymentCutoverEvidence,
  type DeploymentAdmissionBinding,
  type DeploymentCutoverEvidence,
} from "./better-auth-d1-cutover-gate.cf"
import { requireDeploymentReleaseState, type DeploymentReleaseIdentity } from "./better-auth-d1-release-state.cf"
import { requiredReleaseIdentifier } from "./better-auth-d1-release-identity.cf"

export type BetterAuthD1OperatorEnv = {
  AUTH_DB: D1Database
  CLAXEDO_RELEASE_OPERATOR_SECRET?: string
  BETTER_AUTH_SECRET?: string
  CLAXEDO_AUTH_INTROSPECTION_SECRET?: string
}

function secure(request: Request, response: Response) {
  return withSecurityHeaders(
    response,
    securityHeaderEntries({
      https: requestIsHttps({ url: request.url, header: (name) => request.headers.get(name) ?? undefined }),
    }),
  )
}

function withCors(request: Request, response: Response, appOrigin?: string) {
  if (appOrigin && request.headers.get("origin") === appOrigin) {
    const headers = new Headers(response.headers)
    headers.set("access-control-allow-origin", appOrigin)
    headers.set("access-control-allow-credentials", "true")
    headers.append("vary", "Origin")
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
  return response
}

function json(request: Request, body: unknown, status: number, appOrigin?: string) {
  return secure(request, withCors(request, Response.json(body, { status }), appOrigin))
}

export function assertOperatorSecretIsolation(env: BetterAuthD1OperatorEnv) {
  const operator = requiredReleaseIdentifier(env.CLAXEDO_RELEASE_OPERATOR_SECRET, "CLAXEDO_RELEASE_OPERATOR_SECRET")
  if (operator.length < 32) throw new Error("CLAXEDO_RELEASE_OPERATOR_SECRET must contain at least 32 characters")
  for (const name of ["BETTER_AUTH_SECRET", "CLAXEDO_AUTH_INTROSPECTION_SECRET"] as const) {
    if (operator === requiredReleaseIdentifier(env[name], name)) {
      throw new Error(`CLAXEDO_RELEASE_OPERATOR_SECRET must be distinct from ${name}`)
    }
  }
}

async function operatorAuthorized(request: Request, env: BetterAuthD1OperatorEnv) {
  const configured = requiredReleaseIdentifier(env.CLAXEDO_RELEASE_OPERATOR_SECRET, "CLAXEDO_RELEASE_OPERATOR_SECRET")
  if (configured.length < 32) throw new Error("CLAXEDO_RELEASE_OPERATOR_SECRET must contain at least 32 characters")
  const authorization = request.headers.get("authorization")
  if (!authorization?.startsWith("Bearer ")) return false
  const supplied = authorization.slice("Bearer ".length)
  const [expectedHash, suppliedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(configured)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied)),
  ])
  const expected = new Uint8Array(expectedHash)
  const observed = new Uint8Array(suppliedHash)
  let difference = expected.length ^ observed.length
  for (let index = 0; index < expected.length; index++) difference |= (expected[index] ?? 0) ^ (observed[index] ?? 0)
  return difference === 0
}

async function operatorSubjectHash(env: BetterAuthD1OperatorEnv) {
  const secret = requiredReleaseIdentifier(env.CLAXEDO_RELEASE_OPERATOR_SECRET, "CLAXEDO_RELEASE_OPERATOR_SECRET")
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)))
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

function objectBody(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("operator body must be an object")
  return value as Record<string, unknown>
}

function stringField(body: Record<string, unknown>, name: string) {
  if (typeof body[name] !== "string") throw new Error(`${name} must be a string`)
  return body[name]
}

function integerField(body: Record<string, unknown>, name: string) {
  const value = body[name]
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return value
}

function isMultiplayerValidationEvidenceKind(
  kind: string,
): kind is (typeof MULTIPLAYER_VALIDATION_EVIDENCE_KINDS)[number] {
  return MULTIPLAYER_VALIDATION_EVIDENCE_KINDS.some((candidate) => candidate === kind)
}

function isDeploymentReleasePhase(phase: string): phase is DeploymentAdmissionBinding["phase"] {
  return ["locked", "canary", "provider_sync", "multiplayer_validation", "open"].some(
    (candidate) => candidate === phase,
  )
}

function parseCutoverEvidence(value: unknown): DeploymentCutoverEvidence {
  const body = objectBody(value)
  const kind = stringField(body, "kind")
  const receiptId = stringField(body, "receiptId")
  const operationId = stringField(body, "operationId")
  if (kind === "greenfield_source_absence_verified")
    return {
      kind,
      receiptId,
      operationId,
      targetAbsenceSha256: stringField(body, "targetAbsenceSha256"),
      deploymentManifestSha256: stringField(body, "deploymentManifestSha256"),
    }
  if (kind === "migration_conservation_verified")
    return {
      kind,
      receiptId,
      operationId,
      sourceSnapshotId: stringField(body, "sourceSnapshotId"),
      evidenceSha256: stringField(body, "evidenceSha256"),
      sourceSha256: stringField(body, "sourceSha256"),
    }
  if (kind === "canary_journey_complete")
    return {
      kind,
      receiptId,
      operationId,
      canaryIdentityHash: stringField(body, "canaryIdentityHash"),
      journeyId: stringField(body, "journeyId"),
    }
  if (kind === "callback_capture_ready" || kind === "billing_closure_absent") return { kind, receiptId, operationId }
  if (kind === "callback_inbox_drained" || kind === "authority_reconciled" || kind === "polar_reconciled") {
    if (body.observedCount !== 0) throw new Error(`${kind} requires observedCount 0`)
    return { kind, receiptId, operationId, observedCount: 0 }
  }
  if (kind === "paired_backup_verified")
    return {
      kind,
      receiptId,
      operationId,
      recoveryEpoch: stringField(body, "recoveryEpoch"),
      authBackupSha256: stringField(body, "authBackupSha256"),
      controlPlaneBackupSha256: stringField(body, "controlPlaneBackupSha256"),
    }
  if (kind === "multiplayer_identity") {
    const slot = integerField(body, "slot")
    if (slot !== 1 && slot !== 2) throw new Error("multiplayer identity slot must be 1 or 2")
    return { kind, receiptId, operationId, slot, identityHash: stringField(body, "identityHash") }
  }
  if (isMultiplayerValidationEvidenceKind(kind))
    return {
      kind,
      receiptId,
      operationId,
      firstIdentityHash: stringField(body, "firstIdentityHash"),
      secondIdentityHash: stringField(body, "secondIdentityHash"),
    }
  throw new Error(`unsupported cutover evidence kind ${kind}`)
}

function parseAdmissionBinding(value: unknown): DeploymentAdmissionBinding {
  const body = objectBody(value)
  const adapterProfile = stringField(body, "adapterProfile")
  const productPosture = stringField(body, "productPosture")
  const sandboxPosture = stringField(body, "sandboxPosture")
  const phase = stringField(body, "phase")
  if (adapterProfile !== "better-auth-d1")
    throw new Error("invalid adapter profile binding")
  if (productPosture !== "claxedo-hosted" && productPosture !== "user-deployed")
    throw new Error("invalid product posture binding")
  if (sandboxPosture !== "control-plane-only" && sandboxPosture !== "full-hosted")
    throw new Error("invalid sandbox posture binding")
  if (!isDeploymentReleasePhase(phase)) throw new Error("invalid release phase binding")
  return {
    deploymentId: stringField(body, "deploymentId"),
    releaseId: stringField(body, "releaseId"),
    workerBuildId: stringField(body, "workerBuildId"),
    platformVersionId: stringField(body, "platformVersionId"),
    browserBuildId: stringField(body, "browserBuildId"),
    relayBuildId: stringField(body, "relayBuildId"),
    authConfigurationId: stringField(body, "authConfigurationId"),
    serviceManifestId: stringField(body, "serviceManifestId"),
    adapterProfile,
    productPosture,
    sandboxPosture,
    stateRevision: integerField(body, "stateRevision"),
    phase,
    phaseRevision: integerField(body, "phaseRevision"),
  }
}

export async function operatorResponse(
  request: Request,
  env: BetterAuthD1OperatorEnv,
  identity: DeploymentReleaseIdentity,
  appOrigin: string,
  url: URL,
  options: { canBeginCanary: boolean; expectedCanaryJourneyId?: string },
) {
  if (!url.pathname.startsWith("/__release/operator/")) return undefined
  if (!(await operatorAuthorized(request, env))) return json(request, { error: { code: "operator_unauthorized" } }, 401)
  if (url.pathname === "/__release/operator/status" && request.method === "GET") {
    const state = await requireDeploymentReleaseState(env.AUTH_DB, identity)
    return json(request, { release: deploymentAdmissionBinding(state) }, 200)
  }
  if (request.method !== "POST" || request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") {
    return json(request, { error: { code: "operator_request_invalid" } }, 400)
  }
  const body = objectBody(await request.json())
  const binding = parseAdmissionBinding(body.binding)
  await admitDeploymentOperation(env.AUTH_DB, identity, {
    binding,
    operation: { kind: "probe", probe: "release_status" },
  })
  if (url.pathname === "/__release/operator/begin-canary") {
    if (!options.canBeginCanary)
      throw new Error("the locked-only Worker cannot admit a canary without a browser artifact")
    const journeyId = stringField(body, "journeyId")
    if (!options.expectedCanaryJourneyId || journeyId !== options.expectedCanaryJourneyId) {
      throw new Error("canary admission does not match the release-bound enrollment journey")
    }
    const state = await beginDeploymentCanary(env.AUTH_DB, identity, {
      receiptId: stringField(body, "receiptId"),
      operationId: stringField(body, "operationId"),
      operatorSubjectHash: await operatorSubjectHash(env),
      canaryIdentityHash: stringField(body, "canaryIdentityHash"),
      journeyId,
      expectedStateRevision: binding.stateRevision,
      expectedPhaseRevision: binding.phaseRevision,
    })
    return json(request, { release: deploymentAdmissionBinding(state) }, 200)
  }
  if (url.pathname === "/__release/operator/evidence") {
    const receipt = await recordDeploymentCutoverEvidence(env.AUTH_DB, identity, binding, parseCutoverEvidence(body))
    return json(request, { receipt }, 200)
  }
  if (url.pathname === "/__release/operator/advance") {
    const targetPhase = stringField(body, "targetPhase")
    if (targetPhase !== "provider_sync" && targetPhase !== "multiplayer_validation" && targetPhase !== "open") {
      throw new Error("targetPhase must be the immediate cutover successor")
    }
    const advanced = await advanceDeploymentCutover(env.AUTH_DB, identity, {
      binding,
      targetPhase,
      operationId: stringField(body, "operationId"),
    })
    return json(request, { release: deploymentAdmissionBinding(advanced) }, 200)
  }
  return json(request, { error: { code: "operator_route_not_found" } }, 404, appOrigin)
}
