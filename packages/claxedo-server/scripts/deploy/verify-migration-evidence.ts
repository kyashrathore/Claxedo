import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const SHA256 = /^sha256:[0-9a-f]{64}$/

type JsonRecord = Record<string, unknown>

export type MigrationDisposition = Readonly<{
  table: string
  source: number
  imported: number
  explicitlyInvalidated: number
  explicitlyArchived: number
  ownerApprovedDeleted: number
  invalidationReceiptIds: readonly string[]
  archiveReceiptIds: readonly string[]
  deletionApprovalReceiptIds: readonly string[]
  rejects: number
  targetKeyCollisions: number
  unresolvedReferences: number
  truncated: boolean
}>

export type OptionalFeatureDisposition =
  | Readonly<{ state: "unused"; sourceRecords: 0 }>
  | Readonly<{ state: "preinstalled"; sourceRecords: number; serviceManifestId: string }>
  | Readonly<{
      state: "archived-and-deactivated"
      sourceRecords: number
      owner: string
      userImpactApproval: string
      artifactSha256: string
      artifactCustodian: string
      dispositionDueAt: string
    }>

export type ProviderScan = Readonly<{
  scanned: number
  reconciled: number
  skipped: number
  unresolved: number
  truncated: boolean
  watermark: string
  contentSha256: string
}>

export type MigrationEvidence = Readonly<{
  schemaVersion: 1
  deploymentId: string
  releaseId: string
  sourceSnapshotId: string
  productPosture: "claxedo-hosted" | "user-deployed"
  sourceAdapter: "clerk-convex"
  pass: Readonly<{
    id: string
    startedAt: string
    completedAt: string
    separatedFromPreviousMs: number
    requiredSeparationMs: number
    ingressSealed: boolean
    sourceWatermark: string
    sourceSha256: string
  }>
  tenants: Readonly<{
    discovered: number
    exported: number
    truncated: boolean
    contentSha256: string
  }>
  tables: readonly MigrationDisposition[]
  providers: Readonly<{
    clerk: ProviderScan
    polar: ProviderScan | null
  }>
  optionalFeatures: Readonly<{
    workgraph: OptionalFeatureDisposition
    documents: OptionalFeatureDisposition
  }>
  drains: Readonly<{
    waitUntil: number
    outbox: number
    connectionClaims: number
    alarms: number
    jobs: number
    leases: number
    documentCapabilities: number
    sandboxResourcesUnaccounted: number
  }>
  usage: Readonly<{
    recentSource: number
    recentTarget: number
    rollupOnlySource: number
    rollupOnlyTarget: number
  }>
}>

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as JsonRecord
}

function text(value: unknown, label: string) {
  if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > 512)
    throw new Error(`${label} must be a non-empty canonical string`)
  return value
}

function count(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`)
  return value as number
}

function boolean(value: unknown, label: string) {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`)
  return value
}

function timestamp(value: unknown, label: string) {
  const raw = text(value, label)
  const parsed = Date.parse(raw)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== raw)
    throw new Error(`${label} must be canonical ISO-8601`)
  return { raw, parsed }
}

function sha256(value: unknown, label: string) {
  const raw = text(value, label)
  if (!SHA256.test(raw)) throw new Error(`${label} must be a lowercase SHA-256 identity`)
  return raw
}

