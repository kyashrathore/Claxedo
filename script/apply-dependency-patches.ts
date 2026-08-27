import { realpath } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"

type Manifest = {
  claxedoDependencyPatches?: Record<string, string>
}

const root = path.resolve(import.meta.dirname, "..")
const manifest = (await Bun.file(path.join(root, "package.json")).json()) as Manifest
const patches = manifest.claxedoDependencyPatches ?? {}

export async function runGitApply(directory: string, patch: string, args: string[]) {
  // Dependency patches are package-relative data transforms, not repository
  // operations. `--no-index` disables index updates, while the deliberately
  // nonexistent GIT_DIR prevents Git from discovering an enclosing real,
  // shallow, synthetic, or partially-synced repository. Without both, Git
  // anchors paths at the outer worktree and can exit 0 after silently skipping
  // every package-relative file.
  const gitDirectory = path.join(directory, `.claxedo-dependency-patch-no-git-${process.pid}-${randomUUID()}`)
  const child = Bun.spawn(["git", "apply", "--no-index", "--whitespace=nowarn", ...args, patch], {
    cwd: directory,
    env: {
      ...process.env,
      GIT_DIR: gitDirectory,
      // An explicit work tree makes package-relative patch paths authoritative
      // on every platform, including Git for Windows. GIT_DIR alone prevents
      // repository discovery but does not consistently anchor the write target.
      GIT_WORK_TREE: directory,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
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

async function main() {
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

      // Git exit codes alone are not proof: repository-relative silent skips
      // return 0 without writing. Only a reverse check against the package's
      // actual bytes counts as success.
      const present = await runGitApply(directory, patch, ["--reverse", "--check"])
      if (present.exitCode !== 0) {
        throw new Error(
          `git apply reported success for ${specifier} in ${directory} but the patch is not present afterwards:\n${present.output}`,
        )
      }
    }

    console.log(`patched ${specifier} in ${directories.size} installed cop${directories.size === 1 ? "y" : "ies"}`)
  }
}

if (import.meta.main) await main()
