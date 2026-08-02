import { spawn } from "node:child_process"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build as esbuildBuild } from "esbuild"
import { defaultSandboxImage, defaultSnapshotName, SANDBOX_IMAGE_REPOSITORY } from "@claxedo/sandbox-manager/image"
import { claxedoWorkspaceRuntimeEntry, workspaceRuntimeRoot, workspaceRuntimeVersion } from "../../src/hosts/workspace-runtime/startup"

type Exec = (cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) => void

// Bins the image symlinks next to the host bundle; they must be present in the
// collected dependency set (versions come from workspace package.jsons).
const IMAGE_REQUIRED_DEPENDENCIES = [
  "better-sqlite3",
  "node-pty",
  "@agentclientprotocol/claude-agent-acp",
  "@agentclientprotocol/codex-acp",
]

export const HOST_BUNDLE_FILENAME = "workspace-runtime-host.mjs"
export const OPENCODE_BINARY_FILENAME = "opencode"
export const WORKSPACE_RUNTIME_VERSION_FILENAME = "workspace-runtime-version"

function defaultExec(cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) {
  execFileSync(cmd, args, {
    stdio: "inherit",
    ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    ...(opts?.env ? { env: opts.env } : {}),
  })
}

function packagesRoot() {
  return path.resolve(workspaceRuntimeRoot(), "..")
}

function opencodeRoot() {
  return path.join(packagesRoot(), "opencode")
}

/**
 * Merge the external (non-@claxedo) runtime dependencies of workspace-runtime
 * and every @claxedo workspace package it transitively depends on. The
 * @claxedo code itself ships inside the esbuild bundle; everything else is
 * npm-installed in the image from these exact pins.
 */
export function hostBundleDependencies(readPackageJson: (dir: string) => { name?: string; dependencies?: Record<string, string> } = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))) {
  const dependencies: Record<string, string> = {}
  const visited = new Set<string>()
  const queue = [workspaceRuntimeRoot()]
  while (queue.length) {
    const dir = queue.shift()!
    if (visited.has(dir)) continue
    visited.add(dir)
    const pkg = readPackageJson(dir)
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
      if (name.startsWith("@claxedo/")) {
        queue.push(path.join(packagesRoot(), name.slice("@claxedo/".length)))
        continue
      }
      const existing = dependencies[name]
      if (existing) {
        if (existing !== version) {
          // BFS from workspace-runtime: its own pin wins. The image installs
          // one flat dependency set, mirroring what bundling would pick.
          console.warn(`[build-sandbox-image] dependency pin conflict for ${name}: keeping ${existing}, ignoring ${version} (${pkg.name ?? dir})`)
        }
        continue
      }
      dependencies[name] = version
    }
  }
  for (const name of IMAGE_REQUIRED_DEPENDENCIES) {
    if (!dependencies[name]) {
      throw new Error(`workspace package.jsons are missing image dependency: ${name}`)
    }
  }
  return dependencies
}

type PackageJson = { name?: string; dependencies?: Record<string, string>; scripts?: Record<string, string> }

const readPackageJsonFromDisk = (dir: string): PackageJson =>
  JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))

/**
 * Return the on-disk directories of every @claxedo workspace package in the
 * transitive dependency graph of workspace-runtime, in build order —
 * dependencies before dependents (post-order DFS). workspace-runtime is always
 * last. Directories are unique and mirror `hostBundleDependencies`' @claxedo
 * traversal, but here we need the packages themselves (their gitignored dist/
 * must exist before esbuild bundles them), not their external npm pins.
 */
export function workspacePackageBuildOrder(
  readPackageJson: (dir: string) => PackageJson = readPackageJsonFromDisk,
): string[] {
  const order: string[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const visit = (dir: string) => {
    if (visited.has(dir)) return
    if (visiting.has(dir)) {
      // A dependency cycle among @claxedo packages would otherwise loop
      // forever; surface it instead of silently dropping the package.
      throw new Error(`@claxedo workspace dependency cycle detected at ${dir}`)
    }
    visiting.add(dir)
    const pkg = readPackageJson(dir)
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      if (name.startsWith("@claxedo/")) {
        visit(path.join(packagesRoot(), name.slice("@claxedo/".length)))
      }
    }
    visiting.delete(dir)
    visited.add(dir)
    order.push(dir)
  }
  visit(workspaceRuntimeRoot())
  return order
}

