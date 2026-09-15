/**
 * The one publisher for the 13 public `@claxedo/*` packages.
 *
 * Policy this script encodes:
 *
 *   1. **Versions are read from the repo, never passed in.** A release is a
 *      reviewed version-bump commit, and `--dry-run` is a meaningful check of
 *      the repo's actual state (which is what CI runs on `dev` and on PRs).
 *   2. **Sibling dependencies are `workspace:*` in the repo.** Bun resolves them
 *      to the checkout, so a version bump can never flip a sibling to the
 *      registry, and there is no cross-pin to keep in sync by hand.
 *   3. **Pins are materialized at pack time.** Right before `npm pack` /
 *      `npm publish`, every `workspace:` specifier is replaced by that
 *      package's exact in-repo version and the original manifest is restored
 *      afterwards. npm does not rewrite `workspace:` itself (only `bun publish`
 *      does), and a `workspace:` that survives into a published `dependencies`
 *      block fails every downstream `npm install` with EUNSUPPORTEDPROTOCOL.
 *   4. **A published version is immutable.** `check-published-versions.ts`
 *      fails the run when a package's directory changed after its version was
 *      last set and that version is already on npm — the bump is missing.
 *
 * Every package is built (with its `@claxedo/*` dependencies first), packed,
 * and the packed tarball inspected — README.md and LICENSE present, no
 * `workspace:`/`catalog:` specifier in any consumer-facing section — before
 * anything is published. A version already on the registry is skipped.
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { readPackageJson, type CommandRunner, type PackageJson } from "./package-json"
import { fileURLToPath } from "node:url"
import { isRecordArray, parseJsonRecords, stringField } from "@claxedo/server-core/platform/json/index"
import { publishedVersionDrift, type PublishedVersionPackage } from "./check-published-versions"

export type PackageTrack = "helpers" | "runtime" | "apps" | "wakes" | "cli"

export type ClaxedoPackage = {
  readonly name: string
  readonly dir: string
  /**
   * Version track. Packages on a track move together, one minor at a time —
   * see `script/PUBLISH-ORDER.md` for why, and which packages ride a bump they
   * did not individually earn.
   */
  readonly track: PackageTrack
}

/**
 * All 13 public packages, in dependency order (`@claxedo/*` edges only).
 * Tier 0 has no `@claxedo/*` dependencies; each later tier depends only on
 * earlier ones. Publishing out of this order can leave a package on npm whose
 * exact `@claxedo/*` pin does not resolve yet.
 */
export const claxedoPackages: readonly ClaxedoPackage[] = [
  // Tier 0
  { name: "@claxedo/helpers", dir: "packages/claxedo-helpers", track: "helpers" },
  { name: "@claxedo/agent-runtime-contract", dir: "packages/agent-runtime-contract", track: "runtime" },
  { name: "@claxedo/workspace-relay-protocol", dir: "packages/workspace-relay-protocol", track: "runtime" },
  { name: "@claxedo/wakes", dir: "packages/wakes", track: "wakes" },
  // Tier 1
  { name: "@claxedo/sandbox-contract", dir: "packages/sandbox-contract", track: "runtime" },
  { name: "@claxedo/agent-event-runtime", dir: "packages/agent-event-runtime", track: "runtime" },
  { name: "@claxedo/channels", dir: "packages/claxedo-channels", track: "apps" },
  { name: "@claxedo/connections", dir: "packages/claxedo-connections", track: "apps" },
  { name: "@claxedo/workspace-relay", dir: "packages/workspace-relay", track: "runtime" },
  // Tier 2
  { name: "@claxedo/sandbox-manager", dir: "packages/sandbox-manager", track: "runtime" },
  { name: "@claxedo/agent-sdk-runtime", dir: "packages/agent-sdk-runtime", track: "runtime" },
  // Tier 3
  { name: "@claxedo/workspace-runtime", dir: "packages/workspace-runtime", track: "runtime" },
  // Tier 4
  { name: "@claxedo/cli", dir: "packages/cli", track: "cli" },
]

export type PackageSelector = "all" | PackageTrack

