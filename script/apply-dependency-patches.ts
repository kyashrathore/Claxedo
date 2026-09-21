import { readdir, readFile, realpath } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import path from "node:path"
import os from "node:os"

import { parseJsonObject, record, stringRecord } from "./json"

const root = path.resolve(import.meta.dirname, "..")
const manifestFile = path.join(root, "package.json")
const manifest = parseJsonObject(await readFile(manifestFile, "utf8"), manifestFile)
const patches = stringRecord(manifest.claxedoDependencyPatches)

export async function runGitApply(directory: string, patch: string, args: string[]) {
  // Dependency patches are package-relative data transforms, not repository
  // operations. `--no-index` disables index updates, while the deliberately
  // nonexistent GIT_DIR prevents Git from discovering an enclosing real,
  // shallow, synthetic, or partially-synced repository. Without both, Git
  // anchors paths at the outer worktree and can exit 0 after silently skipping
  // every package-relative file.
  // Keep this sentinel out of the nested Bun package path: Git for Windows
  // rejects an overlong GIT_DIR before it even reaches --no-index handling.
  const gitDirectory = path.join(os.tmpdir(), `claxedo-no-git-${randomUUID()}`)
  // Patches describe exact package bytes. Do not let a user's Git for Windows
  // configuration rewrite line endings while applying them.
  const child = spawnSync(
    "git", ["-c", "core.autocrlf=false", "-c", "core.longpaths=true", "apply", "--no-index", "--whitespace=nowarn", ...args, patch],
    {
      cwd: directory,
      env: {
        ...process.env,
        GIT_DIR: gitDirectory,
        // An explicit work tree makes package-relative patch paths authoritative
        // on every platform, including Git for Windows. GIT_DIR alone prevents
        // repository discovery but does not consistently anchor the write target.
        GIT_WORK_TREE: directory,
      },
      encoding: "utf8",
    },
  )
  if (child.error) throw child.error
  return { exitCode: child.status, output: `${child.stdout}${child.stderr}`.trim() }
}

async function packageDirectories(name: string, version: string) {
  const directories = new Set<string>()
  const visited = new Set<string>()
  async function scan(modules: string) {
    const canonical = await realpath(modules).catch(() => undefined)
    if (!canonical || visited.has(canonical)) return
    visited.add(canonical)
    const candidate = path.join(canonical, name)
    try {
      const installedFile = path.join(candidate, "package.json")
      const installed = parseJsonObject(await readFile(installedFile, "utf8"), installedFile)
      if (installed.version === version) directories.add(await realpath(candidate))
    } catch (error) {
      if (record(error)?.code !== "ENOENT") throw error
    }
    for (const entry of await readdir(canonical, { withFileTypes: true })) {
      if (entry.name === ".bun") {
        for (const item of await readdir(path.join(canonical, ".bun"))) {
          await scan(path.join(canonical, ".bun", item, "node_modules"))
        }
      } else if (entry.name.startsWith("@")) {
        const scope = path.join(canonical, entry.name)
        for (const item of await readdir(scope)) await scan(path.join(scope, item, "node_modules"))
      } else if (!entry.name.startsWith(".")) {
        await scan(path.join(canonical, entry.name, "node_modules"))
      }
    }
  }
  // An npm consumer may hoist the SDK above this package. Start locally,
  // then find the nearest installed graph; never depend on INIT_CWD.
  for (let ancestor = root; ; ancestor = path.dirname(ancestor)) {
    await scan(path.join(ancestor, "node_modules"))
    if (directories.size > 0 || path.dirname(ancestor) === ancestor) break
  }
  return directories
}

export async function applyDependencyPatches() {
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await applyDependencyPatches()