/**
 * Build every @claxedo workspace package workspace-runtime transitively
 * depends on, dependencies first. The esbuild host bundle resolves each
 * package through its `dist/` (gitignored, nothing else builds it), so a fresh
 * checkout must produce those dists before bundling. Idempotent: re-running
 * simply rebuilds. workspace-runtime is built last here (its dedicated build
 * step in `bundleClaxedoWorkspaceRuntimeHost` is redundant but kept explicit).
 */
export function buildClaxedoWorkspacePackages(exec: Exec = defaultExec, readPackageJson: (dir: string) => PackageJson = readPackageJsonFromDisk) {
  for (const dir of workspacePackageBuildOrder(readPackageJson)) {
    const pkg = readPackageJson(dir)
    if (!pkg.scripts?.build) {
      console.log(`[build-sandbox-image] skip ${pkg.name ?? path.basename(dir)} (no build script)`)
      continue
    }
    console.log(`[build-sandbox-image] building ${pkg.name ?? path.basename(dir)}`)
    // `bun run build` works whether the package's build script invokes tsx or
    // bun directly; CI's setup-bun provides bun, and the script code stays
    // Bun-API-free (this is a subprocess, not a Bun.* call).
    exec("bun", ["run", "build"], { cwd: dir })
  }
}

export function packWorkspaceRuntime(outDir: string, exec: Exec = defaultExec) {
  const version = workspaceRuntimeVersion()
  exec("npm", ["pack", "--pack-destination", outDir], { cwd: workspaceRuntimeRoot() })
  const packageTarball = path.join(outDir, `claxedo-workspace-runtime-${version}.tgz`)
  if (!fs.existsSync(packageTarball)) throw new Error(`workspace-runtime package did not emit ${packageTarball}`)
  fs.writeFileSync(path.join(outDir, WORKSPACE_RUNTIME_VERSION_FILENAME), `${version}\n`)
  return packageTarball
}

/**
 * Build the exact OpenCode server used by hosted workspaces.
 *
 * WorkGraph depends on the checkout's durable Session V2 `/api/session`
 * contract. The public `opencode-ai` package in the image is useful as a
 * terminal CLI, but it can lag that contract and fall through to its HTML app
 * shell. Shipping this checkout's compiled server binary keeps the workspace
 * runtime and its proxied Session API on one content-addressed build.
 *
 * This build used to pass `--skip-embed-web-ui`. That flag did more than keep
 * the binary off an app shell: the embed path it skipped pointed at upstream's
 * `packages/app`, which the hard fork removed, so any build without the flag
 * died on ENOENT. The fork no longer embeds a web UI at all, so the flag is
 * gone from packages/opencode/script/build.ts and the binary is UI-less by
 * default.
 */
export function buildSandboxOpenCodeBinary(outDir: string, exec: Exec = defaultExec) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("sandbox OpenCode binary builds require a linux/x64 builder")
  }
  exec("bun", ["run", "build", "--", "--single", "--skip-install"], {
    cwd: opencodeRoot(),
    env: {
      ...process.env,
      OPENCODE_VERSION: `0.0.0-claxedo-${process.env.GITHUB_SHA?.slice(0, 12) ?? "sandbox"}`,
    },
  })
  const source = path.join(opencodeRoot(), "dist", "opencode-linux-x64", "bin", "opencode")
  if (!fs.existsSync(source)) throw new Error(`sandbox OpenCode build did not emit ${source}`)
  const target = path.join(outDir, OPENCODE_BINARY_FILENAME)
  fs.copyFileSync(source, target)
  fs.chmodSync(target, 0o755)
  return target
}

