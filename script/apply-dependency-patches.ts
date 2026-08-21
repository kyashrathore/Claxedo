import { realpath } from "node:fs/promises"
import path from "node:path"

type Manifest = {
  claxedoDependencyPatches?: Record<string, string>
}

const root = path.resolve(import.meta.dirname, "..")
const manifest = (await Bun.file(path.join(root, "package.json")).json()) as Manifest
const patches = manifest.claxedoDependencyPatches ?? {}

// Inside a repository, `git apply` resolves patch paths against the repo
// TOPLEVEL and silently *skips* (exit 0) entries that don't match the cwd
// prefix — so applying from a package directory under node_modules is a
// reported-success no-op. Pass the cwd's repo-relative prefix via
// `--directory` so the patch lands on the actual files; outside any
// repository the prefix is empty and paths stay cwd-relative. The prefix is a
// pure function of the directory, so it is computed once per directory.
async function repoPrefix(directory: string) {
  const process = Bun.spawn(["git", "rev-parse", "--show-prefix"], {
    cwd: directory,
    stdout: "pipe",
    stderr: "ignore",
  })
  const [exitCode, stdout] = await Promise.all([process.exited, new Response(process.stdout).text()])
  return exitCode === 0 ? stdout.trim() : ""
}

async function runGitApply(directory: string, prefix: string, patch: string, args: string[]) {
  const directoryArgs = prefix ? [`--directory=${prefix}`] : []
  const process = Bun.spawn(["git", "apply", "--whitespace=nowarn", ...directoryArgs, ...args, patch], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  return { exitCode, output: `${stdout}${stderr}`.trim() }
}

async function packageDirectories(name: string, version: string) {
  const manifests = new Set<string>()
  const direct = path.join(root, "node_modules", name, "package.json")
  if (await Bun.file(direct).exists()) manifests.add(direct)

  const glob = new Bun.Glob(`**/node_modules/${name}/package.json`)
  for await (const item of glob.scan({ cwd: root, absolute: true, onlyFiles: true, dot: true })) {
    manifests.add(item)
  }

  const directories = new Set<string>()
  for (const packageManifest of manifests) {
    const installed = (await Bun.file(packageManifest).json()) as { version?: string }
    if (installed.version !== version) continue
    directories.add(await realpath(path.dirname(packageManifest)))
  }
  return directories
}

for (const [specifier, patchFile] of Object.entries(patches)) {
  const separator = specifier.lastIndexOf("@")
  if (separator <= 0 || separator === specifier.length - 1) {
    throw new Error(`Invalid dependency patch specifier: ${specifier}`)
  }

  const name = specifier.slice(0, separator)
  const version = specifier.slice(separator + 1)
  const patch = path.join(root, patchFile)
  const directories = await packageDirectories(name, version)
  if (directories.size === 0) {
    throw new Error(`No installed copies found for dependency patch ${specifier}`)
  }

  for (const directory of directories) {
    const prefix = await repoPrefix(directory)
    const applicable = await runGitApply(directory, prefix, patch, ["--check"])
    if (applicable.exitCode === 0) {
      const applied = await runGitApply(directory, prefix, patch, [])
      if (applied.exitCode !== 0) {
        throw new Error(`Failed to apply ${specifier} in ${directory}:\n${applied.output}`)
      }
    } else {
      const alreadyApplied = await runGitApply(directory, prefix, patch, ["--reverse", "--check"])
      if (alreadyApplied.exitCode !== 0) {
        throw new Error(`Dependency patch ${specifier} does not apply cleanly in ${directory}:\n${applicable.output}`)
      }
      continue
    }

    // git exit codes alone are not proof: git has silent-skip modes that
    // return 0 without writing (that is the bug the --directory flag fixes).
    // Only the patch being provably present — its reverse applying cleanly —
    // counts as success.
    const present = await runGitApply(directory, prefix, patch, ["--reverse", "--check"])
    if (present.exitCode !== 0) {
      throw new Error(
        `git apply reported success for ${specifier} in ${directory} but the patch is not present afterwards:\n${present.output}`,
      )
    }
  }

  console.log(`patched ${specifier} in ${directories.size} installed cop${directories.size === 1 ? "y" : "ies"}`)
}
