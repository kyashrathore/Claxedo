#!/usr/bin/env bun

import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

export const U8_RELEASE_BASELINE_SCHEMA = "claxedo-u8-release-baseline/v1" as const
export const U8_RELEASE_EVIDENCE_SCHEMA = "claxedo-u8-release-evidence/v1" as const
export const U8_RELEASE_GATE_SCHEMA = "claxedo-u8-release-gate/v1" as const

export const REQUIRED_HARNESSES = ["opencode", "codex", "claude", "acp", "pi"] as const
export const REQUIRED_BROWSER_FLOWS = [
  "launch-project",
  "session-switch",
  "live-terminal-switch",
  "large-diff-toggle",
  "workspace-switch",
] as const
export const REQUIRED_BOUNDARY_MANIFESTS = [
  "app-local",
  "local-server",
  "host-connector",
  "server-cloud-node",
  "server-workerd",
  "server-self-hosted",
  "desktop-main",
  "desktop-account",
  "desktop-renderer-local",
  "desktop-renderer-hosted-contributions",
] as const
export const REQUIRED_LIFECYCLE_GATES = [
  "healthReady",
  "storeOnlySessionList",
  "providerFirstUse",
  "ptyFirstOutput",
  "coldStart",
  "warmUse",
  "idleRestart",
  "activeSessionStress",
  "eventLoop",
  "cpu",
  "gcPause",
  "unsignedStartup",
  "signedActivation",
  "userHostedRelay",
  "cloudWorkspace",
  "signOutToLocal",
  "secondUnsignedSettle",
  "optionalResourcesUnloadedAfterSignOut",
] as const
export const REQUIRED_RELEASE_GATES = [
  "hostedDevelopmentIdentity",
  "betaCallbackRegistration",
  "productionCallbackRegistration",
  "selfHostedUpgrade",
  "remoteAccessHardCut",
] as const

const FIXED = {
  cohortSamples: 5,
  settleMs: 60_000,
  medianPhysicalFootprintMiB: 300,
  maximumPhysicalFootprintMiB: 325,
  browserIterations: 3,
  browserOrder: ["baseline", "candidate", "candidate", "baseline"],
} as const

type HarnessCeiling = {
  activePhysicalFootprintMiB: number
  coldLatencyMs: number
  warmLatencyMs: number
  eventLoopDelayMs: number
  cpuMs: number
  gcPauseMs: number
}

export type U8ReleaseBaseline = {
  schema: typeof U8_RELEASE_BASELINE_SCHEMA
  sourceCommit: string
  capturedAt: string
  immutable: true
  thresholds: {
    cohortSamples: number
    settleMs: number
    medianPhysicalFootprintMiB: number
    maximumPhysicalFootprintMiB: number
    browserIterations: number
    browserOrder: string[]
    harnesses: Record<(typeof REQUIRED_HARNESSES)[number], HarnessCeiling>
    browser: Record<(typeof REQUIRED_BROWSER_FLOWS)[number], {
      worstIntervalMs: number
      baselineCompletionMs: number
      completionMultiplier: number
    }>
  }
  metadata: QualificationMetadata
}

type QualificationMetadata = {
  tools: Record<string, string>
  machine: { id: string; os: string; architecture: string }
  thermalState: string
}

type MemorySample = {
  profileId: string
  temporaryProfile: true
  freshProfile: true
  settleMs: number
  physicalFootprintMiB: number
  iosurfaceMiB: number
  summedRssMiB: number
  processRoleFootprintMiB: Record<string, number>
  rendererReady: boolean
  routeReady: boolean
  ptyReady: boolean
  mountedSurface: boolean
  harnessProcesses: number
}

type HarnessSample = {
  activePhysicalFootprintMiB: number
  coldLatencyMs: number
  warmLatencyMs: number
  eventLoopDelayMs: number
  cpuMs: number
  gcPauseMs: number
  mutationSafe: boolean
  streamPassed: boolean
  idleExitPassed: boolean
  parentLossPassed: boolean
  harnessProcessesAfterTeardown: number
}