// Bundle only @claxedo workspace code; every npm dependency stays external and
// is installed in the image from the generated package.json. (Several runtime
// SDK deps — e.g. webpack-bundled @cursor/sdk — cannot be re-bundled.)
const claxedoWorkspaceOnly = {
  name: "claxedo-workspace-only",
  setup(build: { onResolve: (opts: { filter: RegExp }, cb: (args: { path: string }) => { path: string; external: boolean } | undefined) => void }) {
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith("@claxedo/")) return undefined
      return { path: args.path, external: true }
    })
  },
}

export function esbuildHostBundleOptions(input: { entry: string; outfile: string }) {
  return {
    entryPoints: [input.entry],
    bundle: true,
    platform: "node" as const,
    format: "esm" as const,
    outfile: input.outfile,
    plugins: [claxedoWorkspaceOnly],
    target: "node22",
    mainFields: ["module", "main"],
    loader: { ".sh": "text" as const, ".txt": "text" as const },
    banner: {
      // Unique identifier: the bundled workspace-runtime dist carries its own
      // createRequire banner (as __cr), and both hoist to module top scope.
      js: "import {createRequire as __claxedoHostRequire} from 'module';var require=__claxedoHostRequire(import.meta.url);",
    },
    logLevel: "warning" as const,
  }
}

/**
 * Bundle Claxedo's runnable workspace-runtime host into `outDir`.
 *
 * Emits the esbuild host bundle plus a generated package.json pinning the
 * native/bin dependencies the image must npm-install (they cannot be bundled).
 * Sandbox images are built from this in-repo artifact — publishing
 * `@claxedo/workspace-runtime` to npm is a separate release concern and no
 * longer gates image builds.
 */
export async function bundleClaxedoWorkspaceRuntimeHost(outDir: string, exec: Exec = defaultExec) {
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  // The esbuild host bundle resolves @claxedo/workspace-runtime AND every
  // @claxedo package it transitively depends on through their built dist/
  // (all gitignored). Build the whole graph dependencies-first so a fresh CI
  // checkout ships the current checkout — not stale local dist, not a missing
  // one. workspace-runtime is the last package built.
  buildClaxedoWorkspacePackages(exec)
  const packageTarball = packWorkspaceRuntime(outDir, exec)
  const opencodeBinary = buildSandboxOpenCodeBinary(outDir, exec)
  await esbuildBuild(esbuildHostBundleOptions({
    entry: claxedoWorkspaceRuntimeEntry(),
    outfile: path.join(outDir, HOST_BUNDLE_FILENAME),
  }))
  const bundlePath = path.join(outDir, HOST_BUNDLE_FILENAME)
  const packageJsonPath = path.join(outDir, "package.json")
  const packageJson = JSON.stringify({
    name: "claxedo-workspace-runtime-host",
    private: true,
    type: "module",
    dependencies: hostBundleDependencies(),
  }, null, 2)
  fs.writeFileSync(packageJsonPath, packageJson)
  // Content build-id: sha256 over the emitted bundle + generated package.json,
  // truncated to 10 hex chars. Distinguishes two builds at the same core
  // version (the npm-publish immutability gate is gone), so a rebuilt image
  // gets a distinct tag/snapshot name and actually reaches sandboxes.
  const buildId = createHash("sha256")
    .update(fs.readFileSync(bundlePath))
    .update(fs.readFileSync(packageTarball))
    .update(fs.readFileSync(opencodeBinary))
    .update(packageJson)
    .digest("hex")
    .slice(0, 10)
  return {
    bundle: bundlePath,
    packageJson: packageJsonPath,
    packageTarball,
    opencodeBinary,
    buildId,
  }
}