export function selectPackages(selector: PackageSelector): readonly ClaxedoPackage[] {
  return selector === "all" ? claxedoPackages : claxedoPackages.filter((item) => item.track === selector)
}

const CONSUMER_SECTIONS = ["dependencies", "peerDependencies", "optionalDependencies"] as const
const ALL_SECTIONS = [...CONSUMER_SECTIONS, "devDependencies"] as const

export { readPackageJson, type CommandRunner, type PackageJson } from "./package-json"

const repoRoot = path.resolve(import.meta.dirname, "../../../..")

/**
 * `workspace:` / `catalog:` specifiers in sections a consumer actually
 * installs, as found in a PACKED manifest. devDependencies are reported
 * separately because npm never installs a published package's devDependencies
 * — a `catalog:` there is cosmetic, not breaking.
 */
export function protocolSpecifiers(pkg: PackageJson) {
  const breaking: string[] = []
  const cosmetic: string[] = []
  for (const section of ALL_SECTIONS) {
    for (const [dep, spec] of Object.entries(pkg[section] ?? {})) {
      if (typeof spec !== "string") continue
      if (!spec.includes("workspace:") && !spec.includes("catalog:")) continue
      const entry = `${section}.${dep}=${spec}`
      if (section === "devDependencies") cosmetic.push(entry)
      else breaking.push(entry)
    }
  }
  return { breaking, cosmetic }
}

export const WORKSPACE_PIN = "workspace:*"

/**
 * Every `@claxedo/*` dependency of a public package must be exactly
 * `workspace:*` in the repo. Any literal version — `0.7.0`, `workspace:0.7.0`,
 * `^0.7.0` — is a pin that has to be kept in sync by hand and that Bun stops
 * resolving to the checkout the moment the sibling's version moves (a stale pin
 * once shipped workspace-runtime against an older agent-sdk-runtime).
 */
export function crossPinViolations(pkg: PackageJson, publicNames: ReadonlySet<string>) {
  const bad: string[] = []
  for (const section of ALL_SECTIONS) {
    for (const [dep, spec] of Object.entries(pkg[section] ?? {})) {
      if (!publicNames.has(dep)) continue
      if (spec !== WORKSPACE_PIN) bad.push(`${section}.${dep}=${spec} (expected ${WORKSPACE_PIN})`)
    }
  }
  return bad
}

/**
 * The manifest npm sees: every `workspace:` specifier replaced by the exact
 * in-repo version of that package. In a section consumers install, a
 * `workspace:` reference to a package that is not public cannot be
 * materialized and is an error, not a silent pass. In `devDependencies` —
 * which npm never installs from a published package — a private sibling is
 * dropped instead: it is a build-time input (the CLI bundles `host-connector`
 * and `host-serving` into `dist/index.mjs`) that has no registry name to pin.
 */
export function materializeWorkspacePins(pkg: PackageJson, versions: ReadonlyMap<string, string>): PackageJson {
  const next: PackageJson = { ...pkg }
  for (const section of ALL_SECTIONS) {
    const deps = pkg[section]
    if (!deps) continue
    const materialized: [string, string][] = []
    for (const [dep, spec] of Object.entries(deps)) {
      if (typeof spec !== "string" || !spec.startsWith("workspace:")) {
        materialized.push([dep, spec])
        continue
      }
      const version = versions.get(dep)
      if (version) {
        materialized.push([dep, version])
        continue
      }
      if (section === "devDependencies") continue
      throw new Error(`${pkg.name ?? "package"}: ${section}.${dep}=${spec} references a package that is not published`)
    }
    next[section] = Object.fromEntries(materialized)
  }
  return next
}

export function repoVersions(root: string, packages: readonly ClaxedoPackage[] = claxedoPackages) {
  const versions = new Map<string, string>()
  for (const item of packages) {
    const pkg = readPackageJson(path.join(root, item.dir, "package.json"))
    if (pkg.name !== item.name) {
      throw new Error(`Expected ${item.dir}/package.json to be ${item.name}, found ${pkg.name ?? "missing name"}`)
    }
    if (!pkg.version) throw new Error(`${item.name} has no version`)
    versions.set(item.name, pkg.version)
  }
  return versions
}

