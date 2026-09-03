import { describe, expect, test } from "vitest"

import {
  migrationEvidenceArtifactSha256,
  verifyMigrationEvidence,
  verifyStableMigrationEvidence,
} from "./verify-migration-evidence"

const hash = (digit: string) => `sha256:${digit.repeat(64)}`

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    deploymentId: "deployment-production-01",
    releaseId: "release-0001",
    sourceSnapshotId: "snapshot-0001",
    productPosture: "user-deployed",
    sourceAdapter: "clerk-convex",
    pass: {
      id: "scan-1",
      startedAt: "2026-08-28T00:00:00.000Z",
      completedAt: "2026-08-28T00:01:00.000Z",
      separatedFromPreviousMs: 0,
      requiredSeparationMs: 60_000,
      ingressSealed: true,
      sourceWatermark: "convex:100",
      sourceSha256: hash("1"),
    },
    tenants: { discovered: 1, exported: 1, truncated: false, contentSha256: hash("2") },
    tables: [
      {
        table: "users",
        source: 4,
        imported: 2,
        explicitlyInvalidated: 1,
        explicitlyArchived: 1,
        ownerApprovedDeleted: 0,
        invalidationReceiptIds: ["invalidate-user-3"],
        archiveReceiptIds: ["archive-user-4"],
        deletionApprovalReceiptIds: [],
        rejects: 0,
        targetKeyCollisions: 0,
        unresolvedReferences: 0,
        truncated: false,
      },
    ],
    providers: {
      clerk: {
        scanned: 2,
        reconciled: 2,
        skipped: 0,
        unresolved: 0,
        truncated: false,
        watermark: "clerk:200",
        contentSha256: hash("3"),
      },
      polar: null,
    },
    optionalFeatures: {
      workgraph: { state: "unused", sourceRecords: 0 },
      documents: {
        state: "archived-and-deactivated",
        sourceRecords: 3,
        owner: "operator@example.test",
        userImpactApproval: "approval-001",
        artifactSha256: hash("4"),
        artifactCustodian: "migration-vault",
        dispositionDueAt: "2027-02-28T00:00:00.000Z",
      },
    },
    drains: {
      waitUntil: 0,
      outbox: 0,
      connectionClaims: 0,
      alarms: 0,
      jobs: 0,
      leases: 0,
      documentCapabilities: 0,
      sandboxResourcesUnaccounted: 0,
    },
    usage: { recentSource: 10, recentTarget: 10, rollupOnlySource: 30, rollupOnlyTarget: 30 },
    ...overrides,
  }
}

describe("Better Auth + D1 migration evidence", () => {
  test("accepts two exact stable scans after the required drain window", () => {
    const first = evidence()
    const second = evidence({
      pass: {
        ...first.pass,
        id: "scan-2",
        startedAt: "2026-08-28T00:02:00.000Z",
        completedAt: "2026-08-28T00:03:00.000Z",
        separatedFromPreviousMs: 60_000,
      },
    })
    const verified = verifyStableMigrationEvidence(first, second)
    expect(verified.second.pass.id).toBe("scan-2")
    expect(migrationEvidenceArtifactSha256(verified.first, verified.second)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  test("rejects conservation gaps, truncation, collisions, and unresolved rows", () => {
    const base = evidence()
    for (const change of [
      { source: 5 },
      { truncated: true },
      { targetKeyCollisions: 1 },
      { unresolvedReferences: 1 },
      { rejects: 1 },
    ]) {
      expect(() => verifyMigrationEvidence({ ...base, tables: [{ ...base.tables[0], ...change }] })).toThrow(
        /conservation/,
      )
    }
    expect(() => verifyMigrationEvidence({ ...base, tenants: { ...base.tenants, truncated: true } })).toThrow(
      /tenant inventory/,
    )
    expect(() =>
      verifyMigrationEvidence({
        ...base,
        tables: [{ ...base.tables[0], ownerApprovedDeleted: 1, imported: 1, deletionApprovalReceiptIds: [] }],
      }),
    ).toThrow(/conservation/)
  })

  test("does not treat disabled optional features as a continuity disposition", () => {
    const base = evidence()
    expect(() =>
      verifyMigrationEvidence({
        ...base,
        optionalFeatures: { ...base.optionalFeatures, workgraph: { state: "disabled", sourceRecords: 2 } },
      }),
    ).toThrow(/admitted continuity disposition/)
    expect(() =>
      verifyMigrationEvidence({
        ...base,
        optionalFeatures: { ...base.optionalFeatures, workgraph: { state: "unused", sourceRecords: 2 } },
      }),
    ).toThrow(/cannot be unused/)
  })

  test("requires Polar only for the Claxedo-hosted product and forbids it for user deployments", () => {
    const base = evidence()
    const polar = { ...base.providers.clerk, watermark: "polar:10", contentSha256: hash("5") }
    expect(() => verifyMigrationEvidence({ ...base, providers: { ...base.providers, polar } })).toThrow(
      /Polar input is absent/,
    )
    expect(() => verifyMigrationEvidence({ ...base, productPosture: "claxedo-hosted" })).toThrow(
      /requires a complete Polar/,
    )
    expect(
      verifyMigrationEvidence({
        ...base,
        productPosture: "claxedo-hosted",
        providers: { ...base.providers, polar },
      }).providers.polar,
    ).toMatchObject({ reconciled: 2 })
  })

  test("requires provider/source identity and exact scan separation to remain stable", () => {
    const first = evidence()
    const second = evidence({
      pass: {
        ...first.pass,
        id: "scan-2",
        startedAt: "2026-08-28T00:01:59.999Z",
        completedAt: "2026-08-28T00:03:00.000Z",
        separatedFromPreviousMs: 59_999,
      },
    })
    expect(() => verifyStableMigrationEvidence(first, second)).toThrow(/background window/)
    const changed = evidence({
      pass: {
        ...first.pass,
        id: "scan-2",
        startedAt: "2026-08-28T00:02:00.000Z",
        completedAt: "2026-08-28T00:03:00.000Z",
        separatedFromPreviousMs: 60_000,
        sourceSha256: hash("9"),
      },
    })
    expect(() => verifyStableMigrationEvidence(first, changed)).toThrow(/not stable/)
    const changedDisposition = evidence({
      pass: {
        ...first.pass,
        id: "scan-2",
        startedAt: "2026-08-28T00:02:00.000Z",
        completedAt: "2026-08-28T00:03:00.000Z",
        separatedFromPreviousMs: 60_000,
      },
      optionalFeatures: {
        ...first.optionalFeatures,
        documents: { state: "preinstalled", sourceRecords: 3, serviceManifestId: "documents-service-v1" },
      },
    })
    expect(() => verifyStableMigrationEvidence(first, changedDisposition)).toThrow(/not stable/)
  })

  test("keeps recent facts separate from rollup-only history", () => {
    const base = evidence()
    expect(() =>
      verifyMigrationEvidence({ ...base, usage: { ...base.usage, rollupOnlyTarget: base.usage.rollupOnlyTarget - 1 } }),
    ).toThrow(/usage totals/)
  })
})