function exactKeys(value: JsonRecord, keys: readonly string[], label: string) {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} has unknown or missing fields`)
}

function providerScan(value: unknown, label: string): ProviderScan {
  const input = record(value, label)
  exactKeys(input, ["scanned", "reconciled", "skipped", "unresolved", "truncated", "watermark", "contentSha256"], label)
  const scanned = count(input.scanned, `${label}.scanned`)
  const reconciled = count(input.reconciled, `${label}.reconciled`)
  const skipped = count(input.skipped, `${label}.skipped`)
  const unresolved = count(input.unresolved, `${label}.unresolved`)
  const truncated = boolean(input.truncated, `${label}.truncated`)
  if (truncated || skipped !== 0 || unresolved !== 0 || reconciled !== scanned)
    throw new Error(`${label} is incomplete or unresolved`)
  return Object.freeze({
    scanned,
    reconciled,
    skipped,
    unresolved,
    truncated,
    watermark: text(input.watermark, `${label}.watermark`),
    contentSha256: sha256(input.contentSha256, `${label}.contentSha256`),
  })
}

function optionalFeature(value: unknown, label: string): OptionalFeatureDisposition {
  const input = record(value, label)
  const state = text(input.state, `${label}.state`)
  const sourceRecords = count(input.sourceRecords, `${label}.sourceRecords`)
  if (state === "unused") {
    exactKeys(input, ["state", "sourceRecords"], label)
    if (sourceRecords !== 0) throw new Error(`${label} cannot be unused with source records`)
    return Object.freeze({ state, sourceRecords: 0 })
  }
  if (state === "preinstalled") {
    exactKeys(input, ["state", "sourceRecords", "serviceManifestId"], label)
    return Object.freeze({
      state,
      sourceRecords,
      serviceManifestId: text(input.serviceManifestId, `${label}.serviceManifestId`),
    })
  }
  if (state === "archived-and-deactivated") {
    exactKeys(
      input,
      [
        "state",
        "sourceRecords",
        "owner",
        "userImpactApproval",
        "artifactSha256",
        "artifactCustodian",
        "dispositionDueAt",
      ],
      label,
    )
    return Object.freeze({
      state,
      sourceRecords,
      owner: text(input.owner, `${label}.owner`),
      userImpactApproval: text(input.userImpactApproval, `${label}.userImpactApproval`),
      artifactSha256: sha256(input.artifactSha256, `${label}.artifactSha256`),
      artifactCustodian: text(input.artifactCustodian, `${label}.artifactCustodian`),
      dispositionDueAt: timestamp(input.dispositionDueAt, `${label}.dispositionDueAt`).raw,
    })
  }
  throw new Error(`${label}.state is not an admitted continuity disposition`)
}

function disposition(value: unknown, index: number): MigrationDisposition {
  const label = `tables[${index}]`
  const input = record(value, label)
  exactKeys(
    input,
    [
      "table",
      "source",
      "imported",
      "explicitlyInvalidated",
      "explicitlyArchived",
      "ownerApprovedDeleted",
      "invalidationReceiptIds",
      "archiveReceiptIds",
      "deletionApprovalReceiptIds",
      "rejects",
      "targetKeyCollisions",
      "unresolvedReferences",
      "truncated",
    ],
    label,
  )
  const receipts = (value: unknown, field: string) => {
    if (!Array.isArray(value)) throw new Error(`${label}.${field} must be an array`)
    const parsed = Object.freeze(value.map((item, receiptIndex) => text(item, `${label}.${field}[${receiptIndex}]`)))
    if (new Set(parsed).size !== parsed.length) throw new Error(`${label}.${field} contains duplicate receipts`)
    return parsed
  }
  const result = Object.freeze({
    table: text(input.table, `${label}.table`),
    source: count(input.source, `${label}.source`),
    imported: count(input.imported, `${label}.imported`),
    explicitlyInvalidated: count(input.explicitlyInvalidated, `${label}.explicitlyInvalidated`),
    explicitlyArchived: count(input.explicitlyArchived, `${label}.explicitlyArchived`),
    ownerApprovedDeleted: count(input.ownerApprovedDeleted, `${label}.ownerApprovedDeleted`),
    invalidationReceiptIds: receipts(input.invalidationReceiptIds, "invalidationReceiptIds"),
    archiveReceiptIds: receipts(input.archiveReceiptIds, "archiveReceiptIds"),
    deletionApprovalReceiptIds: receipts(input.deletionApprovalReceiptIds, "deletionApprovalReceiptIds"),
    rejects: count(input.rejects, `${label}.rejects`),
    targetKeyCollisions: count(input.targetKeyCollisions, `${label}.targetKeyCollisions`),
    unresolvedReferences: count(input.unresolvedReferences, `${label}.unresolvedReferences`),
    truncated: boolean(input.truncated, `${label}.truncated`),
  })
  const accounted =
    result.imported + result.explicitlyInvalidated + result.explicitlyArchived + result.ownerApprovedDeleted
  if (
    result.source !== accounted ||
    result.invalidationReceiptIds.length !== result.explicitlyInvalidated ||
    result.archiveReceiptIds.length !== result.explicitlyArchived ||
    result.deletionApprovalReceiptIds.length !== result.ownerApprovedDeleted ||
    result.rejects !== 0 ||
    result.targetKeyCollisions !== 0 ||
    result.unresolvedReferences !== 0 ||
    result.truncated
  )
    throw new Error(`${label} fails source-row conservation`)
  return result
}

export function verifyMigrationEvidence(value: unknown): MigrationEvidence {
  const input = record(value, "migration evidence")
  exactKeys(
    input,
    [
      "schemaVersion",
      "deploymentId",
      "releaseId",
      "sourceSnapshotId",
      "productPosture",
      "sourceAdapter",
      "pass",
      "tenants",
      "tables",
      "providers",
      "optionalFeatures",
      "drains",
      "usage",
    ],
    "migration evidence",
  )
  if (input.schemaVersion !== 1) throw new Error("migration evidence schemaVersion must be 1")
  if (input.sourceAdapter !== "clerk-convex") throw new Error("migration evidence must name the exact source adapter")
  if (input.productPosture !== "claxedo-hosted" && input.productPosture !== "user-deployed")
    throw new Error("migration evidence has an unsupported product posture")

  const pass = record(input.pass, "pass")
  exactKeys(
    pass,
    [
      "id",
      "startedAt",
      "completedAt",
      "separatedFromPreviousMs",
      "requiredSeparationMs",
      "ingressSealed",
      "sourceWatermark",
      "sourceSha256",
    ],
    "pass",
  )
  const started = timestamp(pass.startedAt, "pass.startedAt")
  const completed = timestamp(pass.completedAt, "pass.completedAt")
  if (completed.parsed < started.parsed) throw new Error("migration evidence pass completes before it starts")
  const parsedPass = Object.freeze({
    id: text(pass.id, "pass.id"),
    startedAt: started.raw,
    completedAt: completed.raw,
    separatedFromPreviousMs: count(pass.separatedFromPreviousMs, "pass.separatedFromPreviousMs"),
    requiredSeparationMs: count(pass.requiredSeparationMs, "pass.requiredSeparationMs"),
    ingressSealed: boolean(pass.ingressSealed, "pass.ingressSealed"),
    sourceWatermark: text(pass.sourceWatermark, "pass.sourceWatermark"),
    sourceSha256: sha256(pass.sourceSha256, "pass.sourceSha256"),
  })
  if (!parsedPass.ingressSealed) throw new Error("migration evidence requires sealed source ingress")

  const tenants = record(input.tenants, "tenants")
  exactKeys(tenants, ["discovered", "exported", "truncated", "contentSha256"], "tenants")
  const parsedTenants = Object.freeze({
    discovered: count(tenants.discovered, "tenants.discovered"),
    exported: count(tenants.exported, "tenants.exported"),
    truncated: boolean(tenants.truncated, "tenants.truncated"),
    contentSha256: sha256(tenants.contentSha256, "tenants.contentSha256"),
  })
  if (parsedTenants.truncated || parsedTenants.discovered !== parsedTenants.exported)
    throw new Error("tenant inventory is incomplete")

  if (!Array.isArray(input.tables) || input.tables.length === 0)
    throw new Error("migration evidence has no table inventory")
  const tables = Object.freeze(input.tables.map(disposition))
  if (new Set(tables.map((table) => table.table)).size !== tables.length)
    throw new Error("migration evidence contains duplicate table inventories")

  const providers = record(input.providers, "providers")
  exactKeys(providers, ["clerk", "polar"], "providers")
  const clerk = providerScan(providers.clerk, "providers.clerk")
  let polar: ProviderScan | null = null
  if (input.productPosture === "claxedo-hosted") {
    if (providers.polar === null) throw new Error("claxedo-hosted migration requires a complete Polar reconciliation")
    polar = providerScan(providers.polar, "providers.polar")
  } else if (providers.polar !== null) {
    throw new Error("user-deployed migration must prove the Polar input is absent")
  }

  const optionalFeatures = record(input.optionalFeatures, "optionalFeatures")
  exactKeys(optionalFeatures, ["workgraph", "documents"], "optionalFeatures")
  const parsedOptionalFeatures = Object.freeze({
    workgraph: optionalFeature(optionalFeatures.workgraph, "optionalFeatures.workgraph"),
    documents: optionalFeature(optionalFeatures.documents, "optionalFeatures.documents"),
  })
  for (const [name, feature] of Object.entries(parsedOptionalFeatures)) {
    if (feature.state === "archived-and-deactivated" && Date.parse(feature.dispositionDueAt) <= completed.parsed) {
      throw new Error(`optionalFeatures.${name}.dispositionDueAt must follow the evidence pass`)
    }
  }

  const drains = record(input.drains, "drains")
  const drainKeys = [
    "waitUntil",
    "outbox",
    "connectionClaims",
    "alarms",
    "jobs",
    "leases",
    "documentCapabilities",
    "sandboxResourcesUnaccounted",
  ] as const
  exactKeys(drains, drainKeys, "drains")
  const parsedDrains = Object.freeze(
    Object.fromEntries(drainKeys.map((key) => [key, count(drains[key], `drains.${key}`)])),
  ) as MigrationEvidence["drains"]
  if (drainKeys.some((key) => parsedDrains[key] !== 0))
    throw new Error("migration evidence contains undrained work or resources")

  const usage = record(input.usage, "usage")
  exactKeys(usage, ["recentSource", "recentTarget", "rollupOnlySource", "rollupOnlyTarget"], "usage")
  const parsedUsage = Object.freeze({
    recentSource: count(usage.recentSource, "usage.recentSource"),
    recentTarget: count(usage.recentTarget, "usage.recentTarget"),
    rollupOnlySource: count(usage.rollupOnlySource, "usage.rollupOnlySource"),
    rollupOnlyTarget: count(usage.rollupOnlyTarget, "usage.rollupOnlyTarget"),
  })
  if (
    parsedUsage.recentSource !== parsedUsage.recentTarget ||
    parsedUsage.rollupOnlySource !== parsedUsage.rollupOnlyTarget
  )
    throw new Error("recent and rollup-only usage totals do not conserve independently")

  return Object.freeze({
    schemaVersion: 1,
    deploymentId: text(input.deploymentId, "deploymentId"),
    releaseId: text(input.releaseId, "releaseId"),
    sourceSnapshotId: text(input.sourceSnapshotId, "sourceSnapshotId"),
    productPosture: input.productPosture,
    sourceAdapter: "clerk-convex",
    pass: parsedPass,
    tenants: parsedTenants,
    tables,
    providers: Object.freeze({ clerk, polar }),
    optionalFeatures: parsedOptionalFeatures,
    drains: parsedDrains,
    usage: parsedUsage,
  })
}

function stableEvidenceIdentity(evidence: MigrationEvidence) {
  return JSON.stringify({
    deploymentId: evidence.deploymentId,
    releaseId: evidence.releaseId,
    sourceSnapshotId: evidence.sourceSnapshotId,
    productPosture: evidence.productPosture,
    sourceAdapter: evidence.sourceAdapter,
    requiredSeparationMs: evidence.pass.requiredSeparationMs,
    sourceWatermark: evidence.pass.sourceWatermark,
    sourceSha256: evidence.pass.sourceSha256,
    tenants: evidence.tenants,
    tables: [...evidence.tables].sort((left, right) => left.table.localeCompare(right.table)),
    providers: evidence.providers,
    optionalFeatures: evidence.optionalFeatures,
    drains: evidence.drains,
    usage: evidence.usage,
  })
}

export function migrationEvidenceArtifactSha256(first: MigrationEvidence, second: MigrationEvidence) {
  return `sha256:${createHash("sha256").update(JSON.stringify({ first, second })).digest("hex")}`
}

export function verifyStableMigrationEvidence(firstValue: unknown, secondValue: unknown) {
  const first = verifyMigrationEvidence(firstValue)
  const second = verifyMigrationEvidence(secondValue)
  const sameBinding =
    first.deploymentId === second.deploymentId &&
    first.releaseId === second.releaseId &&
    first.sourceSnapshotId === second.sourceSnapshotId &&
    first.productPosture === second.productPosture &&
    first.sourceAdapter === second.sourceAdapter
  if (!sameBinding) throw new Error("migration evidence passes do not bind the same release and snapshot")
  if (first.pass.id === second.pass.id) throw new Error("migration evidence requires two distinct scan passes")
  const elapsed = Date.parse(second.pass.startedAt) - Date.parse(first.pass.completedAt)
  if (
    elapsed < second.pass.requiredSeparationMs ||
    second.pass.separatedFromPreviousMs !== elapsed ||
    second.pass.separatedFromPreviousMs < second.pass.requiredSeparationMs
  )
    throw new Error("migration evidence passes are not separated by the required background window")
  if (stableEvidenceIdentity(first) !== stableEvidenceIdentity(second))
    throw new Error("migration evidence source or provider scans are not stable")
  return Object.freeze({ first, second })
}

async function main() {
  const paths = process.argv.slice(2)
  if (paths.length !== 2) throw new Error("usage: verify-migration-evidence <first-pass.json> <second-pass.json>")
  const [firstPath, secondPath] = paths
  const [first, second] = await Promise.all([
    readFile(path.resolve(firstPath!), "utf8"),
    readFile(path.resolve(secondPath!), "utf8"),
  ])
  const result = verifyStableMigrationEvidence(JSON.parse(first), JSON.parse(second))
  process.stdout.write(
    `${JSON.stringify({ deploymentId: result.second.deploymentId, releaseId: result.second.releaseId, sourceSnapshotId: result.second.sourceSnapshotId, sourceSha256: result.second.pass.sourceSha256, evidenceSha256: migrationEvidenceArtifactSha256(result.first, result.second), verifiedPasses: [result.first.pass.id, result.second.pass.id] }, null, 2)}\n`,
  )
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) await main()
