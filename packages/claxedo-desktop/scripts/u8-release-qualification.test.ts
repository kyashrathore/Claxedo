import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import {
  qualifyU8Release,
  REQUIRED_BOUNDARY_MANIFESTS,
  REQUIRED_BROWSER_FLOWS,
  REQUIRED_HARNESSES,
  REQUIRED_LIFECYCLE_GATES,
  REQUIRED_RELEASE_GATES,
  U8_RELEASE_BASELINE_SCHEMA,
  U8_RELEASE_EVIDENCE_SCHEMA,
  U8_RELEASE_GATE_SCHEMA,
  type U8ReleaseBaseline,
  type U8ReleaseEvidence,
} from "./u8-release-qualification"

const roots: string[] = []
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex")

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-u8-release-"))
  roots.push(root)
  const artifact = path.join(root, "Claxedo.zip")
  fs.writeFileSync(artifact, "fingerprinted packaged artifact")
  const buildContract = path.join(root, "build-contract.json")
  const baselineFile = path.join(root, "baseline.json")
  const evidenceFile = path.join(root, "candidate.json")
  const outputDir = path.join(root, "output")
  const metadata = {
    tools: { bun: "1.3.14", electron: "43.2.0" },
    machine: { id: "quiet-mac-1", os: "macOS 26.2", architecture: "arm64" },
    thermalState: "nominal",
  }
  const harnessLimit = {
    activePhysicalFootprintMiB: 600,
    coldLatencyMs: 2_000,
    warmLatencyMs: 1_000,
    eventLoopDelayMs: 50,
    cpuMs: 5_000,
    gcPauseMs: 25,
  }
  const baseline: U8ReleaseBaseline = {
    schema: U8_RELEASE_BASELINE_SCHEMA,
    sourceCommit: "a".repeat(40),
    capturedAt: "2026-08-01T00:00:00.000Z",
    immutable: true,
    thresholds: {
      cohortSamples: 5,
      settleMs: 60_000,
      medianPhysicalFootprintMiB: 300,
      maximumPhysicalFootprintMiB: 325,
      browserIterations: 3,
      browserOrder: ["baseline", "candidate", "candidate", "baseline"],
      harnesses: Object.fromEntries(REQUIRED_HARNESSES.map((name) => [name, harnessLimit])) as U8ReleaseBaseline["thresholds"]["harnesses"],
      browser: Object.fromEntries(REQUIRED_BROWSER_FLOWS.map((flow) => [flow, {
        worstIntervalMs: 20,
        baselineCompletionMs: 1_000,
        completionMultiplier: 1.2,
      }])) as U8ReleaseBaseline["thresholds"]["browser"],
    },
    metadata,
  }
  fs.writeFileSync(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`)

  const manifests = REQUIRED_BOUNDARY_MANIFESTS.map((name) => {
    const file = path.join(root, `${name}.json`)
    fs.writeFileSync(file, `${JSON.stringify({ entry: name, modules: [name], chunks: [`${name}.js`], edges: { static: [], dynamic: [] } })}\n`)
    return { name, file: path.basename(file), sha256: hash(file) }
  })
  const manifestSetSha = createHash("sha256")
    .update(manifests.map((item) => `${item.name}:${item.sha256}`).sort().join("\n"))
    .digest("hex")
  const releaseSha = "b".repeat(40)
  fs.writeFileSync(buildContract, `${JSON.stringify({
    built_at: "2026-08-09T00:00:00.000Z",
    channel: "prod",
    source_commit: releaseSha,
    input: { "src/main.ts": "c".repeat(64) },
    output: {
      "installer/Claxedo.zip": hash(artifact),
      ...Object.fromEntries(manifests
        .filter((manifest) => manifest.name.startsWith("desktop-"))
        .map((manifest) => [`out/product-boundary/${manifest.name}.json`, manifest.sha256])),
    },
  })}\n`)
  const memorySample = {
    profileId: "assigned-per-sample",
    temporaryProfile: true as const,
    freshProfile: true as const,
    settleMs: 60_000,
    physicalFootprintMiB: 280,
    iosurfaceMiB: 10,
    summedRssMiB: 350,
    processRoleFootprintMiB: { main: 80, renderer: 120, server: 80 },
    rendererReady: true,
    routeReady: true,
    ptyReady: true,
    mountedSurface: true,
    harnessProcesses: 0,
  }
  const harnessSample = {
    activePhysicalFootprintMiB: 500,
    coldLatencyMs: 1_500,
    warmLatencyMs: 700,
    eventLoopDelayMs: 20,
    cpuMs: 4_000,
    gcPauseMs: 10,
    mutationSafe: true,
    streamPassed: true,
    idleExitPassed: true,
    parentLossPassed: true,
    harnessProcessesAfterTeardown: 0,
  }
  let browserContext = 0
  const browserPosition = (label: "baseline" | "candidate") => ({
    label,
    samples: Array.from({ length: 3 }, () => ({
      contextId: `context-${String(browserContext++)}`,
      worstIntervalMs: 15,
      completionMs: 900,
      applicationIntervalsOver16_67Ms: 0,
      frameDrops: 0,
    })),
  })
  const gateFiles = new Map<string, string>()
  const gate = (key: string, options: { artifact?: boolean; nativePlatform?: "macos" | "windows" | "linuxProtected" } = {}) => {
    const file = path.join(root, `${key}.json`)
    const native = options.nativePlatform !== undefined
    fs.writeFileSync(file, `${JSON.stringify({
      schema: U8_RELEASE_GATE_SCHEMA,
      gate: key,
      passed: true,
      releaseSha,
      boundaryManifestSetSha256: manifestSetSha,
      ...(options.artifact ? { artifactSha256: hash(artifact) } : {}),
      metadata,
      ...(native ? {
        native: true,
        platform: options.nativePlatform,
        nativeBackend: options.nativePlatform === "macos" ? "safeStorage/keychain" : options.nativePlatform === "windows" ? "safeStorage/dpapi" : "safeStorage/libsecret",
        protectedStorage: true,
      } : {}),
      results: native ? {
        credentialLifecycle: {
          create: true,
          restart: true,
          refresh: true,
          revoke: true,
          corruption: true,
          lockedStore: true,
        },
        ...(options.nativePlatform === "linuxProtected" ? { basicTextRefused: true } : {}),
      } : { completed: true },
    }, null, 2)}\n`)
    gateFiles.set(key, file)
    return { file: path.basename(file), sha256: hash(file) }
  }
  const evidence: U8ReleaseEvidence = {
    schema: U8_RELEASE_EVIDENCE_SCHEMA,
    releaseSha,
    baselineSha256: hash(baselineFile),
    artifact: {
      sha256: hash(artifact),
      buildContract: { file: path.basename(buildContract), sha256: hash(buildContract) },
      productBoundaryPassed: true,
    },
    metadata: {
      ...metadata,
      capturedAt: "2026-08-09T00:00:00.000Z",
      sampleOrder: ["fresh-idle", "active", "post-session-idle", "browser-abba"],
    },
    boundaryManifests: manifests,
    memory: {
      freshIdle: Array.from({ length: 5 }, (_, index) => ({ ...memorySample, profileId: `fresh-${String(index)}` })),
      postSessionIdle: Array.from({ length: 5 }, (_, index) => ({ ...memorySample, profileId: `post-${String(index)}` })),
    },
    harnesses: Object.fromEntries(REQUIRED_HARNESSES.map((name) => [
      name,
      Array.from({ length: 5 }, () => ({ ...harnessSample })),
    ])),
    browser: Object.fromEntries(REQUIRED_BROWSER_FLOWS.map((flow) => [flow, {
      positions: [browserPosition("baseline"), browserPosition("candidate"), browserPosition("candidate"), browserPosition("baseline")],
    }])),
    desktopLifecycle: Object.fromEntries(REQUIRED_LIFECYCLE_GATES.map((gate) => [gate, true])),
    nativeCredentials: {
      macos: gate("macos", { artifact: true, nativePlatform: "macos" }),
      windows: gate("windows", { artifact: true, nativePlatform: "windows" }),
      linuxProtected: gate("linuxProtected", { artifact: true, nativePlatform: "linuxProtected" }),
    },
    releaseGates: Object.fromEntries(REQUIRED_RELEASE_GATES.map((name) => [name, gate(name)])),
  }
  const writeEvidence = () => fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`)
  writeEvidence()
  return { root, artifact, baselineFile, evidenceFile, outputDir, baseline, evidence, gateFiles, writeEvidence }
}