function claxedoDependencies(pkg: PackageJson, packagesByName: ReadonlyMap<string, ClaxedoPackage>) {
  return CONSUMER_SECTIONS.flatMap((section) => Object.keys(pkg[section] ?? {}))
    .filter((name) => packagesByName.has(name))
}

function buildWithDependencies(
  item: ClaxedoPackage,
  root: string,
  run: CommandRunner,
  packagesByName: ReadonlyMap<string, ClaxedoPackage>,
  built: Set<string>,
) {
  if (built.has(item.name)) return
  const pkg = readPackageJson(path.join(root, item.dir, "package.json"))
  for (const dependencyName of claxedoDependencies(pkg, packagesByName)) {
    const dependency = packagesByName.get(dependencyName)
    if (dependency) buildWithDependencies(dependency, root, run, packagesByName, built)
  }
  run("npm", ["run", "build", "--workspace", item.name], root)
  built.add(item.name)
}

export function defaultCommandRunner(cmd: string, args: string[], cwd = repoRoot, env?: NodeJS.ProcessEnv) {
  return execFileSync(cmd, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

/** `npm pack --json` can prefix notices; take the JSON array off the end. */
export function parsePackJson(stdout: string) {
  const start = stdout.indexOf("[")
  if (start < 0) throw new Error(`unrecognised npm pack --json output: ${stdout.slice(0, 200)}`)
  const packs = parseJsonRecords(stdout.slice(start))
  if (!packs) throw new Error(`unrecognised npm pack --json output: ${stdout.slice(0, 200)}`)
  return packs.map((pack) => ({
    filename: stringField(pack, "filename") ?? "",
    integrity: stringField(pack, "integrity") ?? "",
    files: (isRecordArray(pack.files) ? pack.files : []).map((file) => ({ path: stringField(file, "path") ?? "" })),
  }))
}

export const REQUIRED_TARBALL_FILES = ["README.md", "LICENSE"] as const

export function missingTarballFiles(files: readonly string[]) {
  return REQUIRED_TARBALL_FILES.filter((required) => !files.includes(required))
}

function commandFailureReason(error: unknown) {
  if (!(error instanceof Error)) return String(error)
  const stderr = "stderr" in error ? (error as { stderr?: unknown }).stderr : undefined
  const text = typeof stderr === "string"
    ? stderr
    : Buffer.isBuffer(stderr)
      ? stderr.toString("utf8")
      : error.message
  const lines = text.split(/\n/).map((line) => line.trim())
  return lines.find((line) => line.includes("Two-factor authentication"))
    ?? lines.find((line) => line.startsWith("npm error"))
    ?? error.message
}

export function npmVersionPublished(name: string, version: string, run: CommandRunner, root: string) {
  try {
    run("npm", ["view", `${name}@${version}`, "version"], root)
    return true
  } catch {
    return false
  }
}

/**
 * Run `fn` with the package's manifest rewritten to its published shape, and
 * put the original bytes back whether or not `fn` throws. The repo never
 * carries materialized pins; only the tarball does.
 */
/**
 * True when npm's tarball for `name@version` has the integrity a pack of this
 * directory produces with its pins materialized. `npm pack` is deterministic
 * (fixed mtimes, sorted entries), so equal integrity means equal bytes; an
 * unbuilt or otherwise differing directory compares unequal and stays a
 * violation.
 */
function publishedTarballMatchesTree(
  root: string,
  item: PublishedVersionPackage,
  version: string,
  versions: ReadonlyMap<string, string>,
  run: CommandRunner,
) {
  let published: string
  try {
    published = run("npm", ["view", `${item.name}@${version}`, "dist.integrity"], root)
  } catch {
    return false
  }
  if (!published) return false
  const file = path.join(root, item.dir, "package.json")
  const pkg = readPackageJson(file)
  return withMaterializedManifest(file, materializeWorkspacePins(pkg, versions), () => {
    try {
      const packed = parsePackJson(run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], path.join(root, item.dir)))[0]
      return packed?.integrity === published
    } catch {
      return false
    }
  })
}