type BrowserPosition = {
  label: "baseline" | "candidate"
  samples: Array<{
    contextId: string
    worstIntervalMs: number
    completionMs: number
    applicationIntervalsOver16_67Ms: number
    frameDrops: number
  }>
}

type GateReference = { file: string; sha256: string }

export type U8ReleaseEvidence = {
  schema: typeof U8_RELEASE_EVIDENCE_SCHEMA
  releaseSha: string
  baselineSha256: string
  artifact: {
    sha256: string
    buildContract: { file: string; sha256: string }
    productBoundaryPassed: boolean
  }
  metadata: QualificationMetadata & { capturedAt: string; sampleOrder: string[] }
  boundaryManifests: Array<{ name: string; file: string; sha256: string }>
  memory: { freshIdle: MemorySample[]; postSessionIdle: MemorySample[] }
  harnesses: Record<string, HarnessSample[]>
  browser: Record<string, { positions: BrowserPosition[] }>
  desktopLifecycle: Record<string, boolean>
  nativeCredentials: Record<"macos" | "windows" | "linuxProtected", GateReference>
  releaseGates: Record<string, GateReference>
}

export type U8QualificationReport = {
  schema: "claxedo-u8-release-qualification/v1"
  status: "pass"
  qualifiedAt: string
  artifact: { file: string; sha256: string }
  baseline: { file: string; sha256: string; sourceCommit: string }
  evidence: { file: string; releaseSha: string }
  boundaryManifestSetSha256: string
  raw: { baseline: U8ReleaseBaseline; evidence: U8ReleaseEvidence }
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`U8 release qualification failed: ${message}`)
}

function finite(value: unknown, label: string): asserts value is number {
  invariant(typeof value === "number" && Number.isFinite(value) && value >= 0, `${label} must be finite and non-negative`)
}

function hashString(value: unknown, label: string): asserts value is string {
  invariant(typeof value === "string" && /^[0-9a-f]{64}$/.test(value), `${label} must be a SHA-256 digest`)
}

function sha256(file: string) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}

