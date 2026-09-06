import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  MEASUREMENT_RUNTIME_REQUIRED_PACKAGES,
  captureSourceControl,
  captureSourceProvenance,
  captureMeasurementProvenance,
  digestNamedBytes,
  digestRequiredMeasurementDirectory,
  measurementProvenanceStable,
  measurementProvenanceEvidence,
  resolveMeasurementSourceRoots,
  scanMeasurementSource,
  type MeasurementProvenance,
} from "../src/measurement-provenance"

test("source digest is order-independent but binds names and bytes", () => {
  const first = digestNamedBytes([
    { name: "b.ts", bytes: "two" },
    { name: "a.ts", bytes: "one" },
  ])
  expect(first).toBe(digestNamedBytes([
    { name: "a.ts", bytes: "one" },
    { name: "b.ts", bytes: "two" },
  ]))
  expect(first).not.toBe(digestNamedBytes([
    { name: "a.ts", bytes: "one" },
    { name: "b.ts", bytes: "changed" },
  ]))
})

const requiredDependencies = Object.keys(MEASUREMENT_RUNTIME_REQUIRED_PACKAGES)
  .filter((name) => name !== "@claxedo/app" && name !== "@opencode-ai/session-ui")

async function writePackage(root: string, relativeDirectory: string, name: string, dependencies: Record<string, string> = {}) {
  await mkdir(path.join(root, relativeDirectory, "src"), { recursive: true })
  await writeFile(path.join(root, relativeDirectory, "package.json"), `${JSON.stringify({ name, dependencies })}\n`)
  await writeFile(path.join(root, relativeDirectory, "src/index.ts"), `export const packageName = ${JSON.stringify(name)}\n`)
}

