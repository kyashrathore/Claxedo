import { spawn } from "node:child_process"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isBuiltin } from "node:module"
import { build as esbuildBuild, type Metafile } from "esbuild"
import { stageOpenCodePatches } from "../../../workspace-runtime/scripts/stage-opencode-patches"
import { isRecord } from "@claxedo/helpers/guards"
import { defaultSandboxImage, defaultSnapshotName, SANDBOX_IMAGE_REPOSITORY } from "@claxedo/sandbox-manager/image"
import { parseJson } from "@claxedo/server-core/platform/json/index"
import {
  claxedoAgentPluginsWorkspaceRuntimeEntry,
  claxedoWorkspaceRuntimeEntry,
  workspaceRuntimeRoot,
  workspaceRuntimeVersion,
} from "../../src/hosts/workspace-runtime/startup"

type Exec = (cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) => void

const IMAGE_REQUIRED_DEPENDENCIES = [
  "better-sqlite3",
  "@lydell/node-pty",
]

export const HOST_BUNDLE_FILENAME = "workspace-runtime-host.mjs"
export const IMAGE_SMOKE_FILENAME = "workspace-runtime-image-smoke.mjs"
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

function workspacePackageRoot(name: string) {
  const suffix = name.slice("@claxedo/".length)
  const direct = path.join(packagesRoot(), suffix)
  if (fs.existsSync(path.join(direct, "package.json"))) return direct
  const prefixed = path.join(packagesRoot(), `claxedo-${suffix}`)
  if (fs.existsSync(path.join(prefixed, "package.json"))) return prefixed
  // Synthetic graph tests use logical package-directory names without
  // creating them on disk; retain that deterministic fallback.
  return direct
}

type WorkspaceCatalog = Record<string, string>

function workspaceCatalog(value: unknown): value is WorkspaceCatalog {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string")
}

function rootWorkspaceCatalog(): WorkspaceCatalog {
  const root = parseJson(fs.readFileSync(path.resolve(packagesRoot(), "../package.json"), "utf8"))
  if (!isRecord(root) || !isRecord(root.workspaces) || !workspaceCatalog(root.workspaces.catalog)) return {}
  return root.workspaces.catalog
}

function standaloneDependencyVersion(name: string, version: string, catalog: WorkspaceCatalog): string | undefined {
  // Workspace packages are bundled into workspace-runtime-host.mjs. npm cannot
  // resolve this monorepo-only protocol inside the standalone image context,
  // and copying it would make an otherwise valid Docker build fail before the
  // runtime starts.
  if (version.startsWith("workspace:")) return undefined
  if (version === "catalog:") {
    const resolved = catalog[name]
    if (!resolved) throw new Error(`workspace catalog has no concrete version for image dependency: ${name}`)
    return resolved
  }
  if (version.startsWith("catalog:")) {
    throw new Error(`sandbox image dependency ${name} uses unsupported named workspace catalog specifier: ${version}`)
  }
  return version
}

/**
 * Merge external runtime dependencies of the host's workspace package roots. The
 * @claxedo code itself ships inside the esbuild bundle; everything else is
 * npm-installed in the image from these exact pins.
 */
export function hostBundleDependencies(
  readPackageJson: (dir: string) => PackageJson = readPackageJsonFromDisk,
  roots: readonly string[] = hostBundlePackageRoots(),
  catalog: WorkspaceCatalog = rootWorkspaceCatalog(),
) {
  const dependencies: Record<string, string> = {}
  const visited = new Set<string>()
  const queue = [...roots].reverse()
  while (queue.length) {
    const dir = queue.shift()!
    if (visited.has(dir)) continue
    visited.add(dir)
    const pkg = readPackageJson(dir)
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
      if (name.startsWith("@claxedo/")) {
        queue.push(workspacePackageRoot(name))
        continue
      }
      const standaloneVersion = standaloneDependencyVersion(name, version, catalog)
      if (!standaloneVersion) continue
      const existing = dependencies[name]
      if (existing) {
        if (existing !== standaloneVersion) {
          // BFS from workspace-runtime: its own pin wins. The image installs
          // one flat dependency set, mirroring what bundling would pick.
          console.warn(`[build-sandbox-image] dependency pin conflict for ${name}: keeping ${existing}, ignoring ${standaloneVersion} (${pkg.name ?? dir})`)
        }
        continue
      }
      dependencies[name] = standaloneVersion
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
 * Roots of the host-bundle package closure.
 *
 * The host registers the external adapter itself; workspace-runtime does not
 * depend on it. Keep runtime first for dependency-pin priority; topological
 * build order places the first-party MCP mount after the runtime it consumes.
 * Pure server-core source helpers are bundled directly, not package build roots.
 * The Agent Plugins image also bundles the local-server module that owns the
 * runtime apply route (`host-entry.agent-plugins.ts`).
 */
export function hostBundlePackageRoots(agentPlugins = false) {
  return [
    path.join(packagesRoot(), "opencode-server-adapter"),
    path.join(packagesRoot(), "claxedo-mcp"),
    ...(agentPlugins ? [path.join(packagesRoot(), "claxedo-local-server")] : []),
    workspaceRuntimeRoot(),
  ]
}

/**
 * Return the on-disk directories of every @claxedo workspace package in the
 * transitive dependency graph of the host bundle roots, in build order —
 * dependencies before dependents (post-order DFS). Directories are unique and
 * mirror `hostBundleDependencies`' @claxedo traversal, but here we need the
 * packages themselves (their gitignored dist/ must exist before esbuild bundles
 * them), not their external npm pins.
 */
export function workspacePackageBuildOrder(
  readPackageJson: (dir: string) => PackageJson = readPackageJsonFromDisk,
  roots: readonly string[] = hostBundlePackageRoots(),
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
        visit(workspacePackageRoot(name))
      }
    }
    visiting.delete(dir)
    visited.add(dir)
    order.push(dir)
  }
  for (const root of roots) visit(root)
  return order
}