function withMaterializedManifest<T>(file: string, materialized: PackageJson, fn: () => T): T {
  const original = fs.readFileSync(file, "utf8")
  fs.writeFileSync(file, `${JSON.stringify(materialized, null, 2)}\n`)
  try {
    return fn()
  } finally {
    fs.writeFileSync(file, original)
  }
}

export type PublishOptions = {
  selector?: PackageSelector
  /** Explicit package names, overriding `selector`. */
  only?: readonly string[]
  tag?: string
  root?: string
  dryRun?: boolean
  provenance?: boolean
  run?: CommandRunner
  workDir?: string
  log?: (message: string) => void
}

export type PublishOutcome = {
  name: string
  version: string
  action: "published" | "skipped-already-published" | "would-publish"
}

export async function publishClaxedoPackages(options: PublishOptions): Promise<PublishOutcome[]> {
  const root = options.root ?? repoRoot
  const run = options.run ?? defaultCommandRunner
  const tag = options.tag ?? "latest"
  const log = options.log ?? ((message: string) => console.log(message))
  const dryRun = options.dryRun === true

  const selected = options.only
    ? claxedoPackages.filter((item) => options.only?.includes(item.name) || options.only?.includes(item.dir.replace("packages/", "")))
    : selectPackages(options.selector ?? "all")

  if (selected.length === 0) throw new Error("no packages selected")

  // Pins and drift are validated against every public package, not just the
  // selected subset — publishing `connections` alone must still prove the whole
  // public set is releasable.
  const versions = repoVersions(root)
  const publicNames = new Set(versions.keys())
  const drift = publishedVersionDrift(root, claxedoPackages, run, (item, version) =>
    publishedTarballMatchesTree(root, item, version, versions, run))
  if (drift.length > 0) {
    throw new Error(`published versions with unreleased changes (bump the version):\n${drift.map((line) => `  - ${line}`).join("\n")}`)
  }

  const workDir = options.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-publish-"))
  const cleanup = options.workDir === undefined
  const failures: string[] = []
  const outcomes: PublishOutcome[] = []
  const packagesByName = new Map(claxedoPackages.map((item) => [item.name, item]))
  const built = new Set<string>()

  try {
    for (const item of selected) {
      const file = path.join(root, item.dir, "package.json")
      const pkg = readPackageJson(file)
      const version = versions.get(item.name)
      if (!version) throw new Error(`${item.name} missing from the version map`)
      log(`==> ${item.name}@${version} (track ${item.track})`)

      if (pkg.private === true) {
        failures.push(`${item.name}: marked private, refusing to publish`)
        continue
      }

      const pins = crossPinViolations(pkg, publicNames)
      if (pins.length > 0) {
        failures.push(`${item.name}: sibling dependency is not ${WORKSPACE_PIN}: ${pins.join(", ")}`)
        continue
      }

      try {
        buildWithDependencies(item, root, run, packagesByName, built)
        log("    build                        ok")
      } catch (error) {
        failures.push(`${item.name}: build failed: ${commandFailureReason(error)}`)
        continue
      }

      if (pkg.scripts?.["verify:publish"]) {
        try {
          run("npm", ["run", "verify:publish", "--workspace", item.name], root)
          log("    verify:publish               ok")
        } catch (error) {
          failures.push(`${item.name}: verify:publish failed: ${commandFailureReason(error)}`)
          continue
        }
      }

      let materialized: PackageJson
      try {
        materialized = materializeWorkspacePins(pkg, versions)
      } catch (error) {
        failures.push(`${item.name}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }

      const outcome = withMaterializedManifest(file, materialized, (): PublishOutcome | string => {
        // Pack and inspect the real tarball — reading package.json is not proof
        // of what npm will ship.
        const packDir = path.join(workDir, item.name.replace("/", "__"))
        fs.mkdirSync(packDir, { recursive: true })
        let packed: ReturnType<typeof parsePackJson>[number]
        try {
          packed = parsePackJson(run("npm", ["pack", "--json", "--pack-destination", packDir], path.join(root, item.dir)))[0]!
        } catch (error) {
          return `${item.name}: npm pack failed: ${commandFailureReason(error)}`
        }
        log(`    pack                         ok (${packed.filename})`)

        const extractDir = path.join(packDir, "extract")
        fs.mkdirSync(extractDir, { recursive: true })
        // The archive name stays relative to the cwd: an absolute Windows path in
        // tar's -f argument reads as host:file (GNU tar's remote syntax) and dies
        // with "Cannot connect". -C is not parsed that way and may stay absolute.
        run("tar", ["-xzf", packed.filename, "-C", extractDir, "package/package.json"], packDir)
        const packedPkg = readPackageJson(path.join(extractDir, "package", "package.json"))

        const specifiers = protocolSpecifiers(packedPkg)
        if (specifiers.breaking.length > 0) {
          return `${item.name}: packed tarball has workspace:/catalog: specifier(s) consumers install: ${specifiers.breaking.join(", ")}`
        }
        log(`    workspace:/catalog: specifiers ok${specifiers.cosmetic.length > 0 ? ` (devDependencies only: ${specifiers.cosmetic.join(", ")})` : ""}`)

        const missing = missingTarballFiles(packed.files.map((entry) => entry.path))
        if (missing.length > 0) return `${item.name}: tarball missing ${missing.join(", ")}`
        log("    README.md/LICENSE in tarball ok")

        if (packedPkg.version !== version) {
          return `${item.name}: packed version ${packedPkg.version} != repo version ${version}`
        }

        if (npmVersionPublished(item.name, version, run, root)) {
          log(`    registry                     ${version} already published, skipping`)
          return { name: item.name, version, action: "skipped-already-published" }
        }

        if (dryRun) {
          log(`    registry                     ${version} not published — would publish`)
          return { name: item.name, version, action: "would-publish" }
        }

        try {
          run("npm", [
            "publish",
            "--workspace",
            item.name,
            "--access",
            "public",
            ...(options.provenance === false ? [] : ["--provenance"]),
            "--tag",
            tag,
          ], root)
        } catch (error) {
          return `${item.name}: publish failed: ${commandFailureReason(error)}`
        }
        if (!npmVersionPublished(item.name, version, run, root)) {
          return `${item.name}: npm did not expose ${version} after publish`
        }
        log(`    registry                     published ${version}`)
        return { name: item.name, version, action: "published" }
      })

      if (typeof outcome === "string") failures.push(outcome)
      else outcomes.push(outcome)
    }
  } finally {
    if (cleanup) fs.rmSync(workDir, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    throw new Error(`publish preflight failed:\n${failures.map((line) => `  - ${line}`).join("\n")}`)
  }

  return outcomes
}

function argValue(argv: readonly string[], name: string) {
  const index = argv.indexOf(name)
  if (index < 0) return undefined
  return argv[index + 1]
}

const SELECTORS: readonly PackageSelector[] = ["all", "helpers", "runtime", "apps", "wakes", "cli"]

export function parseArgs(argv: readonly string[]) {
  const selectorArg = argValue(argv, "--track") ?? "others"
  const selector = SELECTORS.find((candidate) => candidate === selectorArg)
  if (!selector) {
    throw new Error(`--track must be one of ${SELECTORS.join(", ")} (got ${selectorArg})`)
  }
  const onlyArg = argValue(argv, "--packages")
  return {
    selector,
    only: onlyArg ? onlyArg.split(",").map((value) => value.trim()).filter(Boolean) : undefined,
    tag: argValue(argv, "--tag"),
    dryRun: argv.includes("--dry-run"),
    provenance: !argv.includes("--no-provenance"),
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const outcomes = await publishClaxedoPackages(options)
  const published = outcomes.filter((item) => item.action === "published")
  const skipped = outcomes.filter((item) => item.action === "skipped-already-published")
  const would = outcomes.filter((item) => item.action === "would-publish")
  console.log("")
  console.log(`checked ${outcomes.length} package(s)`)
  if (would.length > 0) console.log(`would publish: ${would.map((item) => `${item.name}@${item.version}`).join(", ")}`)
  if (published.length > 0) console.log(`published: ${published.map((item) => `${item.name}@${item.version}`).join(", ")}`)
  if (skipped.length > 0) console.log(`already on npm: ${skipped.map((item) => `${item.name}@${item.version}`).join(", ")}`)
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
