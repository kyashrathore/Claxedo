import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import type { D1Database } from "@cloudflare/workers-types"
import { afterEach, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"

import {
  LOCKED_BROWSER_BUILD_ID,
  LOCKED_RELAY_BUILD_ID,
  LOCKED_SERVICE_MANIFEST_ID,
  activateLockedDeploymentReleaseCandidate,
  advanceDeploymentReleasePhase,
  lockedDeploymentReleaseProvisioningStatements,
  devOpenDeploymentReleaseStatements,
  provisionLockedDeploymentReleaseState,
  recordDeploymentFirstTargetWriteBoundary,
  registerLockedDeploymentReleaseCandidate,
  requireDeploymentReleaseCandidate,
  requireDeploymentReleaseState,
  rollbackDeploymentCanaryBeforeWrite,
  rollbackLockedDeploymentReleaseCandidate,
  type DeploymentReleaseIdentity,
  type DeploymentReleaseTransition,
} from "./better-auth-d1-release-state.cf"
import {
  MULTIPLAYER_VALIDATION_EVIDENCE_KINDS,
  admitDeploymentOperation,
  advanceDeploymentCutover,
  beginDeploymentCanary,
  deploymentAdmissionBinding,
  recordDeploymentCanaryFirstWrite,
  recordDeploymentCutoverEvidence,
} from "./better-auth-d1-cutover-gate.cf"

const MIGRATION_PATHS = [
  fileURLToPath(new URL("../../../migrations/auth/0002_deployment_release_state.sql", import.meta.url)),
  fileURLToPath(new URL("../../../migrations/auth/0004_cutover_admission.sql", import.meta.url)),
]

const identity = {
  deploymentId: "deployment-test-01",
  releaseSequence: 1,
  releaseId: "release-test-0001",
  workerBuildId: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  platformVersionId: "11111111-1111-1111-1111-111111111111",
  browserBuildId: LOCKED_BROWSER_BUILD_ID,
  relayBuildId: LOCKED_RELAY_BUILD_ID,
  authConfigurationId: "sha256:0649de3450af10bc2af0e7f753ac375beb9bb87b4fa1ee8f0f8248825eb521e3",
  requestLimiterNamespaceId: "2101",
  adapterProfile: "better-auth-d1",
  productPosture: "user-deployed",
  sandboxPosture: "control-plane-only",
  serviceManifestId: LOCKED_SERVICE_MANIFEST_ID,
} satisfies DeploymentReleaseIdentity

const active: Miniflare[] = []

async function database() {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["AUTH_DB"],
  })
  active.push(instance)
  const database = await instance.getD1Database("AUTH_DB")
  for (const migrationPath of MIGRATION_PATHS) {
    const migration = (await readFile(migrationPath, "utf8")).replace(/^\s*--.*$/gm, "")
    for (const statement of migration
      .split(/;\s*\n\s*\n/)
      .map((part) => part.trim())
      .filter(Boolean)) {
      await database.prepare(statement).run()
    }
  }
  return database
}

async function attestStableMigration(database: D1Database, selectedIdentity: DeploymentReleaseIdentity) {
  const state = await requireDeploymentReleaseState(database, selectedIdentity)
  return recordDeploymentCutoverEvidence(database, selectedIdentity, deploymentAdmissionBinding(state), {
    kind: "migration_conservation_verified",
    receiptId: "receipt-migration-conservation-0001",
    operationId: "operation-migration-conservation-0001",
    sourceSnapshotId: "snapshot-migration-0001",
    evidenceSha256: "sha256:9999999999999999999999999999999999999999999999999999999999999999",
    sourceSha256: "sha256:8888888888888888888888888888888888888888888888888888888888888888",
  })
}

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

