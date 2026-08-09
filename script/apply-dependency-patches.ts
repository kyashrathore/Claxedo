import { realpath } from "node:fs/promises"
import path from "node:path"

type Manifest = {
  claxedoDependencyPatches?: Record<string, string>
}

const root = path.resolve(import.meta.dirname, "..")
const manifest = (await Bun.file(path.join(root, "package.json")).json()) as Manifest
const patches = manifest.claxedoDependencyPatches ?? {}

async function runGitApply(directory: string, patch: string, args: string[]) {
  const process = Bun.spawn(["git", "apply", "--whitespace=nowarn", ...args, patch], {
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
    const applicable = await runGitApply(directory, patch, ["--check"])
    if (applicable.exitCode === 0) {
      const applied = await runGitApply(directory, patch, [])
      if (applied.exitCode !== 0) {
        throw new Error(`Failed to apply ${specifier} in ${directory}:\n${applied.output}`)
      }
      continue
    }

    const alreadyApplied = await runGitApply(directory, patch, ["--reverse", "--check"])
    if (alreadyApplied.exitCode !== 0) {
      throw new Error(`Dependency patch ${specifier} does not apply cleanly in ${directory}:\n${applicable.output}`)
    }
  }

  console.log(`patched ${specifier} in ${directories.size} installed cop${directories.size === 1 ? "y" : "ies"}`)
}