const temporaryRoots: string[] = []
async function temporaryRoot(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function sourceTree(prefix: string) {
  const root = await temporaryRoot(prefix)
  for (const [name, relativeDirectory] of Object.entries(MEASUREMENT_RUNTIME_REQUIRED_PACKAGES)) {
    const dependencies = name === "@claxedo/app"
      ? Object.fromEntries(requiredDependencies.map((dependency) => [dependency, "workspace:*"]))
      : name === "@opencode-ai/ui"
        ? { "@fixture/derived-runtime": "workspace:*" }
        : {}
    await writePackage(root, relativeDirectory, name, dependencies)
  }
  await writePackage(root, "packages/derived-runtime", "@fixture/derived-runtime")
  return root
}

async function runGit(directory: string, args: string[]) {
  const child = Bun.spawn({ cmd: ["git", "-C", directory, ...args], stdout: "pipe", stderr: "pipe" })
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`)
}

test("Git and raw workspaces use the same complete runtime source closure", async () => {
  const gitRoot = await sourceTree("measurement-provenance-git-")
  const rawRoot = await sourceTree("measurement-provenance-raw-")
  await runGit(gitRoot, ["init"])
  await runGit(gitRoot, ["add", "."])
  await runGit(gitRoot, ["-c", "user.name=Perf Test", "-c", "user.email=perf@example.test", "commit", "-m", "fixture"])
  await mkdir(path.join(rawRoot, ".crabbox"), { recursive: true })
  await mkdir(path.join(rawRoot, ".git"), { recursive: true })
  await writeFile(path.join(rawRoot, ".crabbox/sync-fingerprint"), `${"a".repeat(64)}\n`)

  const [gitSource, rawSource, gitControl, rawControl] = await Promise.all([
    scanMeasurementSource(gitRoot),
    scanMeasurementSource(rawRoot),
    captureSourceControl(gitRoot),
    captureSourceControl(rawRoot),
  ])
  expect(gitSource).toEqual(rawSource)
  expect(gitSource.roots).toContain("packages/derived-runtime")
  expect(gitControl.sourceControlMode).toBe("git")
  if (gitControl.sourceControlMode !== "git") throw new Error("expected Git provenance")
  expect(gitControl.commit).toMatch(/^[0-9a-f]{40}$/)
  expect(gitControl.gitTree).toMatch(/^[0-9a-f]{40}$/)
  expect(gitControl.dirty).toBe(false)
  expect(rawControl).toEqual({
    sourceControlMode: "crabbox-raw",
    rawSyncFingerprint: "a".repeat(64),
  })
})

test("every explicit runtime owner and a derived dependency affect the source hash", async () => {
  const root = await sourceTree("measurement-provenance-closure-")
  const roots = await resolveMeasurementSourceRoots(root)
  const representatives = [...Object.values(MEASUREMENT_RUNTIME_REQUIRED_PACKAGES), "packages/derived-runtime"]
  expect(roots).toEqual(expect.arrayContaining(representatives))
  const before = await scanMeasurementSource(root)
  for (const relativeDirectory of representatives) {
    const mutation = path.join(root, relativeDirectory, "src/provenance-mutation.ts")
    await writeFile(mutation, `export default ${JSON.stringify(relativeDirectory)}\n`)
    expect((await scanMeasurementSource(root)).sha256).not.toBe(before.sha256)
    await rm(mutation)
  }
})

test("generated and runtime output churn does not affect the source hash", async () => {
  const root = await sourceTree("measurement-provenance-outputs-")
  const before = await scanMeasurementSource(root)
  const outputs = [
    "node_modules/pkg",
    "dist/assets",
    "dist-control",
    "reports",
    "test-results",
    "coverage",
    ".turbo",
    "tmp",
    "build",
    "out",
    "ts-dist",
    ".sst",
    ".next",
    ".output",
    ".svelte-kit",
    "logs",
    "script/.mermaid-wiring",
    "dev-docs",
    ".dev-docs",
    "perf-harness/data",
  ]
  for (const relativeDirectory of outputs) {
    const directory = path.join(root, "packages/claxedo-app", relativeDirectory)
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, "generated.json"), JSON.stringify({ at: Date.now() }))
  }
  await writeFile(path.join(root, "packages/claxedo-app/runtime.log"), "generated")
  await writeFile(path.join(root, "packages/claxedo-app/cache.tsbuildinfo"), "generated")
  expect(await scanMeasurementSource(root)).toEqual(before)

  await writeFile(path.join(root, "packages/claxedo-app/new-untracked.config.ts"), "export default true\n")
  const after = await scanMeasurementSource(root)
  expect(after.files).toBe(before.files + 1)
  expect(after.sha256).not.toBe(before.sha256)
})

test("local Claude permissions are excluded without excluding neighboring Claude config", async () => {
  const root = await sourceTree("measurement-provenance-claude-local-")
  const before = await scanMeasurementSource(root)
  const claudeDirectory = path.join(root, "packages/claxedo-app/.claude")
  await mkdir(claudeDirectory, { recursive: true })
  await writeFile(path.join(claudeDirectory, "settings.local.json"), "{\"permissions\":{}}\n")
  expect(await scanMeasurementSource(root)).toEqual(before)

  await writeFile(path.join(claudeDirectory, "project.json"), "{\"runtime\":true}\n")
  const withNeighbor = await scanMeasurementSource(root)
  expect(withNeighbor.files).toBe(before.files + 1)
  expect(withNeighbor.sha256).not.toBe(before.sha256)
})

test("missing, root-symlinked, and nested-symlinked source is rejected", async () => {
  const missing = await sourceTree("measurement-provenance-missing-")
  await rm(path.join(missing, "packages/ui"), { recursive: true })
  await expect(resolveMeasurementSourceRoots(missing)).rejects.toThrow(/required|owner mismatch|missing|unresolved/u)

  const rootSymlink = await sourceTree("measurement-provenance-root-link-")
  const externalRoot = await temporaryRoot("measurement-provenance-external-root-")
  await rm(path.join(rootSymlink, "packages/ui"), { recursive: true })
  await symlink(externalRoot, path.join(rootSymlink, "packages/ui"), "dir")
  await expect(scanMeasurementSource(rootSymlink)).rejects.toThrow(/symlink/u)

  const nestedSymlink = await sourceTree("measurement-provenance-nested-link-")
  const externalFile = path.join(await temporaryRoot("measurement-provenance-external-file-"), "outside.ts")
  await writeFile(externalFile, "export default false\n")
  await symlink(externalFile, path.join(nestedSymlink, "packages/claxedo-app/src/outside.ts"))
  await expect(scanMeasurementSource(nestedSymlink)).rejects.toThrow(/does not follow.*symlink/u)
})

test("build digest requires a real, non-symlinked, non-empty dist root", async () => {
  const root = await sourceTree("measurement-provenance-dist-")
  await expect(digestRequiredMeasurementDirectory(root, "packages/claxedo-app/dist")).rejects.toThrow(/missing/u)
  const external = await temporaryRoot("measurement-provenance-dist-external-")
  await writeFile(path.join(external, "main.js"), "built")
  await symlink(external, path.join(root, "packages/claxedo-app/dist"), "dir")
  await expect(digestRequiredMeasurementDirectory(root, "packages/claxedo-app/dist")).rejects.toThrow(/symlinked/u)
  await rm(path.join(root, "packages/claxedo-app/dist"))
  await mkdir(path.join(root, "packages/claxedo-app/dist"))
  await expect(digestRequiredMeasurementDirectory(root, "packages/claxedo-app/dist")).rejects.toThrow(/empty/u)
  await writeFile(path.join(root, "packages/claxedo-app/dist/main.js"), "built")
  expect(await digestRequiredMeasurementDirectory(root, "packages/claxedo-app/dist")).toMatch(/^[0-9a-f]{64}$/)
})

function provenance(control: "git" | "crabbox-raw"): MeasurementProvenance {
  const common = {
    capturedAt: "2026-08-24T00:00:00.000Z",
    sourceSha256: "b".repeat(64),
    sourceFileCount: 10,
    sourceRoots: ["packages/claxedo-app"],
    appBuildSha256: "c".repeat(64),
    appCommand: "vite preview",
    browser: { name: "chromium" as const, version: "1" },
    host: {
      hostname: "host",
      platform: "linux",
      release: "1",
      architecture: "x64",
      cpu: "cpu",
      logicalCpuCount: 8,
      totalMemoryBytes: 1,
    },
    command: ["memory"],
  }
  return control === "git"
    ? { ...common, sourceControlMode: "git", commit: "d".repeat(40), gitTree: "e".repeat(40), dirty: false, statusSha256: "f".repeat(64) }
    : { ...common, sourceControlMode: "crabbox-raw", rawSyncFingerprint: "a".repeat(64) }
}

test("stability binds source-control mode and its authoritative identity", () => {
  const raw = provenance("crabbox-raw")
  if (raw.sourceControlMode !== "crabbox-raw") throw new Error("expected raw provenance")
  expect(measurementProvenanceStable(raw, { ...raw })).toBe(true)
  expect(measurementProvenanceStable(raw, { ...raw, rawSyncFingerprint: "9".repeat(64) })).toBe(false)
  expect(measurementProvenanceStable(raw, provenance("git"))).toBe(false)
  const git = provenance("git")
  if (git.sourceControlMode !== "git") throw new Error("expected Git provenance")
  expect(measurementProvenanceStable(git, { ...git })).toBe(true)
  expect(measurementProvenanceStable(git, { ...git, statusSha256: "8".repeat(64) })).toBe(false)
})

async function rawSourceTree(prefix: string) {
  const root = await sourceTree(prefix)
  await mkdir(path.join(root, ".crabbox"))
  await writeFile(path.join(root, ".crabbox/sync-fingerprint"), "a".repeat(64))
  return root
}

test("a source change during build cannot be certified by matching post-build snapshots", async () => {
  const root = await rawSourceTree("measurement-build-race-")
  try {
    const buildSource = await captureSourceProvenance(root)
    const dist = path.join(root, "packages/claxedo-app/dist")
    await mkdir(dist)
    await writeFile(path.join(dist, "app.js"), "built from earlier source")
    await writeFile(path.join(root, "packages/claxedo-app/src/index.ts"), "source changed during build")
    const capture = () => captureMeasurementProvenance({ repository: root, browserVersion: "1", appCommand: "vite preview" })
    const build = await capture()
    const start = await capture()
    const end = await capture()
    expect(measurementProvenanceStable(start, end)).toBe(true)
    const evidence = measurementProvenanceEvidence({ buildSource, build, start, end, artifactMode: "built" })
    expect(evidence.sourceStable).toBe(false)
    expect(evidence.start.appBuildSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(evidence.sourceIdentity.sourceSha256).toBe(start.sourceSha256)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("artifact mutation invalidates a measurement even when all source identities match", async () => {
  const root = await rawSourceTree("measurement-artifact-race-")
  try {
    const buildSource = await captureSourceProvenance(root)
    const dist = path.join(root, "packages/claxedo-app/dist")
    await mkdir(dist)
    await writeFile(path.join(dist, "app.js"), "original artifact")
    const capture = () => captureMeasurementProvenance({ repository: root, browserVersion: "1", appCommand: "vite preview" })
    const build = await capture()
    const start = await capture()
    expect(measurementProvenanceEvidence({ buildSource, build, start, end: start, artifactMode: "built" }).sourceStable).toBe(true)
    await writeFile(path.join(dist, "app.js"), "artifact replaced during measurement")
    const end = await capture()
    expect(end.sourceSha256).toBe(start.sourceSha256)
    expect(measurementProvenanceEvidence({ buildSource, build, start, end, artifactMode: "built" }).sourceStable).toBe(false)
    await rm(dist, { recursive: true })
    const finalCapture = await capture().then(
      (end) => ({ end }),
      (error: Error) => ({ captureError: error.message }),
    )
    const unavailable = measurementProvenanceEvidence({ buildSource, build, start, ...finalCapture, artifactMode: "built" })
    expect(unavailable.sourceStable).toBe(false)
    expect(unavailable.captureError).toContain("missing")
    expect(unavailable.start.appBuildSha256).toBe(start.appBuildSha256)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("development attribution records absent artifact evidence without weakening built measurement checks", async () => {
  const root = await rawSourceTree("measurement-source-only-")
  try {
    const buildSource = await captureSourceProvenance(root)
    const input = { repository: root, browserVersion: "1", appCommand: "vite dev" }
    await expect(captureMeasurementProvenance(input)).rejects.toThrow(/missing/)
    const sourceOnly = await captureMeasurementProvenance({ ...input, artifactMode: "source-only" })
    expect(sourceOnly.appBuildSha256).toBeUndefined()
    expect(sourceOnly.artifactUnavailableReason).toContain("no built artifact was measured")
    expect(measurementProvenanceStable(sourceOnly, sourceOnly)).toBe(false)
    expect(measurementProvenanceEvidence({
      buildSource, build: sourceOnly, start: sourceOnly, end: sourceOnly, artifactMode: "source-only",
    }).sourceStable).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