describe("U8 release qualification", () => {
  const qualify = (input: ReturnType<typeof fixture>) => qualifyU8Release({
    artifact: input.artifact,
    baseline: input.baselineFile,
    evidence: input.evidenceFile,
    outputDir: input.outputDir,
  })

  test("accepts only a complete exact-artifact cohort and writes raw JSON plus Markdown", () => {
    const input = fixture()
    const report = qualifyU8Release({
      artifact: input.artifact,
      baseline: input.baselineFile,
      evidence: input.evidenceFile,
      outputDir: input.outputDir,
      now: () => new Date("2026-08-09T01:02:03.000Z"),
    })

    expect(report.status).toBe("pass")
    expect(report.artifact.sha256).toBe(hash(input.artifact))
    expect(report.raw.evidence.memory.freshIdle).toHaveLength(5)
    expect(JSON.parse(fs.readFileSync(path.join(input.outputDir, "qualification.json"), "utf8"))).toMatchObject({
      status: "pass",
      qualifiedAt: "2026-08-09T01:02:03.000Z",
    })
    expect(fs.readFileSync(path.join(input.outputDir, "qualification.md"), "utf8")).toContain("Status: **PASS**")
  })

  test("rejects a changed fixed threshold instead of accepting a rewritten baseline", () => {
    const input = fixture()
    input.baseline.thresholds.maximumPhysicalFootprintMiB = 400
    fs.writeFileSync(input.baselineFile, `${JSON.stringify(input.baseline)}\n`)
    input.evidence.baselineSha256 = hash(input.baselineFile)
    input.writeEvidence()

    expect(() => qualify(input)).toThrow("fixed threshold maximumPhysicalFootprintMiB changed")
  })

  test("rejects missing cohorts, mismatched artifacts, and non-native platform claims", () => {
    const missing = fixture()
    missing.evidence.memory.freshIdle.pop()
    missing.writeEvidence()
    expect(() => qualify(missing)).toThrow("fresh-idle must contain exactly 5 samples")

    const mismatch = fixture()
    fs.writeFileSync(mismatch.artifact, "different artifact bytes")
    expect(() => qualify(mismatch)).toThrow("artifact hash does not match candidate evidence")

    const mocked = fixture()
    const windowsGate = mocked.gateFiles.get("windows")!
    const body = JSON.parse(fs.readFileSync(windowsGate, "utf8"))
    body.native = false
    fs.writeFileSync(windowsGate, `${JSON.stringify(body)}\n`)
    mocked.evidence.nativeCredentials.windows.sha256 = hash(windowsGate)
    mocked.writeEvidence()
    expect(() => qualify(mocked)).toThrow("native credential gate windows is not native evidence")
  })

  test("rejects failed correctness gates and browser order drift", () => {
    const correctness = fixture()
    correctness.evidence.memory.postSessionIdle[2]!.ptyReady = false
    correctness.writeEvidence()
    expect(() => qualify(correctness)).toThrow("post-session-idle[2].ptyReady did not pass")

    const browser = fixture()
    browser.evidence.browser["session-switch"]!.positions[0]!.label = "candidate"
    browser.writeEvidence()
    expect(() => qualify(browser)).toThrow("order must be baseline,candidate,candidate,baseline")
  })

  test("rejects a reused temporary profile", () => {
    const profile = fixture()
    profile.evidence.memory.postSessionIdle[0]!.profileId = profile.evidence.memory.freshIdle[0]!.profileId
    profile.writeEvidence()
    expect(() => qualify(profile)).toThrow("reused profile")
  })

  test("rejects a non-fresh profile and a shortened settle", () => {
    const stale = fixture()
    stale.evidence.memory.freshIdle[0]!.freshProfile = false as true
    stale.writeEvidence()
    expect(() => qualify(stale)).toThrow("profile was not fresh")

    const short = fixture()
    short.evidence.memory.postSessionIdle[0]!.settleMs = 59_999
    short.writeEvidence()
    expect(() => qualify(short)).toThrow("did not settle for 60000 ms")
  })

  test("rejects a reused browser context", () => {
    const browser = fixture()
    browser.evidence.browser["workspace-switch"]!.positions[1]!.samples[0]!.contextId =
      browser.evidence.browser["workspace-switch"]!.positions[0]!.samples[0]!.contextId
    browser.writeEvidence()
    expect(() => qualify(browser)).toThrow("reused context")
  })

  test("rejects release SHA drift from the build contract", () => {
    const commit = fixture()
    const contract = JSON.parse(fs.readFileSync(path.join(commit.root, "build-contract.json"), "utf8"))
    contract.source_commit = "c".repeat(40)
    fs.writeFileSync(path.join(commit.root, "build-contract.json"), `${JSON.stringify(contract)}\n`)
    commit.evidence.artifact.buildContract.sha256 = hash(path.join(commit.root, "build-contract.json"))
    commit.writeEvidence()
    expect(() => qualify(commit)).toThrow("build contract source commit does not match release SHA")
  })

  test("rejects a desktop manifest that is not fingerprinted by the build contract", () => {
    const input = fixture()
    const contractFile = path.join(input.root, "build-contract.json")
    const contract = JSON.parse(fs.readFileSync(contractFile, "utf8"))
    delete contract.output["out/product-boundary/desktop-account.json"]
    fs.writeFileSync(contractFile, `${JSON.stringify(contract)}\n`)
    input.evidence.artifact.buildContract.sha256 = hash(contractFile)
    input.writeEvidence()

    expect(() => qualify(input)).toThrow("does not fingerprint boundary manifest desktop-account")
  })
})
