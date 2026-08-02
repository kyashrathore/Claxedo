import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const runtimePackages = [
  { name: "@claxedo/workspace-relay-protocol", dir: "packages/workspace-relay-protocol" },
  { name: "@claxedo/workspace-relay", dir: "packages/workspace-relay" },
  { name: "@claxedo/agent-event-runtime", dir: "packages/agent-event-runtime" },
  { name: "@claxedo/agent-sdk-runtime", dir: "packages/agent-sdk-runtime" },
  { name: "@claxedo/agent-extensions", dir: "packages/agent-extensions" },
  { name: "@claxedo/workspace-runtime", dir: "packages/workspace-runtime" },
] as const

const runtimePackageNames = new Set<string>(runtimePackages.map((item) => item.name))
const dependencySections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const
const repoRoot = path.resolve(import.meta.dirname, "../../../..")

type PackageJson = {
  name?: string
  version?: string
  scripts?: Record<string, string>
} & Partial<Record<(typeof dependencySections)[number], Record<string, string>>>

type CommandRunner = (cmd: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv) => string

export function rewriteRuntimePackageJson(pkg: PackageJson, version: string) {
  const next: PackageJson = { ...pkg, version }
  for (const section of dependencySections) {
    const deps = pkg[section]
    if (!deps) continue
    next[section] = Object.fromEntries(
      Object.entries(deps).map(([name, value]) => [
        name,
        runtimePackageNames.has(name) ? version : value,
      ]),
    )
  }
  return next
}

export function workspaceDependencies(pkg: PackageJson) {
  return dependencySections.flatMap((section) =>
    Object.entries(pkg[section] ?? {})
      .filter(([, value]) => value.startsWith("workspace:"))
      .map(([name, value]) => `${section}.${name}=${value}`),
  )
}

export function packagePath(root: string, item: (typeof runtimePackages)[number]) {
  return path.join(root, item.dir, "package.json")
}

export function readPackageJson(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8")) as PackageJson
}

export function writePackageJson(file: string, pkg: PackageJson) {
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
}

export function runtimeReleasePlan(root: string, version: string) {
  return runtimePackages.map((item) => {
    const file = packagePath(root, item)
    const current = readPackageJson(file)
    if (current.name !== item.name) {
      throw new Error(`Expected ${file} to be ${item.name}, found ${current.name ?? "missing name"}`)
    }
    return {
      ...item,
      file,
      current,
      next: rewriteRuntimePackageJson(current, version),
    }
  })
}

export function defaultCommandRunner(cmd: string, args: string[], cwd = repoRoot, env?: NodeJS.ProcessEnv) {
  return execFileSync(cmd, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

export function npmPackageExists(name: string, version: string, run: CommandRunner = defaultCommandRunner) {
  try {
    run("npm", ["view", `${name}@${version}`, "version"], repoRoot)
    return true
  } catch {
    return false
  }
}

/**
 * npm's read path is eventually consistent: a `publish` that the registry
 * accepted is not necessarily visible to the very next `npm view`, because the
 * read may be served by a CDN edge that has not caught up. A single unretried
 * read after publish therefore fails on timing rather than on outcome — which
 * is what it did on 0.7.0, reporting the release red while all six packages
 * were in fact live on the registry.
 *
 * Poll instead. This still fails a publish that genuinely did not land; it only
 * stops calling a landed publish a failure because the read was early.
 */
const VISIBILITY_TIMEOUT_MS = 120_000
const VISIBILITY_POLL_MS = 5_000

export async function npmPackageVisible(
  name: string,
  version: string,
  run: CommandRunner = defaultCommandRunner,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  const deadline = Date.now() + VISIBILITY_TIMEOUT_MS
  for (;;) {
    if (npmPackageExists(name, version, run)) return true
    if (Date.now() >= deadline) return false
    console.log(`waiting for ${name}@${version} to become visible on npm`)
    await wait(VISIBILITY_POLL_MS)
  }
}

function commandFailureReason(error: unknown) {
  if (!(error instanceof Error)) return String(error)
  const stderr = "stderr" in error ? (error as { stderr?: unknown }).stderr : undefined
  const text = typeof stderr === "string"
    ? stderr
    : Buffer.isBuffer(stderr)
      ? stderr.toString("utf8")
      : error.message
  return text.split(/\n/)
    .map((line) => line.trim())
    .find((line) => line.includes("Two-factor authentication"))
    ?? text.split(/\n/).map((line) => line.trim()).find((line) => line.startsWith("npm error"))
    ?? error.message
}

export async function publishRuntimePackages(options: {
  version: string
  tag?: string
  root?: string
  dryRun?: boolean
  provenance?: boolean
  run?: CommandRunner
  /** Injected so the visibility poll is testable without real elapsed time. */
  wait?: (ms: number) => Promise<void>
}) {
  const root = options.root ?? repoRoot
  const run = options.run ?? defaultCommandRunner
  const tag = options.tag ?? "latest"
  const plan = runtimeReleasePlan(root, options.version)

  if (!options.dryRun) {
    for (const item of plan) writePackageJson(item.file, item.next)
  }

  const invalid = plan.flatMap((item) => workspaceDependencies(item.next).map((dep) => `${item.name}: ${dep}`))
  if (invalid.length > 0) {
    throw new Error(`Runtime packages still contain workspace dependencies:\n${invalid.join("\n")}`)
  }

  for (const item of plan) {
    console.log(`building ${item.name}@${options.version}`)
    // Builds run in dry-run mode too: a dry run that skips compilation cannot
    // catch build regressions (a broken workspace-runtime build shipped past
    // exactly such a dry run on 2026-07-17). Only publish is skipped.
    try {
      run("npm", ["run", "build", "--workspace", item.name], root)
    } catch (error) {
      throw new Error(`build failed: ${item.name}@${options.version}: ${commandFailureReason(error)}`)
    }
    if (item.next.scripts?.["verify:publish"] && !options.dryRun) {
      try {
        run("npm", ["run", "verify:publish", "--workspace", item.name], root)
      } catch (error) {
        throw new Error(`publish verification failed: ${item.name}@${options.version}: ${commandFailureReason(error)}`)
      }
    }
  }

  for (const item of plan) {
    if (npmPackageExists(item.name, options.version, run)) {
      console.log(`${item.name}@${options.version} already published`)
      continue
    }
    console.log(`publishing ${item.name}@${options.version}`)
    if (!options.dryRun) {
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
        throw new Error(`publish failed: ${item.name}@${options.version}: ${commandFailureReason(error)}`)
      }
    }
  }

  for (const item of plan) {
    if (!options.dryRun && !(await npmPackageVisible(item.name, options.version, run, options.wait))) {
      throw new Error(
        `npm did not expose ${item.name}@${options.version} within ${VISIBILITY_TIMEOUT_MS / 1000}s of publish`,
      )
    }
  }

  return plan.map((item) => `${item.name}@${options.version}`)
}

function argValue(name: string) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  return process.argv[index + 1]
}

async function main() {
  const version = argValue("--version")
  if (!version) {
    console.error("usage: bun run scripts/release/publish-runtime-packages.ts --version <x.y.z> [--tag latest|next] [--dry-run]")
    process.exit(1)
  }

  const published = await publishRuntimePackages({
    version,
    tag: argValue("--tag"),
    dryRun: process.argv.includes("--dry-run"),
    provenance: !process.argv.includes("--no-provenance"),
  })
  console.log(`runtime release ready: ${published.join(", ")}`)
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