function readJson(file: string): unknown {
  invariant(fs.existsSync(file), `missing input ${file}`)
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    throw new Error(`U8 release qualification failed: could not parse ${file}: ${String(error)}`)
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`)
  return value as Record<string, unknown>
}

function requireMetadata(value: unknown, label: string) {
  const metadata = record(value, label)
  const tools = record(metadata.tools, `${label}.tools`)
  invariant(Object.keys(tools).length > 0, `${label}.tools must not be empty`)
  for (const [name, version] of Object.entries(tools)) {
    invariant(typeof version === "string" && version.trim().length > 0, `${label}.tools.${name} is missing`)
  }
  const machine = record(metadata.machine, `${label}.machine`)
  for (const field of ["id", "os", "architecture"] as const) {
    invariant(typeof machine[field] === "string" && machine[field].trim().length > 0, `${label}.machine.${field} is missing`)
  }
  invariant(typeof metadata.thermalState === "string" && metadata.thermalState.trim().length > 0, `${label}.thermalState is missing`)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string) {
  const missing = expected.filter((key) => !(key in value))
  const extra = Object.keys(value).filter((key) => !expected.includes(key))
  invariant(missing.length === 0 && extra.length === 0, `${label} keys differ (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`)
}

function validateBaseline(value: unknown): U8ReleaseBaseline {
  const baseline = record(value, "baseline")
  invariant(baseline.schema === U8_RELEASE_BASELINE_SCHEMA, `baseline schema must be ${U8_RELEASE_BASELINE_SCHEMA}`)
  invariant(baseline.immutable === true, "baseline must declare immutable=true")
  invariant(typeof baseline.sourceCommit === "string" && /^[0-9a-f]{40}$/.test(baseline.sourceCommit), "baseline sourceCommit must be a full Git SHA")
  invariant(typeof baseline.capturedAt === "string" && !Number.isNaN(Date.parse(baseline.capturedAt)), "baseline capturedAt is invalid")
  requireMetadata(baseline.metadata, "baseline.metadata")
  const thresholds = record(baseline.thresholds, "baseline.thresholds")
  for (const [key, expected] of Object.entries(FIXED)) {
    const actual = thresholds[key]
    invariant(JSON.stringify(actual) === JSON.stringify(expected), `baseline fixed threshold ${key} changed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
  const harnesses = record(thresholds.harnesses, "baseline.thresholds.harnesses")
  exactKeys(harnesses, REQUIRED_HARNESSES, "baseline harnesses")
  for (const name of REQUIRED_HARNESSES) {
    const ceiling = record(harnesses[name], `baseline harness ${name}`)
    exactKeys(ceiling, ["activePhysicalFootprintMiB", "coldLatencyMs", "warmLatencyMs", "eventLoopDelayMs", "cpuMs", "gcPauseMs"], `baseline harness ${name}`)
    for (const [metric, limit] of Object.entries(ceiling)) finite(limit, `baseline harness ${name}.${metric}`)
  }
  const browser = record(thresholds.browser, "baseline.thresholds.browser")
  exactKeys(browser, REQUIRED_BROWSER_FLOWS, "baseline browser flows")
  for (const flow of REQUIRED_BROWSER_FLOWS) {
    const limits = record(browser[flow], `baseline browser ${flow}`)
    exactKeys(limits, ["worstIntervalMs", "baselineCompletionMs", "completionMultiplier"], `baseline browser ${flow}`)
    for (const [metric, limit] of Object.entries(limits)) finite(limit, `baseline browser ${flow}.${metric}`)
    invariant((limits.completionMultiplier as number) > 0, `baseline browser ${flow}.completionMultiplier must be positive`)
  }
  return value as U8ReleaseBaseline
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

function validateMemory(samples: unknown, label: string, profileIds: Set<string>) {
  invariant(Array.isArray(samples) && samples.length === FIXED.cohortSamples, `${label} must contain exactly ${String(FIXED.cohortSamples)} samples`)
  for (const [index, raw] of samples.entries()) {
    const sample = record(raw, `${label}[${String(index)}]`)
    invariant(typeof sample.profileId === "string" && sample.profileId.trim().length > 0, `${label}[${String(index)}].profileId is missing`)
    invariant(!profileIds.has(sample.profileId), `${label}[${String(index)}] reused profile ${sample.profileId}`)
    profileIds.add(sample.profileId)
    invariant(sample.temporaryProfile === true, `${label}[${String(index)}] did not use a temporary profile`)
    invariant(sample.freshProfile === true, `${label}[${String(index)}] profile was not fresh`)
    invariant(sample.settleMs === FIXED.settleMs, `${label}[${String(index)}] did not settle for ${String(FIXED.settleMs)} ms`)
    for (const metric of ["physicalFootprintMiB", "iosurfaceMiB", "summedRssMiB"] as const) finite(sample[metric], `${label}[${String(index)}].${metric}`)
    const roles = record(sample.processRoleFootprintMiB, `${label}[${String(index)}].processRoleFootprintMiB`)
    invariant(Object.keys(roles).length > 0, `${label}[${String(index)}] has no process-role footprint`)
    Object.entries(roles).forEach(([role, amount]) => finite(amount, `${label}[${String(index)}].processRoleFootprintMiB.${role}`))
    for (const gate of ["rendererReady", "routeReady", "ptyReady", "mountedSurface"] as const) {
      invariant(sample[gate] === true, `${label}[${String(index)}].${gate} did not pass`)
    }
    invariant(sample.harnessProcesses === 0, `${label}[${String(index)}] contains harness processes`)
    invariant((sample.physicalFootprintMiB as number) <= FIXED.maximumPhysicalFootprintMiB, `${label}[${String(index)}] physical footprint exceeds ${String(FIXED.maximumPhysicalFootprintMiB)} MiB`)
  }
  invariant(median(samples.map((sample) => (sample as MemorySample).physicalFootprintMiB)) <= FIXED.medianPhysicalFootprintMiB, `${label} median physical footprint exceeds ${String(FIXED.medianPhysicalFootprintMiB)} MiB`)
}

function validateHarnesses(value: unknown, baseline: U8ReleaseBaseline) {
  const harnesses = record(value, "evidence.harnesses")
  exactKeys(harnesses, REQUIRED_HARNESSES, "evidence harnesses")
  for (const name of REQUIRED_HARNESSES) {
    const samples = harnesses[name]
    invariant(Array.isArray(samples) && samples.length === FIXED.cohortSamples, `harness ${name} must contain exactly ${String(FIXED.cohortSamples)} samples`)
    const limits = baseline.thresholds.harnesses[name]
    for (const [index, raw] of samples.entries()) {
      const sample = record(raw, `harness ${name}[${String(index)}]`)
      for (const metric of Object.keys(limits) as Array<keyof HarnessCeiling>) {
        finite(sample[metric], `harness ${name}[${String(index)}].${metric}`)
        invariant((sample[metric] as number) <= limits[metric], `harness ${name}[${String(index)}].${metric} exceeds frozen ceiling`)
      }
      for (const gate of ["mutationSafe", "streamPassed", "idleExitPassed", "parentLossPassed"] as const) {
        invariant(sample[gate] === true, `harness ${name}[${String(index)}].${gate} did not pass`)
      }
      invariant(sample.harnessProcessesAfterTeardown === 0, `harness ${name}[${String(index)}] did not exit after teardown`)
    }
  }
}

function validateBrowser(value: unknown, baseline: U8ReleaseBaseline) {
  const browser = record(value, "evidence.browser")
  exactKeys(browser, REQUIRED_BROWSER_FLOWS, "evidence browser flows")
  for (const flow of REQUIRED_BROWSER_FLOWS) {
    const contextIds = new Set<string>()
    const result = record(browser[flow], `browser ${flow}`)
    const positions = result.positions
    invariant(Array.isArray(positions) && positions.length === FIXED.browserOrder.length, `browser ${flow} must use four ABBA positions`)
    invariant(JSON.stringify(positions.map((position) => record(position, `browser ${flow} position`).label)) === JSON.stringify(FIXED.browserOrder), `browser ${flow} order must be baseline,candidate,candidate,baseline`)
    for (const [positionIndex, rawPosition] of positions.entries()) {
      const position = record(rawPosition, `browser ${flow} position ${String(positionIndex)}`)
      const samples = position.samples
      invariant(Array.isArray(samples) && samples.length === FIXED.browserIterations, `browser ${flow} position ${String(positionIndex)} must contain three iterations`)
      for (const [sampleIndex, rawSample] of samples.entries()) {
        const sample = record(rawSample, `browser ${flow} position ${String(positionIndex)} sample ${String(sampleIndex)}`)
        invariant(typeof sample.contextId === "string" && sample.contextId.trim().length > 0, `browser ${flow} sample contextId is missing`)
        invariant(!contextIds.has(sample.contextId), `browser ${flow} reused context ${sample.contextId}`)
        contextIds.add(sample.contextId)
        for (const metric of ["worstIntervalMs", "completionMs", "applicationIntervalsOver16_67Ms", "frameDrops"] as const) finite(sample[metric], `browser ${flow}.${metric}`)
        if (position.label === "candidate") {
          invariant((sample.worstIntervalMs as number) <= baseline.thresholds.browser[flow].worstIntervalMs, `browser ${flow} exceeds frozen worst-interval budget`)
          invariant((sample.completionMs as number) <= baseline.thresholds.browser[flow].baselineCompletionMs * baseline.thresholds.browser[flow].completionMultiplier, `browser ${flow} exceeds frozen completion ceiling`)
          if (flow !== "launch-project") invariant(sample.applicationIntervalsOver16_67Ms === 0, `browser ${flow} contains application-attributed intervals over 16.67ms`)
        }
      }
    }
  }
}

function resolveReferencedFile(evidenceFile: string, file: string) {
  return path.resolve(path.dirname(evidenceFile), file)
}

function validateGateArtifact(input: {
  reference: unknown
  evidenceFile: string
  gateKey: string
  gateName: string
  releaseSha: string
  manifestSetSha: string
  artifactSha?: string
  nativePlatform?: "macos" | "windows" | "linuxProtected"
}) {
  const reference = record(input.reference, `${input.gateName} reference`)
  exactKeys(reference, ["file", "sha256"], `${input.gateName} reference`)
  invariant(typeof reference.file === "string" && reference.file.length > 0, `${input.gateName} reference file is missing`)
  hashString(reference.sha256, `${input.gateName} reference sha256`)
  const file = resolveReferencedFile(input.evidenceFile, reference.file)
  invariant(fs.existsSync(file) && fs.statSync(file).isFile(), `${input.gateName} evidence is missing at ${file}`)
  invariant(reference.sha256 === sha256(file), `${input.gateName} evidence hash changed`)
  const gate = record(readJson(file), input.gateName)
  invariant(gate.schema === U8_RELEASE_GATE_SCHEMA, `${input.gateName} schema must be ${U8_RELEASE_GATE_SCHEMA}`)
  invariant(gate.gate === input.gateKey, `${input.gateName} artifact names ${String(gate.gate)}`)
  invariant(gate.passed === true, `${input.gateName} did not pass`)
  invariant(gate.releaseSha === input.releaseSha, `${input.gateName} release SHA does not match candidate`)
  invariant(gate.boundaryManifestSetSha256 === input.manifestSetSha, `${input.gateName} boundary manifest set does not match candidate`)
  if (input.artifactSha) invariant(gate.artifactSha256 === input.artifactSha, `${input.gateName} artifact does not match candidate`)
  requireMetadata(gate.metadata, `${input.gateName}.metadata`)
  const results = record(gate.results, `${input.gateName}.results`)
  invariant(Object.keys(results).length > 0, `${input.gateName}.results must not be empty`)

  if (input.nativePlatform) {
    invariant(gate.native === true, `${input.gateName} is not native evidence`)
    invariant(gate.platform === input.nativePlatform, `${input.gateName} platform does not match ${input.nativePlatform}`)
    invariant(typeof gate.nativeBackend === "string" && gate.nativeBackend.trim().length > 0, `${input.gateName} native backend is missing`)
    invariant(gate.protectedStorage === true, `${input.gateName} did not use protected storage`)
    const lifecycle = record(results.credentialLifecycle, `${input.gateName}.results.credentialLifecycle`)
    exactKeys(lifecycle, ["create", "restart", "refresh", "revoke", "corruption", "lockedStore"], `${input.gateName} credential lifecycle`)
    for (const operation of ["create", "restart", "refresh", "revoke", "corruption", "lockedStore"] as const) {
      invariant(lifecycle[operation] === true, `${input.gateName} credential ${operation} did not pass`)
    }
    if (input.nativePlatform === "linuxProtected") {
      invariant(results.basicTextRefused === true, `${input.gateName} did not prove basic_text refusal`)
    }
  }

  return file
}

export function qualifyU8Release(input: {
  artifact: string
  baseline: string
  evidence: string
  outputDir?: string
  now?: () => Date
}): U8QualificationReport {
  const artifact = path.resolve(input.artifact)
  const baselineFile = path.resolve(input.baseline)
  const evidenceFile = path.resolve(input.evidence)
  invariant(fs.existsSync(artifact) && fs.statSync(artifact).isFile(), "artifact must be an existing regular file; qualify the archived installer, not a mutable directory")
  invariant(fs.existsSync(baselineFile) && fs.statSync(baselineFile).isFile(), `missing immutable baseline ${baselineFile}`)
  invariant(fs.existsSync(evidenceFile) && fs.statSync(evidenceFile).isFile(), `missing candidate evidence ${evidenceFile}`)
  const artifactSha = sha256(artifact)
  const baselineSha = sha256(baselineFile)
  const baseline = validateBaseline(readJson(baselineFile))
  const evidenceValue = readJson(evidenceFile)
  const evidence = record(evidenceValue, "evidence")
  invariant(evidence.schema === U8_RELEASE_EVIDENCE_SCHEMA, `evidence schema must be ${U8_RELEASE_EVIDENCE_SCHEMA}`)
  invariant(typeof evidence.releaseSha === "string" && /^[0-9a-f]{40}$/.test(evidence.releaseSha), "evidence releaseSha must be a full Git SHA")
  invariant(evidence.baselineSha256 === baselineSha, "evidence was not captured against the selected immutable baseline")
  requireMetadata(evidence.metadata, "evidence.metadata")
  const metadata = record(evidence.metadata, "evidence.metadata")
  invariant(typeof metadata.capturedAt === "string" && !Number.isNaN(Date.parse(metadata.capturedAt)), "evidence.metadata.capturedAt is invalid")
  invariant(Array.isArray(metadata.sampleOrder) && metadata.sampleOrder.length > 0 && metadata.sampleOrder.every((item) => typeof item === "string" && item.length > 0), "evidence.metadata.sampleOrder is missing")
  const artifactEvidence = record(evidence.artifact, "evidence.artifact")
  invariant(artifactEvidence.sha256 === artifactSha, "artifact hash does not match candidate evidence")
  const buildContract = record(artifactEvidence.buildContract, "evidence.artifact.buildContract")
  invariant(typeof buildContract.file === "string", "candidate build contract file is missing")
  const buildContractFile = resolveReferencedFile(evidenceFile, buildContract.file)
  invariant(fs.existsSync(buildContractFile) && fs.statSync(buildContractFile).isFile(), `candidate build contract is missing at ${buildContractFile}`)
  invariant(buildContract.sha256 === sha256(buildContractFile), "candidate build contract hash changed")
  const contract = record(readJson(buildContractFile), "candidate build contract")
  invariant(contract.channel === "prod", "candidate build contract channel must be prod")
  invariant(contract.source_commit === evidence.releaseSha, "candidate build contract source commit does not match release SHA")
  invariant(typeof contract.built_at === "string" && !Number.isNaN(Date.parse(contract.built_at)), "candidate build contract built_at is invalid")
  const contractInput = record(contract.input, "candidate build contract input")
  const contractOutput = record(contract.output, "candidate build contract output")
  invariant(Object.keys(contractInput).length > 0, "candidate build contract input is empty")
  invariant(Object.keys(contractOutput).length > 0, "candidate build contract output is empty")
  for (const [file, digest] of [...Object.entries(contractInput), ...Object.entries(contractOutput)]) {
    hashString(digest, `candidate build contract hash ${file}`)
  }
  invariant(artifactEvidence.productBoundaryPassed === true, "candidate product-boundary gate did not pass")

  const manifests = evidence.boundaryManifests
  invariant(Array.isArray(manifests), "evidence.boundaryManifests must be an array")
  const manifestRecords = manifests.map((item, index) => record(item, `boundaryManifests[${String(index)}]`))
  invariant(manifestRecords.length === REQUIRED_BOUNDARY_MANIFESTS.length, "boundary manifest set contains duplicate or missing records")
  exactKeys(Object.fromEntries(manifestRecords.map((item) => [String(item.name), item])), REQUIRED_BOUNDARY_MANIFESTS, "boundary manifests")
  for (const manifest of manifestRecords) {
    invariant(typeof manifest.name === "string" && REQUIRED_BOUNDARY_MANIFESTS.includes(manifest.name as (typeof REQUIRED_BOUNDARY_MANIFESTS)[number]), `boundary manifest has an invalid name ${String(manifest.name)}`)
    invariant(typeof manifest.file === "string", `boundary manifest ${manifest.name} has no file`)
    const file = resolveReferencedFile(evidenceFile, manifest.file)
    invariant(fs.existsSync(file) && fs.statSync(file).isFile(), `boundary manifest ${manifest.name} is missing at ${file}`)
    invariant(manifest.sha256 === sha256(file), `boundary manifest ${manifest.name} hash changed`)
    const normalized = record(readJson(file), `boundary manifest ${manifest.name}`)
    invariant(typeof normalized.entry === "string" && normalized.entry.length > 0, `boundary manifest ${manifest.name} has no entry`)
    invariant(Array.isArray(normalized.modules) && normalized.modules.length > 0, `boundary manifest ${manifest.name} has no modules`)
    invariant(Array.isArray(normalized.chunks) && normalized.chunks.length > 0, `boundary manifest ${manifest.name} has no chunks`)
    const edges = record(normalized.edges, `boundary manifest ${manifest.name}.edges`)
    invariant(Array.isArray(edges.static) && Array.isArray(edges.dynamic), `boundary manifest ${manifest.name} has invalid edges`)
  }
  for (const name of ["desktop-main", "desktop-account", "desktop-renderer-local", "desktop-renderer-hosted-contributions"] as const) {
    const manifest = manifestRecords.find((item) => item.name === name)!
    const contractPath = `out/product-boundary/${name}.json`
    invariant(contractOutput[contractPath] === manifest.sha256, `candidate build contract does not fingerprint boundary manifest ${name}`)
  }
  const manifestSetSha = createHash("sha256")
    .update(manifestRecords.map((item) => `${String(item.name)}:${String(item.sha256)}`).sort().join("\n"))
    .digest("hex")

  const memory = record(evidence.memory, "evidence.memory")
  exactKeys(memory, ["freshIdle", "postSessionIdle"], "memory cohorts")
  const profileIds = new Set<string>()
  validateMemory(memory.freshIdle, "fresh-idle", profileIds)
  validateMemory(memory.postSessionIdle, "post-session-idle", profileIds)
  validateHarnesses(evidence.harnesses, baseline)
  validateBrowser(evidence.browser, baseline)

  const lifecycle = record(evidence.desktopLifecycle, "evidence.desktopLifecycle")
  exactKeys(lifecycle, REQUIRED_LIFECYCLE_GATES, "desktop lifecycle gates")
  for (const gate of REQUIRED_LIFECYCLE_GATES) invariant(lifecycle[gate] === true, `desktop lifecycle gate ${gate} did not pass`)

  const credentials = record(evidence.nativeCredentials, "evidence.nativeCredentials")
  exactKeys(credentials, ["macos", "windows", "linuxProtected"], "native credential gates")
  for (const platform of ["macos", "windows", "linuxProtected"] as const) {
    validateGateArtifact({
      reference: credentials[platform],
      evidenceFile,
      gateKey: platform,
      gateName: `native credential gate ${platform}`,
      releaseSha: evidence.releaseSha as string,
      manifestSetSha,
      artifactSha,
      nativePlatform: platform,
    })
  }

  const releaseGates = record(evidence.releaseGates, "evidence.releaseGates")
  exactKeys(releaseGates, REQUIRED_RELEASE_GATES, "release gates")
  for (const gate of REQUIRED_RELEASE_GATES) {
    validateGateArtifact({
      reference: releaseGates[gate],
      evidenceFile,
      gateKey: gate,
      gateName: `release gate ${gate}`,
      releaseSha: evidence.releaseSha as string,
      manifestSetSha,
    })
  }

  const report: U8QualificationReport = {
    schema: "claxedo-u8-release-qualification/v1",
    status: "pass",
    qualifiedAt: (input.now ?? (() => new Date()))().toISOString(),
    artifact: { file: artifact, sha256: artifactSha },
    baseline: { file: baselineFile, sha256: baselineSha, sourceCommit: baseline.sourceCommit },
    evidence: { file: evidenceFile, releaseSha: evidence.releaseSha as string },
    boundaryManifestSetSha256: manifestSetSha,
    raw: { baseline, evidence: evidenceValue as U8ReleaseEvidence },
  }
  const outputDir = path.resolve(input.outputDir ?? path.join(import.meta.dirname, "../../../.artifacts/u8-package-split/release"))
  fs.mkdirSync(outputDir, { recursive: true })
  fs.writeFileSync(path.join(outputDir, "qualification.json"), `${JSON.stringify(report, null, 2)}\n`)
  fs.writeFileSync(path.join(outputDir, "qualification.md"), markdown(report, outputDir))
  return report
}

function markdown(report: U8QualificationReport, outputDir: string) {
  const evidence = report.raw.evidence
  const baseline = report.raw.baseline
  const relativeLink = (file: string) => path.relative(outputDir, resolveReferencedFile(report.evidence.file, file)).replaceAll("\\", "/")
  const manifests = evidence.boundaryManifests
    .map((manifest) => `  - [${manifest.name}](${relativeLink(manifest.file)}) — \`${manifest.sha256}\``)
    .join("\n")
  const nativeGates = Object.entries(evidence.nativeCredentials)
    .map(([name, gate]) => `  - [${name}](${relativeLink(gate.file)}) — \`${gate.sha256}\``)
    .join("\n")
  const releaseGates = Object.entries(evidence.releaseGates)
    .map(([name, gate]) => `  - [${name}](${relativeLink(gate.file)}) — \`${gate.sha256}\``)
    .join("\n")
  return `# U8 release qualification\n\n` +
    `- Status: **${report.status.toUpperCase()}**\n` +
    `- Candidate commit: \`${report.evidence.releaseSha}\`\n` +
    `- Baseline commit: \`${report.baseline.sourceCommit}\`\n` +
    `- Artifact SHA-256: \`${report.artifact.sha256}\`\n` +
    `- Baseline SHA-256: \`${report.baseline.sha256}\`\n` +
    `- Boundary manifest set SHA-256: \`${report.boundaryManifestSetSha256}\`\n` +
    `- Candidate tools: ${Object.entries(evidence.metadata.tools).map(([name, version]) => `${name} ${version}`).join(", ")}\n` +
    `- Candidate machine: ${evidence.metadata.machine.id} (${evidence.metadata.machine.os}, ${evidence.metadata.machine.architecture})\n` +
    `- Candidate thermal state: ${evidence.metadata.thermalState}\n` +
    `- Sample order: ${evidence.metadata.sampleOrder.join(" → ")}\n` +
    `- Baseline machine: ${baseline.metadata.machine.id} (${baseline.metadata.machine.os}, ${baseline.metadata.machine.architecture})\n` +
    `- Qualified at: ${report.qualifiedAt}\n\n` +
    `## Raw evidence\n\n` +
    `All raw samples, metadata, and gate results are retained in [qualification.json](./qualification.json). ` +
    `The report contains ${evidence.memory.freshIdle.length} fresh-idle and ${evidence.memory.postSessionIdle.length} post-session-idle samples, ` +
    `${Object.values(evidence.harnesses).reduce((total, samples) => total + samples.length, 0)} harness samples, and ` +
    `${Object.values(evidence.browser).reduce((total, flow) => total + flow.positions.reduce((count, position) => count + position.samples.length, 0), 0)} browser iterations.\n\n` +
    `## Structural manifests\n\n${manifests}\n\n` +
    `## Native credential gates\n\n${nativeGates}\n\n` +
    `## Release gates\n\n${releaseGates}\n`
}

function argument(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (import.meta.main) {
  const artifact = argument("--artifact")
  const baseline = argument("--baseline")
  const evidence = argument("--evidence") ?? process.env.CLAXEDO_U8_RELEASE_EVIDENCE ?? path.resolve(import.meta.dirname, "../../../.artifacts/u8-package-split/release/candidate.json")
  if (!artifact || !baseline) {
    throw new Error("usage: bun run qualify:u8-release -- --artifact <archived-installer> --baseline <immutable-baseline> [--evidence <candidate-evidence>]")
  }
  const report = qualifyU8Release({ artifact, baseline, evidence })
  console.log(`[u8-release] qualified ${report.evidence.releaseSha} against artifact ${report.artifact.sha256}`)
}
