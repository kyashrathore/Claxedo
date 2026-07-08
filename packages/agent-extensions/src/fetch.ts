import fs from "fs/promises"
import os from "os"
import path from "path"
import { execFile as nodeExecFile } from "child_process"
import { promisify } from "util"
import { copyPackageToCache } from "./cache"
import type { GitHubPackageSource, PackageInstallSource } from "./source"

const execFileAsync = promisify(nodeExecFile)

export type ExecFile = (file: string, args: string[], options?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>

export class AgentExtensionFetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AgentExtensionFetchError"
  }
}

function execFileDefault(file: string, args: string[], options?: { cwd?: string }) {
  return execFileAsync(file, args, options) as Promise<{ stdout: string; stderr: string }>
}

export function githubRepoUrl(source: GitHubPackageSource) {
  return `https://github.com/${source.owner}/${source.repo}.git`
}

function parseSha(output: string) {
  const match = output.split(/\r?\n/).map((line) => /^([a-f0-9]{40})\s+/.exec(line)?.[1]).find(Boolean)
  if (!match) throw new AgentExtensionFetchError("GitHub source did not resolve to a commit SHA")
  return match
}

export async function resolveGitHubSource(source: PackageInstallSource, execFile: ExecFile = execFileDefault) {
  if (source.type !== "github") throw new AgentExtensionFetchError("Only GitHub package sources are supported")
  const url = githubRepoUrl(source)
  const args = source.ref
    ? ["ls-remote", url, source.ref, `refs/heads/${source.ref}`, `refs/tags/${source.ref}`]
    : ["ls-remote", url, "HEAD"]
  return parseSha((await execFile("git", args)).stdout)
}

export async function fetchGitHubPackageToCache(input: {
  source: PackageInstallSource
  resolvedSha?: string
  dataRoot: string
  execFile?: ExecFile
  tempRoot?: string
}) {
  const execFile = input.execFile ?? execFileDefault
  if (input.source.type !== "github") throw new AgentExtensionFetchError("Only GitHub package sources are supported")
  const resolvedSha = input.resolvedSha ?? await resolveGitHubSource(input.source, execFile)
  const tempRoot = await fs.mkdtemp(path.join(input.tempRoot ?? os.tmpdir(), "claxedo-agent-extension-"))
  try {
    await execFile("git", ["init", tempRoot])
    await execFile("git", ["remote", "add", "origin", githubRepoUrl(input.source)], { cwd: tempRoot })
    await execFile("git", ["fetch", "--depth", "1", "origin", resolvedSha], { cwd: tempRoot })
    await execFile("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: tempRoot })
    return {
      ...await copyPackageToCache({
        sourceRoot: tempRoot,
        resolvedSha,
        ...(input.source.package_path ? { packagePath: input.source.package_path } : {}),
        dataRoot: input.dataRoot,
      }),
      resolvedSha,
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
}