export function sandboxImageBuildArgs(input: {
  tags: string[]
  push: boolean
  dockerfile?: string
  context?: string
}) {
  return [
    "buildx",
    "build",
    "--platform",
    "linux/amd64",
    ...input.tags.flatMap((tag) => ["-t", tag]),
    input.push ? "--push" : "--load",
    "-f",
    input.dockerfile ?? path.resolve(import.meta.dirname, "Dockerfile"),
    // The image consumes only the bundled host in .build/, so the build
    // context is this directory — not the repo root.
    input.context ?? path.resolve(import.meta.dirname),
  ]
}

async function runDocker(args: string[]) {
  const child = spawn("docker", args, { stdio: "inherit" })
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve))
  if (code !== 0) process.exit(code ?? 1)
}

/**
 * Validate the flag combination. `--out=<dir>` only makes sense for
 * `--bundle-only`: a full docker build always builds from the default
 * `.build/` context (see `sandboxImageBuildArgs`), so `--out` without
 * `--bundle-only` would silently build the image from a stale/unrelated
 * directory. Reject it instead.
 */
export function validateBuildFlags(input: { bundleOnly: boolean; outFlag?: string }): { ok: true } | { ok: false; message: string } {
  if (input.outFlag && !input.bundleOnly) {
    return {
      ok: false,
      message: "--out=<dir> is only valid with --bundle-only; a full image build always builds from the default .build/ context.",
    }
  }
  return { ok: true }
}

async function main() {
  const push = process.argv.includes("--push")
  const latest = process.argv.includes("--latest")
  const bundleOnly = process.argv.includes("--bundle-only")
  const outFlag = process.argv.find((arg) => arg.startsWith("--out="))?.slice("--out=".length)
  const version = process.env.WORKSPACE_RUNTIME_VERSION?.trim() || workspaceRuntimeVersion()

  const flags = validateBuildFlags({ bundleOnly, outFlag })
  if (!flags.ok) {
    console.error(`[build-sandbox-image] ${flags.message}`)
    process.exit(1)
  }

  const outDir = outFlag
    ? path.resolve(outFlag)
    : path.resolve(import.meta.dirname, ".build")

  console.log(`bundling claxedo workspace-runtime host (core ${version})`)
  const bundle = await bundleClaxedoWorkspaceRuntimeHost(outDir)
  console.log(`host bundle: ${bundle.bundle}`)

  const imageTag = defaultSandboxImage(version, bundle.buildId)
  const snapshotName = defaultSnapshotName(version, bundle.buildId)

  // Persist build-info for deploy tooling / operators. Always written next to
  // the sandbox scripts (deploy tooling reads a stable path even when the
  // bundle is emitted elsewhere via --out).
  const buildInfoDir = path.resolve(import.meta.dirname, ".build")
  fs.mkdirSync(buildInfoDir, { recursive: true })
  fs.writeFileSync(
    path.join(buildInfoDir, "build-info.json"),
    JSON.stringify({ imageTag, snapshotName, buildId: bundle.buildId, coreVersion: version }, null, 2),
  )

  console.log("")
  console.log("=== sandbox build identity ===")
  console.log(`  build id:      ${bundle.buildId}`)
  console.log(`  image tag:     ${imageTag}`)
  console.log(`  snapshot name: ${snapshotName}`)
  console.log(`  (set CLAXEDO_SANDBOX_BUILD_ID=${bundle.buildId} on the control plane to pin this build,`)
  console.log(`   or CLAXEDO_SANDBOX_IMAGE / CLAXEDO_SNAPSHOT_NAME to override the names outright)`)
  console.log("==============================")
  console.log("")

  if (bundleOnly) return

  const tags = [imageTag, ...(latest ? [`${SANDBOX_IMAGE_REPOSITORY}:latest`] : [])]
  console.log(`building sandbox image for claxedo workspace-runtime host ${version}`)
  console.log(tags.map((tag) => `  ${tag}`).join("\n"))

  await runDocker(sandboxImageBuildArgs({ tags, push }))

  console.log(push ? `sandbox image pushed: ${imageTag}` : `sandbox image build succeeded: ${imageTag}`)
  console.log(`snapshot name: ${snapshotName}`)
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  await main()
}