describe("persisted deployment release history", () => {
  test("registers a retryable candidate without moving the active pointer", async () => {
    const db = await database()
    const candidate = await registerLockedDeploymentReleaseCandidate(db, identity, new Date("2026-08-28T00:00:00Z"))
    expect(candidate).toMatchObject({ ...identity, stateRevision: 0, phase: "locked" })
    await expect(requireDeploymentReleaseState(db, identity)).rejects.toThrow(/not initialized/)
    expect(await requireDeploymentReleaseCandidate(db, identity)).toEqual(candidate)
    const active = await activateLockedDeploymentReleaseCandidate(db, identity, new Date("2026-08-28T00:01:00Z"))
    expect(active).toEqual(candidate)
  })

  test("dev-open advances a locked release straight to open, exactly once", async () => {
    const db = await database()
    await provisionLockedDeploymentReleaseState(db, identity, new Date("2026-08-28T00:00:00Z"))
    for (const sql of devOpenDeploymentReleaseStatements(identity, new Date("2026-08-28T00:02:00Z"))) {
      await db.prepare(sql.replace(/;$/, "")).run()
    }
    const opened = await requireDeploymentReleaseState(db, identity)
    expect(opened).toMatchObject({ ...identity, phase: "open", stateRevision: 1 })
    const row = await db
      .prepare(`select "operationId" from "deploymentReleaseStateHistory" where "stateRevision" = 1`)
      .first<{ operationId: string }>()
    // Auditable: a developer opening never looks like an evidenced one.
    expect(row?.operationId).toBe(`dev-open:${identity.releaseId}`)
    // Idempotent: replaying against an already-open release changes nothing.
    for (const sql of devOpenDeploymentReleaseStatements(identity, new Date("2026-08-28T00:03:00Z"))) {
      await db.prepare(sql.replace(/;$/, "")).run()
    }
    expect(await requireDeploymentReleaseState(db, identity)).toMatchObject({ phase: "open", stateRevision: 1 })
  })

  test("initializes explicitly and retries the exact same release without new history", async () => {
    const db = await database()
    await expect(requireDeploymentReleaseState(db, identity)).rejects.toThrow(/not initialized/)
    const first = await provisionLockedDeploymentReleaseState(db, identity, new Date("2026-08-28T00:00:00Z"))
    const retry = await provisionLockedDeploymentReleaseState(db, identity, new Date("2026-08-28T01:00:00Z"))
    expect(first).toMatchObject({ ...identity, phase: "locked", phaseRevision: 0, stateRevision: 0 })
    expect(retry).toEqual(first)
    expect(
      (await db.prepare(`select count(*) as "count" from "deploymentReleaseStateHistory"`).first<{ count: number }>())
        ?.count,
    ).toBe(1)
  })

  test("rejects reuse of a release identity for different artifact bytes", async () => {
    const db = await database()
    await provisionLockedDeploymentReleaseState(db, identity)
    await expect(
      provisionLockedDeploymentReleaseState(db, {
        ...identity,
        workerBuildId: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      }),
    ).rejects.toThrow(/workerBuildId does not match/)
    expect(
      (await db.prepare(`select count(*) as "count" from "deploymentRelease"`).first<{ count: number }>())?.count,
    ).toBe(1)
  })

  test("admits a successor with one CAS and makes its retry idempotent", async () => {
    const db = await database()
    await provisionLockedDeploymentReleaseState(db, identity)
    const successor = {
      ...identity,
      releaseSequence: 2,
      releaseId: "release-test-0002",
      workerBuildId: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    }
    const transition = {
      operationId: "operation-release-0002",
      previousReleaseId: identity.releaseId,
      previousStateRevision: 0,
      previousPhase: "locked",
      previousPhaseRevision: 0,
    } satisfies DeploymentReleaseTransition
    const first = await provisionLockedDeploymentReleaseState(
      db,
      successor,
      new Date("2026-08-28T01:00:00Z"),
      transition,
    )
    const retry = await provisionLockedDeploymentReleaseState(
      db,
      successor,
      new Date("2026-08-28T02:00:00Z"),
      transition,
    )
    expect(first).toMatchObject({ ...successor, stateRevision: 1, transitionKind: "locked_replacement" })
    expect(retry).toEqual(first)
    expect(
      (await db.prepare(`select count(*) as "count" from "deploymentReleaseStateHistory"`).first<{ count: number }>())
        ?.count,
    ).toBe(2)
  })

  test("rolls an activated write-free candidate back by appending its immediate predecessor", async () => {
    const db = await database()
    await provisionLockedDeploymentReleaseState(db, identity)
    const successor = {
      ...identity,
      releaseSequence: 2,
      releaseId: "release-test-0002",
      workerBuildId: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      platformVersionId: "22222222-2222-2222-2222-222222222222",
    }
    const transition = {
      operationId: "operation-release-0002",
      previousReleaseId: identity.releaseId,
      previousStateRevision: 0,
      previousPhase: "locked",
      previousPhaseRevision: 0,
    } satisfies DeploymentReleaseTransition
    await provisionLockedDeploymentReleaseState(db, successor, new Date("2026-08-28T01:00:00Z"), transition)
    const rollback = {
      deploymentId: identity.deploymentId,
      operationId: "operation-rollback-0002",
      expectedReleaseId: successor.releaseId,
      expectedStateRevision: 1,
    }
    const first = await rollbackLockedDeploymentReleaseCandidate(db, rollback, new Date("2026-08-28T01:01:00Z"))
    const retry = await rollbackLockedDeploymentReleaseCandidate(db, rollback, new Date("2026-08-28T01:02:00Z"))
    expect(first).toMatchObject({
      ...identity,
      stateRevision: 2,
      previousStateRevision: 1,
      restoredStateRevision: 0,
      transitionKind: "prewrite_rollback",
    })
    expect(retry).toEqual(first)
    expect(
      (await db.prepare(`select count(*) as "count" from "deploymentReleaseStateHistory"`).first<{ count: number }>())
        ?.count,
    ).toBe(3)
  })

  test("rolls an inert candidate back without deleting its failed private-health attempt", async () => {
    const db = await database()
    await provisionLockedDeploymentReleaseState(db, identity)
    const successor = {
      ...identity,
      releaseSequence: 2,
      releaseId: "release-test-0002",
      workerBuildId: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      platformVersionId: "22222222-2222-2222-2222-222222222222",
    }
    const transition = {
      operationId: "operation-release-0002",
      previousReleaseId: identity.releaseId,
      previousStateRevision: 0,
      previousPhase: "locked",
      previousPhaseRevision: 0,
    } satisfies DeploymentReleaseTransition
    await registerLockedDeploymentReleaseCandidate(db, successor, new Date("2026-08-28T01:00:00Z"), transition)
    expect((await requireDeploymentReleaseState(db, identity)).stateRevision).toBe(0)

    const rollback = await rollbackLockedDeploymentReleaseCandidate(
      db,
      {
        deploymentId: identity.deploymentId,
        operationId: "operation-rollback-0002",
        expectedReleaseId: successor.releaseId,
        expectedStateRevision: 1,
      },
      new Date("2026-08-28T01:01:00Z"),
    )

    expect(rollback).toMatchObject({
      releaseId: identity.releaseId,
      stateRevision: 2,
      previousStateRevision: 1,
      restoredStateRevision: 0,
      transitionKind: "prewrite_rollback",
    })
    expect(
      (await db.prepare(`select count(*) as "count" from "deploymentReleaseStateHistory"`).first<{ count: number }>())
        ?.count,
    ).toBe(3)
  })

  test("rolls a canary with no target write back to the pre-candidate predecessor", async () => {
    const db = await database()
    const predecessor = await provisionLockedDeploymentReleaseState(db, identity)
    const successor = {
      ...identity,
      releaseSequence: 2,
      releaseId: "release-test-0002",
      workerBuildId: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      platformVersionId: "22222222-2222-2222-2222-222222222222",
    }
    const locked = await provisionLockedDeploymentReleaseState(db, successor, new Date("2026-08-28T01:00:00Z"), {
      operationId: "operation-release-0002",
      previousReleaseId: identity.releaseId,
      previousStateRevision: predecessor.stateRevision,
      previousPhase: predecessor.phase,
      previousPhaseRevision: predecessor.phaseRevision,
    })
    await attestStableMigration(db, successor)
    const canary = await beginDeploymentCanary(db, successor, {
      receiptId: "receipt-canary-0002",
      operationId: "operation-canary-0002",
      operatorSubjectHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      canaryIdentityHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      journeyId: "journey-canary-0002",
      expectedStateRevision: locked.stateRevision,
      expectedPhaseRevision: locked.phaseRevision,
    })

    const input = {
      deploymentId: identity.deploymentId,
      operationId: "operation-rollback-canary-0002",
      expectedReleaseId: successor.releaseId,
      expectedStateRevision: canary.stateRevision,
    }
    const first = await rollbackDeploymentCanaryBeforeWrite(db, input, new Date("2026-08-28T01:01:00Z"))
    const retry = await rollbackDeploymentCanaryBeforeWrite(db, input, new Date("2026-08-28T01:02:00Z"))

    expect(first).toMatchObject({
      ...identity,
      stateRevision: canary.stateRevision + 1,
      previousStateRevision: canary.stateRevision,
      restoredStateRevision: predecessor.stateRevision,
      transitionKind: "prewrite_rollback",
    })
    expect(retry).toEqual(first)
  })

  test("re-locks a failed post-write canary and admits only an immutable roll-forward successor", async () => {
    const db = await database()
    const canaryIdentity = {
      ...identity,
      browserBuildId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }
    const locked = await provisionLockedDeploymentReleaseState(db, canaryIdentity)
    await attestStableMigration(db, canaryIdentity)
    const canary = await beginDeploymentCanary(db, canaryIdentity, {
      receiptId: "receipt-canary-abort-0001",
      operationId: "operation-canary-abort-admission-0001",
      operatorSubjectHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      canaryIdentityHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      journeyId: "journey-canary-abort-0001",
      expectedStateRevision: locked.stateRevision,
      expectedPhaseRevision: locked.phaseRevision,
    })
    const firstWrite = await recordDeploymentCanaryFirstWrite(
      db,
      canaryIdentity,
      {
        binding: deploymentAdmissionBinding(canary),
        operation: {
          kind: "canary_journey",
          canaryIdentityHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          journeyId: "journey-canary-abort-0001",
          access: "mutation",
          mutationOperationId: "operation-canary-abort-write-0001",
        },
      },
      new Date("2026-08-28T01:01:00Z"),
    )
    const successor = {
      ...canaryIdentity,
      releaseSequence: 2,
      releaseId: "release-test-0002",
      platformVersionId: "22222222-2222-2222-2222-222222222222",
    }
    const rolledForward = await provisionLockedDeploymentReleaseState(db, successor, new Date("2026-08-28T01:03:00Z"), {
      operationId: "operation-release-after-canary-abort-0001",
      previousReleaseId: canaryIdentity.releaseId,
      previousStateRevision: firstWrite.stateRevision,
      previousPhase: "canary",
      previousPhaseRevision: firstWrite.phaseRevision,
    })
    expect(rolledForward).toMatchObject({
      releaseId: successor.releaseId,
      stateRevision: 3,
      phase: "locked",
      phaseRevision: 0,
      firstTargetWriteAt: null,
    })
    await expect(
      beginDeploymentCanary(db, successor, {
        receiptId: "receipt-successor-canary-0001",
        operationId: "operation-successor-canary-0001",
        operatorSubjectHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        canaryIdentityHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        journeyId: "journey-successor-canary-0001",
        expectedStateRevision: rolledForward.stateRevision,
        expectedPhaseRevision: rolledForward.phaseRevision,
      }),
    ).resolves.toMatchObject({ phase: "canary", stateRevision: 4 })
  })

  test("admits an immutable locked successor while provider synchronization is in progress", async () => {
    const db = await database()
    const providerIdentity = {
      ...identity,
      browserBuildId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }
    const locked = await provisionLockedDeploymentReleaseState(db, providerIdentity)
    await attestStableMigration(db, providerIdentity)
    const canary = await beginDeploymentCanary(db, providerIdentity, {
      receiptId: "receipt-provider-rollforward-canary-0001",
      operationId: "operation-provider-rollforward-canary-0001",
      operatorSubjectHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      canaryIdentityHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      journeyId: "journey-provider-rollforward-0001",
      expectedStateRevision: locked.stateRevision,
      expectedPhaseRevision: locked.phaseRevision,
    })
    const firstWrite = await recordDeploymentCanaryFirstWrite(db, providerIdentity, {
      binding: deploymentAdmissionBinding(canary),
      operation: {
        kind: "canary_journey",
        canaryIdentityHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        journeyId: "journey-provider-rollforward-0001",
        access: "mutation",
        mutationOperationId: "operation-provider-rollforward-write-0001",
      },
    })
    await recordDeploymentCutoverEvidence(db, providerIdentity, deploymentAdmissionBinding(firstWrite), {
      kind: "canary_journey_complete",
      receiptId: "receipt-provider-rollforward-complete-0001",
      operationId: "operation-provider-rollforward-complete-0001",
      canaryIdentityHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      journeyId: "journey-provider-rollforward-0001",
    })
    const providerSync = await advanceDeploymentCutover(db, providerIdentity, {
      operationId: "operation-provider-rollforward-sync-0001",
      binding: deploymentAdmissionBinding(firstWrite),
      targetPhase: "provider_sync",
    })
    const successor = {
      ...providerIdentity,
      releaseSequence: 2,
      releaseId: "release-provider-rollforward-0002",
      platformVersionId: "22222222-2222-2222-2222-222222222222",
    }

    await expect(
      provisionLockedDeploymentReleaseState(db, successor, new Date("2026-08-28T01:03:00Z"), {
        operationId: "operation-provider-rollforward-release-0002",
        previousReleaseId: providerIdentity.releaseId,
        previousStateRevision: providerSync.stateRevision,
        previousPhase: providerSync.phase,
        previousPhaseRevision: providerSync.phaseRevision,
      }),
    ).resolves.toMatchObject({
      releaseId: successor.releaseId,
      phase: "locked",
      phaseRevision: 0,
      firstTargetWriteAt: null,
    })
  })

  test("rejects stale concurrent transitions and a non-monotonic release sequence", async () => {
    const db = await database()
    await provisionLockedDeploymentReleaseState(db, identity)
    const transition = {
      operationId: "operation-release-0002",
      previousReleaseId: identity.releaseId,
      previousStateRevision: 0,
      previousPhase: "locked",
      previousPhaseRevision: 0,
    } satisfies DeploymentReleaseTransition
    await provisionLockedDeploymentReleaseState(
      db,
      {
        ...identity,
        releaseSequence: 2,
        releaseId: "release-test-0002",
        workerBuildId: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      },
      new Date(),
      transition,
    )
    await expect(
      provisionLockedDeploymentReleaseState(
        db,
        {
          ...identity,
          releaseSequence: 3,
          releaseId: "release-test-0003",
          workerBuildId: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
        },
        new Date(),
        { ...transition, operationId: "operation-release-0003" },
      ),
    ).rejects.toThrow(/candidate was not registered/)
    await expect(
      provisionLockedDeploymentReleaseState(
        db,
        {
          ...identity,
          releaseSequence: 1,
          releaseId: "release-test-0004",
          workerBuildId: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
        },
        new Date(),
        {
          operationId: "operation-release-0004",
          previousReleaseId: "release-test-0002",
          previousStateRevision: 1,
          previousPhase: "locked",
          previousPhaseRevision: 0,
        },
      ),
    ).rejects.toThrow()
  })

  test("advances through the exact persisted cutover sequence and records the irreversible boundary once", async () => {
    const db = await database()
    const openIdentity = {
      ...identity,
      browserBuildId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }
    const locked = await provisionLockedDeploymentReleaseState(db, openIdentity)
    await attestStableMigration(db, openIdentity)
    await expect(
      recordDeploymentCutoverEvidence(db, openIdentity, deploymentAdmissionBinding(locked), {
        kind: "migration_conservation_verified",
        receiptId: "receipt-migration-conservation-0001",
        operationId: "operation-migration-conservation-0001",
        sourceSnapshotId: "snapshot-migration-0001",
        evidenceSha256: "sha256:7777777777777777777777777777777777777777777777777777777777777777",
        sourceSha256: "sha256:8888888888888888888888888888888888888888888888888888888888888888",
      }),
    ).rejects.toThrow(/replay conflicts/)
    const canary = await beginDeploymentCanary(
      db,
      openIdentity,
      {
        receiptId: "receipt-canary-0001",
        operationId: "operation-canary-0001",
        operatorSubjectHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        canaryIdentityHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        journeyId: "journey-canary-0001",
        expectedStateRevision: locked.stateRevision,
        expectedPhaseRevision: locked.phaseRevision,
      },
      new Date("2026-08-28T01:00:00Z"),
    )
    expect(canary).toMatchObject({ stateRevision: 1, phase: "canary", phaseRevision: 1 })
    expect(canary.firstTargetWriteAt).toBeNull()

    const mutation = {
      binding: deploymentAdmissionBinding(canary),
      operation: {
        kind: "canary_journey" as const,
        canaryIdentityHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        journeyId: "journey-canary-0001",
        access: "mutation" as const,
        mutationOperationId: "operation-first-write-0001",
      },
    }
    const firstWrite = await recordDeploymentCanaryFirstWrite(
      db,
      openIdentity,
      mutation,
      new Date("2026-08-28T01:01:00Z"),
    )
    const retry = await recordDeploymentCanaryFirstWrite(db, openIdentity, mutation, new Date("2026-08-28T01:02:00Z"))
    expect(firstWrite).toMatchObject({
      stateRevision: 2,
      phase: "canary",
      phaseRevision: 2,
      transitionKind: "first_target_write",
      firstTargetWriteAt: "2026-08-28T01:01:00.000Z",
    })
    expect(retry).toEqual(firstWrite)

    await recordDeploymentCutoverEvidence(db, openIdentity, deploymentAdmissionBinding(firstWrite), {
      kind: "canary_journey_complete",
      receiptId: "receipt-canary-complete-0001",
      operationId: "operation-canary-complete-0001",
      canaryIdentityHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      journeyId: "journey-canary-0001",
    })
    let current = await advanceDeploymentCutover(db, openIdentity, {
      operationId: "operation-provider-sync-0001",
      binding: deploymentAdmissionBinding(firstWrite),
      targetPhase: "provider_sync",
    })
    for (const evidence of [
      { kind: "callback_capture_ready" as const },
      { kind: "callback_inbox_drained" as const, observedCount: 0 as const },
      { kind: "authority_reconciled" as const, observedCount: 0 as const },
      { kind: "billing_closure_absent" as const },
    ])
      await recordDeploymentCutoverEvidence(db, openIdentity, deploymentAdmissionBinding(current), {
        ...evidence,
        receiptId: `receipt-${evidence.kind}-0001`,
        operationId: `operation-${evidence.kind}-0001`,
      })
    await expect(
      recordDeploymentCutoverEvidence(db, openIdentity, deploymentAdmissionBinding(current), {
        kind: "callback_capture_ready",
        receiptId: "receipt-callback_capture_ready-0001",
        operationId: "operation-callback_capture_ready-0001",
      }),
    ).resolves.toMatchObject({ evidenceKind: "callback_capture_ready" })
    await expect(
      recordDeploymentCutoverEvidence(db, openIdentity, deploymentAdmissionBinding(current), {
        kind: "billing_closure_absent",
        receiptId: "receipt-callback_capture_ready-0001",
        operationId: "operation-conflicting-replay-0001",
      }),
    ).rejects.toThrow(/persistence failed|replay conflicts/)
    await expect(
      advanceDeploymentCutover(db, openIdentity, {
        operationId: "operation-multiplayer-before-backup-0001",
        binding: deploymentAdmissionBinding(current),
        targetPhase: "multiplayer_validation",
      }),
    ).rejects.toThrow(/complete user-deployed provider-sync evidence/)
    await recordDeploymentCutoverEvidence(db, openIdentity, deploymentAdmissionBinding(current), {
      kind: "paired_backup_verified",
      receiptId: "receipt-paired-backup-0001",
      operationId: "operation-paired-backup-0001",
      recoveryEpoch: "recovery-epoch-0001",
      authBackupSha256: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      controlPlaneBackupSha256: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    })
    current = await advanceDeploymentCutover(db, openIdentity, {
      operationId: "operation-multiplayer-0001",
      binding: deploymentAdmissionBinding(current),
      targetPhase: "multiplayer_validation",
    })
    const multiplayer = [
      "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    ] as const
    for (const [index, identityHash] of multiplayer.entries())
      await recordDeploymentCutoverEvidence(db, openIdentity, deploymentAdmissionBinding(current), {
        kind: "multiplayer_identity",
        slot: (index + 1) as 1 | 2,
        identityHash,
        receiptId: `receipt-multiplayer-identity-000${index + 1}`,
        operationId: `operation-multiplayer-identity-000${index + 1}`,
      })
    for (const kind of MULTIPLAYER_VALIDATION_EVIDENCE_KINDS)
      await recordDeploymentCutoverEvidence(db, openIdentity, deploymentAdmissionBinding(current), {
        kind,
        receiptId: `receipt-${kind}-0001`,
        operationId: `operation-${kind}-0001`,
        firstIdentityHash: multiplayer[0],
        secondIdentityHash: multiplayer[1],
      })
    current = await advanceDeploymentCutover(db, openIdentity, {
      operationId: "operation-open-0001",
      binding: deploymentAdmissionBinding(current),
      targetPhase: "open",
    })
    expect(current).toMatchObject({ stateRevision: 5, phase: "open", phaseRevision: 5 })
    expect(current.firstTargetWriteAt).toBe("2026-08-28T01:01:00.000Z")
    expect(
      (await db.prepare(`select count(*) as "count" from "deploymentReleaseStateHistory"`).first<{ count: number }>())
        ?.count,
    ).toBe(6)
  })

  test("serializes one canary admission and rejects a competing deployment-authorized journey", async () => {
    const db = await database()
    const locked = await provisionLockedDeploymentReleaseState(db, identity)
    await attestStableMigration(db, identity)
    const admission = {
      receiptId: "receipt-canary-winner",
      operationId: "operation-canary-winner",
      operatorSubjectHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      canaryIdentityHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      journeyId: "journey-canary-winner",
      expectedStateRevision: locked.stateRevision,
      expectedPhaseRevision: locked.phaseRevision,
    }
    const results = await Promise.allSettled([
      beginDeploymentCanary(db, identity, admission),
      beginDeploymentCanary(db, identity, {
        ...admission,
        receiptId: "receipt-canary-loser",
        operationId: "operation-canary-loser",
        canaryIdentityHash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        journeyId: "journey-canary-loser",
      }),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect(
      (await db.prepare(`select count(*) as count from "deploymentCutoverCanaryAdmission"`).first<{ count: number }>())
        ?.count,
    ).toBe(1)
  })

  test("cannot persist a canary admission before exact stable migration evidence", async () => {
    const db = await database()
    const locked = await provisionLockedDeploymentReleaseState(db, identity)
    await expect(
      beginDeploymentCanary(db, identity, {
        receiptId: "receipt-canary-without-migration",
        operationId: "operation-canary-without-migration",
        operatorSubjectHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        canaryIdentityHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        journeyId: "journey-canary-without-migration",
        expectedStateRevision: locked.stateRevision,
        expectedPhaseRevision: locked.phaseRevision,
      }),
    ).rejects.toThrow(/no deployment-authorized canary admission/)
    expect(
      (
        await db.prepare(`select count(*) as "count" from "deploymentCutoverCanaryAdmission"`).first<{
          count: number
        }>()
      )?.count,
    ).toBe(0)
  })

  test("admits greenfield source absence as the only alternative to migration conservation", async () => {
    const db = await database()
    const locked = await provisionLockedDeploymentReleaseState(db, identity)
    await recordDeploymentCutoverEvidence(db, identity, deploymentAdmissionBinding(locked), {
      kind: "greenfield_source_absence_verified",
      receiptId: "receipt-greenfield-source-absence",
      operationId: "operation-greenfield-source-absence",
      targetAbsenceSha256: "sha256:7777777777777777777777777777777777777777777777777777777777777777",
      deploymentManifestSha256: "sha256:6666666666666666666666666666666666666666666666666666666666666666",
    })
    await expect(
      recordDeploymentCutoverEvidence(db, identity, deploymentAdmissionBinding(locked), {
        kind: "migration_conservation_verified",
        receiptId: "receipt-conflicting-migration-source",
        operationId: "operation-conflicting-migration-source",
        sourceSnapshotId: "snapshot-conflicting-source",
        evidenceSha256: "sha256:9999999999999999999999999999999999999999999999999999999999999999",
        sourceSha256: "sha256:8888888888888888888888888888888888888888888888888888888888888888",
      }),
    ).rejects.toThrow(/replay conflicts/)
    await expect(
      beginDeploymentCanary(db, identity, {
        receiptId: "receipt-greenfield-canary",
        operationId: "operation-greenfield-canary",
        operatorSubjectHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        canaryIdentityHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        journeyId: "journey-greenfield-canary",
        expectedStateRevision: locked.stateRevision,
        expectedPhaseRevision: locked.phaseRevision,
      }),
    ).resolves.toMatchObject({ phase: "canary" })
  })

  test("fails queued ordinary work and wrong canary identities closed against the execution-time state", async () => {
    const db = await database()
    const locked = await provisionLockedDeploymentReleaseState(db, identity)
    await attestStableMigration(db, identity)
    const queuedWhileLocked = { binding: deploymentAdmissionBinding(locked), operation: { kind: "ordinary" as const } }
    await expect(admitDeploymentOperation(db, identity, queuedWhileLocked)).rejects.toThrow(
      /locked admits.*probes only/,
    )
    const canary = await beginDeploymentCanary(db, identity, {
      receiptId: "receipt-canary-queued",
      operationId: "operation-canary-queued",
      operatorSubjectHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      canaryIdentityHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      journeyId: "journey-canary-queued",
      expectedStateRevision: locked.stateRevision,
      expectedPhaseRevision: locked.phaseRevision,
    })
    await expect(admitDeploymentOperation(db, identity, queuedWhileLocked)).rejects.toThrow(/stateRevision is stale/)
    await expect(
      admitDeploymentOperation(db, identity, {
        binding: {
          ...deploymentAdmissionBinding(canary),
          workerBuildId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        operation: { kind: "probe", probe: "release_status" },
      }),
    ).rejects.toThrow(/workerBuildId is stale/)
    await expect(
      admitDeploymentOperation(db, identity, {
        binding: { ...deploymentAdmissionBinding(canary), productPosture: "claxedo-hosted" },
        operation: { kind: "probe", probe: "release_status" },
      }),
    ).rejects.toThrow(/productPosture is stale/)
    await expect(
      admitDeploymentOperation(db, identity, {
        binding: deploymentAdmissionBinding(canary),
        operation: {
          kind: "canary_journey",
          access: "read",
          journeyId: "journey-canary-queued",
          canaryIdentityHash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        },
      }),
    ).rejects.toThrow(/exclusive canary/)
    for (const kind of ["ordinary", "native", "service", "background"] as const) {
      await expect(
        admitDeploymentOperation(db, identity, {
          binding: deploymentAdmissionBinding(canary),
          operation: { kind },
        }),
      ).rejects.toThrow(/denied during canary/)
    }
  })

  test("rejects skipped phases, provider sync before the canary write, and a competing phase CAS", async () => {
    const db = await database()
    const locked = await provisionLockedDeploymentReleaseState(db, identity)
    await attestStableMigration(db, identity)
    await expect(
      advanceDeploymentReleasePhase(db, identity, {
        operationId: "operation-skip-0001",
        expectedStateRevision: locked.stateRevision,
        expectedPhase: "locked",
        expectedPhaseRevision: locked.phaseRevision,
        targetPhase: "provider_sync",
      }),
    ).rejects.toThrow(/immediate successor/)

    const canaryAdmission = {
      receiptId: "receipt-canary-0001",
      operationId: "operation-canary-0001",
      operatorSubjectHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      canaryIdentityHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      journeyId: "journey-canary-0001",
      expectedStateRevision: locked.stateRevision,
      expectedPhaseRevision: locked.phaseRevision,
    }
    const canary = await beginDeploymentCanary(db, identity, canaryAdmission)
    await expect(
      advanceDeploymentReleasePhase(db, identity, {
        operationId: "operation-provider-0001",
        expectedStateRevision: canary.stateRevision,
        expectedPhase: "canary",
        expectedPhaseRevision: canary.phaseRevision,
        targetPhase: "provider_sync",
      }),
    ).rejects.toThrow(/exact canary first-write/)
    await expect(
      advanceDeploymentReleasePhase(db, identity, {
        operationId: "operation-competing-0001",
        expectedStateRevision: locked.stateRevision,
        expectedPhase: "locked",
        expectedPhaseRevision: locked.phaseRevision,
        targetPhase: "canary",
      }),
    ).rejects.toThrow(/stale state revision/)
  })

  test("forbids pre-write rollback after the serialized canary boundary", async () => {
    const db = await database()
    const locked = await provisionLockedDeploymentReleaseState(db, identity)
    await attestStableMigration(db, identity)
    const canary = await beginDeploymentCanary(db, identity, {
      receiptId: "receipt-canary-0001",
      operationId: "operation-canary-0001",
      operatorSubjectHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      canaryIdentityHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      journeyId: "journey-canary-0001",
      expectedStateRevision: locked.stateRevision,
      expectedPhaseRevision: locked.phaseRevision,
    })
    const firstWrite = await recordDeploymentFirstTargetWriteBoundary(db, identity, {
      operationId: "operation-first-write-0001",
      expectedStateRevision: canary.stateRevision,
      expectedPhaseRevision: canary.phaseRevision,
    })
    await expect(
      rollbackLockedDeploymentReleaseCandidate(db, {
        deploymentId: identity.deploymentId,
        operationId: "operation-rollback-after-write-0001",
        expectedReleaseId: identity.releaseId,
        expectedStateRevision: firstWrite.stateRevision,
      }),
    ).rejects.toThrow(/did not restore/)
    await expect(
      rollbackDeploymentCanaryBeforeWrite(db, {
        deploymentId: identity.deploymentId,
        operationId: "operation-rollback-canary-after-write-0001",
        expectedReleaseId: identity.releaseId,
        expectedStateRevision: firstWrite.stateRevision,
      }),
    ).rejects.toThrow(/did not restore/)
  })

  test("repairs interruption after every individually rendered statement", async () => {
    const statements = lockedDeploymentReleaseProvisioningStatements(identity, new Date("2026-08-28T00:00:00Z"))
    for (let stopAfter = 0; stopAfter < statements.length; stopAfter++) {
      const db = await database()
      for (const statement of statements.slice(0, stopAfter)) await db.prepare(statement).run()
      for (const statement of statements) await db.prepare(statement).run()
      expect(await requireDeploymentReleaseState(db, identity)).toMatchObject({ stateRevision: 0, phase: "locked" })
    }
  })

  test("enforces append-only artifacts and state history", async () => {
    const db = await database()
    await provisionLockedDeploymentReleaseState(db, identity)
    await expect(
      db.prepare(`update "deploymentRelease" set "workerBuildId" = 'different-worker-build'`).run(),
    ).rejects.toThrow(/append-only/)
    await expect(db.prepare(`delete from "deploymentReleaseStateHistory"`).run()).rejects.toThrow(/append-only/)
    await expect(db.prepare(`update "deploymentReleaseActive" set "stateRevision" = -1`).run()).rejects.toThrow(
      /constraint/i,
    )
  })
})