/**
 * Build every @claxedo workspace package the host bundle transitively
 * depends on, dependencies first. The esbuild host bundle resolves each
 * package through its `dist/` (gitignored, nothing else builds it), so a fresh
 * checkout must produce those dists before bundling. Idempotent: re-running
 * simply rebuilds.
 */
export function buildClaxedoWorkspacePackages(
  exec: Exec = defaultExec,
  readPackageJson: (dir: string) => PackageJson = readPackageJsonFromDisk,
  roots: readonly string[] = hostBundlePackageRoots(),
) {
  for (const dir of workspacePackageBuildOrder(readPackageJson, roots)) {
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

export function writeWorkspaceRuntimeVersion(outDir: string) {
  const versionFile = path.join(outDir, WORKSPACE_RUNTIME_VERSION_FILENAME)
  fs.writeFileSync(versionFile, `${workspaceRuntimeVersion()}\n`)
  return versionFile
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
    metafile: true,
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

/** Every emitted npm import must be installable from the image's manifest. */
export function assertHostBundleDependencies(metafile: Metafile, dependencies: Record<string, string>) {
  const missing = new Set<string>()
  for (const output of Object.values(metafile.outputs)) {
    for (const imported of output.imports) {
      if (!imported.external || isBuiltin(imported.path)) continue
      const name = imported.path.startsWith("@") ? imported.path.split("/").slice(0, 2).join("/") : imported.path.split("/")[0]
      if (!dependencies[name]) missing.add(imported.path)
    }
  }
  if (missing.size) throw new Error(`Host bundle has undeclared external dependencies: ${[...missing].sort().join(", ")}`)
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
export async function bundleClaxedoWorkspaceRuntimeHost(
  outDir: string,
  exec: Exec = defaultExec,
  options: { agentPlugins?: boolean } = {},
) {
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  // The esbuild host bundle resolves @claxedo/workspace-runtime AND every
  // @claxedo package it transitively depends on through their built dist/
  // (all gitignored). Build the whole graph dependencies-first so a fresh CI
  // checkout ships the current checkout — not stale local dist, not a missing
  // one. The build order follows the declared dependency graph.
  const roots = hostBundlePackageRoots(options.agentPlugins)
  buildClaxedoWorkspacePackages(exec, readPackageJsonFromDisk, roots)
  const versionFile = writeWorkspaceRuntimeVersion(outDir)
  const dependencies = hostBundleDependencies(readPackageJsonFromDisk, roots)
  const result = await esbuildBuild(esbuildHostBundleOptions({
    entry: options.agentPlugins ? claxedoAgentPluginsWorkspaceRuntimeEntry() : claxedoWorkspaceRuntimeEntry(),
    outfile: path.join(outDir, HOST_BUNDLE_FILENAME),
  }))
  assertHostBundleDependencies(result.metafile!, dependencies)
  const bundlePath = path.join(outDir, HOST_BUNDLE_FILENAME)
  const packageJsonPath = path.join(outDir, "package.json")
  // The public OpenCode SDK behind the native `opencode` harness is an
  // install-time dependency: its exact-version Node patches ship beside the
  // bundle and the image's npm postinstall applies them.
  const stagedPatches = await stageOpenCodePatches(outDir)
  const packageJson = JSON.stringify({
    name: "claxedo-workspace-runtime-host",
    private: true,
    type: "module",
    engines: { node: ">=24" },
    dependencies,
    scripts: { postinstall: `node ${stagedPatches.installer}` },
    claxedoDependencyPatches: stagedPatches.patches,
  }, null, 2)
  fs.writeFileSync(packageJsonPath, packageJson)
  const smokePath = path.join(outDir, IMAGE_SMOKE_FILENAME)
  fs.copyFileSync(new URL(`./${IMAGE_SMOKE_FILENAME}`, import.meta.url), smokePath)
  // Content build-id: sha256 over the emitted bundle + generated package.json,
  // truncated to 10 hex chars. Distinguishes two builds at the same core
  // version (the npm-publish immutability gate is gone), so a rebuilt image
  // gets a distinct tag/snapshot name and actually reaches sandboxes.
  const buildId = createHash("sha256")
    .update(fs.readFileSync(bundlePath))
    .update(fs.readFileSync(versionFile))
    .update(packageJson)
    .update(fs.readFileSync(smokePath))
    .update(stagedPatches.digest)
    .digest("hex")
    .slice(0, 10)
  return {
    bundle: bundlePath,
    packageJson: packageJsonPath,
    versionFile,
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
  const agentPlugins = process.argv.includes("--agent-plugins")
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
  const bundle = await bundleClaxedoWorkspaceRuntimeHost(outDir, defaultExec, { agentPlugins })
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
    JSON.stringify({ imageTag, snapshotName, buildId: bundle.buildId, coreVersion: version, agentPlugins }, null, 2),
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
