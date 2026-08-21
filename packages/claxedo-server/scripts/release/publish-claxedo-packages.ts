/**
 * Publisher for the 12 public `@claxedo/*` packages.
 *
 * Why this exists alongside `publish-runtime-packages.ts`: that script only
 * knows the six-package runtime family, and it takes the release version as a
 * CLI argument and stamps it into every package.json as a side effect of
 * publishing. The other six (channels, connections, mcp, sandbox-manager,
 * wakes, workgraph) had no automation at all — they were published by a human
 * typing `npm publish` out of `script/PUBLISH-ORDER.md`, with no dry run and
 * no idempotency check.
 *
 * Two deliberate differences from the runtime script:
 *
 *   1. **Versions are read from the repo, never passed in.** The version bump
 *      is a reviewable commit, not a workflow input somebody types wrong, and
 *      a `--dry-run` becomes a meaningful check of the repo's actual state
 *      (which is what the CI job on `dev` runs).
 *   2. **Cross-pins are asserted, not rewritten.** Every `@claxedo/*`
 *      dependency of a public package must already equal that package's
 *      in-repo version. Rewriting at publish time hides a stale pin; asserting
 *      turns it into a failure you can fix in the diff.
 *
 * Every package goes through the same gates `script/publish-preflight.sh`
 * encodes — build, `npm pack`, no `workspace:`/`catalog:` specifier in any
 * consumer-facing dependency section of the *packed* package.json, README.md
 * and LICENSE present in the tarball — and is skipped when its exact version
 * is already on the registry.
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export type PackageTrack = "runtime" | "apps" | "wakes"

export type ClaxedoPackage = {
  readonly name: string
  readonly dir: string
  /**
   * Version track. Packages on a track move together, one minor at a time —
   * see `script/PUBLISH-ORDER.md` for why, and which packages ride a bump they
   * did not individually earn.
   */
  readonly track: PackageTrack
  /**
   * True when `publish-runtime-packages.ts` already publishes this package.
   * Kept so `--track all` can run over the full set without double-publishing
   * being ambiguous: the npm-view skip makes a second pass a no-op either way.
   */
  readonly runtimeFamily: boolean
}

/**
 * All 12 public packages, in dependency order (`@claxedo/*` edges only).
 * Tier 0 has no `@claxedo/*` dependencies; tier 1 depends on tier 0; tier 2 on
 * tiers 0 and 1. Publishing out of this order can leave a package on npm whose
 * exact `@claxedo/*` pin does not resolve yet.
 */
export const claxedoPackages: readonly ClaxedoPackage[] = [
  // Tier 0
  { name: "@claxedo/agent-event-runtime", dir: "packages/agent-event-runtime", track: "runtime", runtimeFamily: true },
  { name: "@claxedo/agent-extensions", dir: "packages/agent-extensions", track: "runtime", runtimeFamily: true },
  { name: "@claxedo/workspace-relay-protocol", dir: "packages/workspace-relay-protocol", track: "runtime", runtimeFamily: true },
  { name: "@claxedo/sandbox-manager", dir: "packages/sandbox-manager", track: "runtime", runtimeFamily: false },
  { name: "@claxedo/channels", dir: "packages/claxedo-channels", track: "apps", runtimeFamily: false },
  { name: "@claxedo/connections", dir: "packages/claxedo-connections", track: "apps", runtimeFamily: false },
  { name: "@claxedo/wakes", dir: "packages/wakes", track: "wakes", runtimeFamily: false },
  // Tier 1
  { name: "@claxedo/agent-sdk-runtime", dir: "packages/agent-sdk-runtime", track: "runtime", runtimeFamily: true },
  { name: "@claxedo/workspace-relay", dir: "packages/workspace-relay", track: "runtime", runtimeFamily: true },
  // Tier 2
  { name: "@claxedo/workspace-runtime", dir: "packages/workspace-runtime", track: "runtime", runtimeFamily: true },
  // Tier 3 — WorkGraph moved down from Tier 0 when its Workspace Runtime
  // adapter arrived. It now depends on the runtime it contributes routes to,
  // which is the correct direction (product capability above execution core)
  // but reverses their publish order.
  { name: "@claxedo/workgraph", dir: "packages/workgraph", track: "apps", runtimeFamily: false },
  // Tier 4 — depends on WorkGraph, so it follows.
  { name: "@claxedo/mcp", dir: "packages/claxedo-mcp", track: "apps", runtimeFamily: false },
]

export type PackageSelector = "all" | "others" | "runtime-family" | PackageTrack

/**
 * `others` is the D2 set: everything `publish-runtime-packages.ts` does not
 * already cover.
 */
export function selectPackages(selector: PackageSelector): readonly ClaxedoPackage[] {
  switch (selector) {
    case "all":
      return claxedoPackages
    case "others":
      return claxedoPackages.filter((item) => !item.runtimeFamily)
    case "runtime-family":
      return claxedoPackages.filter((item) => item.runtimeFamily)
    default:
      return claxedoPackages.filter((item) => item.track === selector)
  }
}

