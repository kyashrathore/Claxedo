import { describe, expect, test } from "vitest"

import { betterAuthD1OperatorRequest, selectedBetterAuthD1CutoverAction } from "./cutover-better-auth-d1"

const release = {
  deploymentId: "deployment-test-01",
  releaseId: "release-test-0001",
  workerBuildId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  platformVersionId: "11111111-1111-1111-1111-111111111111",
  browserBuildId: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  relayBuildId: "relay-absent-v1",
  authConfigurationId: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  adapterProfile: "better-auth-d1" as const,
  productPosture: "user-deployed" as const,
  sandboxPosture: "control-plane-only" as const,
  serviceManifestId: "empty-services-v1",
  stateRevision: 3,
  phase: "provider_sync" as const,
  phaseRevision: 3,
}

const env = {
  CLAXEDO_CUTOVER_RECEIPT_ID: "receipt-cutover-0001",
  CLAXEDO_CUTOVER_OPERATION_ID: "operation-cutover-0001",
  CLAXEDO_CUTOVER_SOURCE_SNAPSHOT_ID: "snapshot-cutover-0001",
  CLAXEDO_CUTOVER_MIGRATION_EVIDENCE_SHA256: "sha256:9999999999999999999999999999999999999999999999999999999999999999",
  CLAXEDO_CUTOVER_SOURCE_SHA256: "sha256:8888888888888888888888888888888888888888888888888888888888888888",
  CLAXEDO_CUTOVER_TARGET_ABSENCE_SHA256: "sha256:7777777777777777777777777777777777777777777777777777777777777777",
  CLAXEDO_CUTOVER_DEPLOYMENT_MANIFEST_SHA256: "sha256:6666666666666666666666666666666666666666666666666666666666666666",
  CLAXEDO_CUTOVER_CANARY_IDENTITY_HASH: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  CLAXEDO_CUTOVER_CANARY_JOURNEY_ID: "journey-canary-0001",
  CLAXEDO_CUTOVER_RECOVERY_EPOCH: "recovery-epoch-0001",
  CLAXEDO_CUTOVER_AUTH_BACKUP_SHA256: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  CLAXEDO_CUTOVER_CONTROL_PLANE_BACKUP_SHA256:
    "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  CLAXEDO_CUTOVER_MULTIPLAYER_IDENTITY_1_HASH:
    "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  CLAXEDO_CUTOVER_MULTIPLAYER_IDENTITY_2_HASH:
    "sha256:2222222222222222222222222222222222222222222222222222222222222222",
}

describe("Better Auth D1 cutover operator command", () => {
  test("selects exactly one typed action without a raw phase flag", () => {
    expect(selectedBetterAuthD1CutoverAction(["--record-paired-backup-verified"])).toBe("record-paired-backup-verified")
    expect(() => selectedBetterAuthD1CutoverAction(["--provider_sync"])).toThrow(/select exactly one/)
    expect(() => selectedBetterAuthD1CutoverAction(["--open", "--status"])).toThrow(/exactly one/)
  })

  test("renders product evidence as a typed receipt rather than accepting evidence JSON", () => {
    expect(
      betterAuthD1OperatorRequest("record-migration-conservation-verified", env, { ...release, phase: "locked" }),
    ).toMatchObject({
      method: "POST",
      path: "/__release/operator/evidence",
      body: {
        kind: "migration_conservation_verified",
        sourceSnapshotId: env.CLAXEDO_CUTOVER_SOURCE_SNAPSHOT_ID,
        evidenceSha256: env.CLAXEDO_CUTOVER_MIGRATION_EVIDENCE_SHA256,
        sourceSha256: env.CLAXEDO_CUTOVER_SOURCE_SHA256,
      },
    })
    expect(
      betterAuthD1OperatorRequest("record-greenfield-source-absence-verified", env, {
        ...release,
        phase: "locked",
      }),
    ).toMatchObject({
      method: "POST",
      path: "/__release/operator/evidence",
      body: {
        kind: "greenfield_source_absence_verified",
        targetAbsenceSha256: env.CLAXEDO_CUTOVER_TARGET_ABSENCE_SHA256,
        deploymentManifestSha256: env.CLAXEDO_CUTOVER_DEPLOYMENT_MANIFEST_SHA256,
      },
    })
    expect(betterAuthD1OperatorRequest("record-billing-closure-absent", env, release)).toMatchObject({
      method: "POST",
      path: "/__release/operator/evidence",
      body: {
        kind: "billing_closure_absent",
        receiptId: "receipt-cutover-0001",
        operationId: "operation-cutover-0001",
        binding: release,
      },
    })
    expect(betterAuthD1OperatorRequest("record-paired-backup-verified", env, release).body).toMatchObject({
      kind: "paired_backup_verified",
      recoveryEpoch: "recovery-epoch-0001",
      authBackupSha256: env.CLAXEDO_CUTOVER_AUTH_BACKUP_SHA256,
      controlPlaneBackupSha256: env.CLAXEDO_CUTOVER_CONTROL_PLANE_BACKUP_SHA256,
    })
  })

  test("binds multiplayer evidence to the exact two selected identities", () => {
    expect(
      betterAuthD1OperatorRequest("record-private-session-verified", env, {
        ...release,
        phase: "multiplayer_validation",
      }).body,
    ).toMatchObject({
      kind: "private_session_verified",
      firstIdentityHash: env.CLAXEDO_CUTOVER_MULTIPLAYER_IDENTITY_1_HASH,
      secondIdentityHash: env.CLAXEDO_CUTOVER_MULTIPLAYER_IDENTITY_2_HASH,
    })
  })

  test("refuses to start canary from the deployed locked-only artifact", () => {
    expect(() =>
      betterAuthD1OperatorRequest("begin-canary", env, {
        ...release,
        phase: "locked",
        stateRevision: 0,
        phaseRevision: 0,
        browserBuildId: "browser-absent-v1",
      }),
    ).toThrow(/no browser artifact/)
  })
})
