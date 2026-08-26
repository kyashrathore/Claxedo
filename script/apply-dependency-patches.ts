import { realpath } from "node:fs/promises"
import path from "node:path"

type Manifest = {
  claxedoDependencyPatches?: Record<string, string>
}

const root = path.resolve(import.meta.dirname, "..")
const manifest = (await Bun.file(path.join(root, "package.json")).json()) as Manifest
const patches = manifest.claxedoDependencyPatches ?? {}

async function gitToplevel(directory: string) {
  const process = Bun.spawn(["git", "-C", directory, "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout] = await Promise.all([process.exited, new Response(process.stdout).text()])
  if (exitCode !== 0) return null
  const toplevel = stdout.trim()
  return toplevel ? await realpath(toplevel) : null
}

async function runGitApply(directory: string, patch: string, args: string[]) {
  // `git apply` run from inside a work tree resolves the patch's paths against
  // the repo TOP LEVEL — and from a subdirectory it silently SKIPS every
  // out-of-scope file while still exiting 0. Since node_modules always sits
  // inside this repository's work tree, the old cwd-based invocation reported
  // "patched" without changing a byte (verified: the applier ran green while
  // the tokentracker and virtual-core dists carried none of their patch
  // content). Anchor at the enclosing repo root and address the package with
  // --directory so paths resolve to the real files; outside any repository
  // (a bare CI workdir) plain cwd application already behaves correctly.
  const toplevel = await gitToplevel(directory)
  const directoryArgs = toplevel && toplevel !== directory
    ? [`--directory=${path.relative(toplevel, directory).replaceAll(path.sep, "/")}`]
    : []
  const process = Bun.spawn(["git", "apply", "--whitespace=nowarn", ...directoryArgs, ...args, patch], {
    cwd: toplevel ?? directory,
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
    const applicable = await runGitApply(directory, patch, ["--check"])
    if (applicable.exitCode === 0) {
      const applied = await runGitApply(directory, patch, [])
      if (applied.exitCode !== 0) {
        throw new Error(`Failed to apply ${specifier} in ${directory}:\n${applied.output}`)
      }
    } else {
      const alreadyApplied = await runGitApply(directory, patch, ["--reverse", "--check"])
      if (alreadyApplied.exitCode !== 0) {
        throw new Error(`Dependency patch ${specifier} does not apply cleanly in ${directory}:\n${applicable.output}`)
      }
      continue
    }

    // git exit codes alone are not proof: git has silent-skip modes that
    // return 0 without writing (that is the bug the --directory flag fixes).
    // Only the patch being provably present — its reverse applying cleanly —
    // counts as success.
    const present = await runGitApply(directory, patch, ["--reverse", "--check"])
    if (present.exitCode !== 0) {
      throw new Error(
        `git apply reported success for ${specifier} in ${directory} but the patch is not present afterwards:\n${present.output}`,
      )
    }
  }

  console.log(`patched ${specifier} in ${directories.size} installed cop${directories.size === 1 ? "y" : "ies"}`)
}