const CONSUMER_SECTIONS = ["dependencies", "peerDependencies", "optionalDependencies"] as const
const ALL_SECTIONS = [...CONSUMER_SECTIONS, "devDependencies"] as const

export type PackageJson = {
  name?: string
  version?: string
  private?: boolean
  scripts?: Record<string, string>
} & Partial<Record<(typeof ALL_SECTIONS)[number], Record<string, string>>>

export type CommandRunner = (cmd: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv) => string

const repoRoot = path.resolve(import.meta.dirname, "../../../..")

export function readPackageJson(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8")) as PackageJson
}

/**
 * `workspace:` / `catalog:` specifiers in sections a consumer actually
 * installs. npm does not rewrite these (only `bun publish` does), so one that
 * survives into a published `dependencies` block fails every downstream
 * `npm install` with EUNSUPPORTEDPROTOCOL. devDependencies are reported
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

/**
 * Every `@claxedo/*` dependency of a public package must be an exact pin equal
 * to that package's in-repo version. This is the check that would have caught
 * "workspace-runtime shipped pinned to @claxedo/workgraph 0.3.0 while the repo
 * moved workgraph to 0.4.0".
 */
export function crossPinViolations(pkg: PackageJson, versions: ReadonlyMap<string, string>) {
  const bad: string[] = []
  for (const section of CONSUMER_SECTIONS) {
    for (const [dep, spec] of Object.entries(pkg[section] ?? {})) {
      const expected = versions.get(dep)
      if (expected === undefined) continue
      if (spec !== expected) {
        bad.push(`${section}.${dep}=${spec} (expected ${expected})`)
      }
    }
  }
  return bad
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
  return JSON.parse(stdout.slice(start)) as Array<{ filename: string; files: Array<{ path: string }> }>
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
    : selectPackages(options.selector ?? "others")

  if (selected.length === 0) throw new Error("no packages selected")

  // Cross-pins are validated against every public package's version, not just
  // the selected subset — publishing `mcp` alone must still prove its
  // `@claxedo/workgraph` pin matches the repo.
  const versions = repoVersions(root)

  const workDir = options.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-publish-"))
  const cleanup = options.workDir === undefined
  const failures: string[] = []
  const outcomes: PublishOutcome[] = []

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

      const pins = crossPinViolations(pkg, versions)
      if (pins.length > 0) {
        failures.push(`${item.name}: stale @claxedo/* cross-pin(s): ${pins.join(", ")}`)
        continue
      }

      try {
        run("npm", ["run", "build", "--workspace", item.name], root)
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

      // Pack and inspect the real tarball — reading package.json is not proof
      // of what npm will ship.
      const packDir = path.join(workDir, item.name.replace("/", "__"))
      fs.mkdirSync(packDir, { recursive: true })
      let packed: ReturnType<typeof parsePackJson>[number]
      try {
        packed = parsePackJson(run("npm", ["pack", "--json", "--pack-destination", packDir], path.join(root, item.dir)))[0]!
      } catch (error) {
        failures.push(`${item.name}: npm pack failed: ${commandFailureReason(error)}`)
        continue
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
        failures.push(`${item.name}: packed tarball has workspace:/catalog: specifier(s) consumers install: ${specifiers.breaking.join(", ")}`)
        continue
      }
      log(`    workspace:/catalog: specifiers ok${specifiers.cosmetic.length > 0 ? ` (devDependencies only: ${specifiers.cosmetic.join(", ")})` : ""}`)

      const missing = missingTarballFiles(packed.files.map((entry) => entry.path))
      if (missing.length > 0) {
        failures.push(`${item.name}: tarball missing ${missing.join(", ")}`)
        continue
      }
      log("    README.md/LICENSE in tarball ok")

      if (packedPkg.version !== version) {
        failures.push(`${item.name}: packed version ${packedPkg.version} != repo version ${version}`)
        continue
      }

      if (npmVersionPublished(item.name, version, run, root)) {
        log(`    registry                     ${version} already published, skipping`)
        outcomes.push({ name: item.name, version, action: "skipped-already-published" })
        continue
      }

      if (dryRun) {
        log(`    registry                     ${version} not published — would publish`)
        outcomes.push({ name: item.name, version, action: "would-publish" })
        continue
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
        failures.push(`${item.name}: publish failed: ${commandFailureReason(error)}`)
        continue
      }
      if (!npmVersionPublished(item.name, version, run, root)) {
        failures.push(`${item.name}: npm did not expose ${version} after publish`)
        continue
      }
      log(`    registry                     published ${version}`)
      outcomes.push({ name: item.name, version, action: "published" })
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

const SELECTORS: readonly PackageSelector[] = ["all", "others", "runtime-family", "runtime", "apps", "wakes"]

export function parseArgs(argv: readonly string[]) {
  const selectorArg = argValue(argv, "--track") ?? "others"
  if (!SELECTORS.includes(selectorArg as PackageSelector)) {
    throw new Error(`--track must be one of ${SELECTORS.join(", ")} (got ${selectorArg})`)
  }
  const onlyArg = argValue(argv, "--packages")
  return {
    selector: selectorArg as PackageSelector,
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
