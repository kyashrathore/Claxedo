import { mkdir, readdir } from "node:fs/promises"
import { createBoundedGit, GIT_CLONE_TIMEOUT_MS } from "@claxedo/workspace-runtime/host"

const git = createBoundedGit({ timeoutMs: GIT_CLONE_TIMEOUT_MS })

type RepositorySource = { repoUrl: string; branch?: string }

function selectedSource(env: NodeJS.ProcessEnv): RepositorySource | undefined {
  const kind = env.WORKSPACE_RUNTIME_SOURCE_KIND
  if (kind === undefined || kind === "empty") return undefined
  if (kind !== "git") throw new Error(`Unsupported workspace runtime source kind: ${kind}`)
  const repoUrl = env.WORKSPACE_RUNTIME_GIT_REPO_URL?.trim()
  if (!repoUrl) throw new Error("A git workspace source requires a repository URL")
  const url = new URL(repoUrl)
  // The URL lands in .git/config, so a credential in it would outlive the boot
  // that delivered it; the credential travels as the brokered header instead.
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("A git workspace source requires a credential-free HTTP(S) repository URL")
  }
  const branch = env.WORKSPACE_RUNTIME_GIT_BRANCH?.trim()
  return { repoUrl, ...(branch ? { branch } : {}) }
}

async function hasCommit(directory: string) {
  try {
    await git(["rev-parse", "--verify", "--quiet", "HEAD"], directory)
    return true
  } catch (error) {
    // `--quiet` exits 1 with no output exactly when HEAD names no commit yet.
    if ((error as { code?: unknown }).code === 1) return false
    throw error
  }
}

async function defaultBranch(directory: string) {
  await git(["remote", "set-head", "origin", "--auto"], directory)
  return (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], directory)).trim().replace(/^origin\//, "")
}

async function checkOut(directory: string, source: RepositorySource) {
  await git(["fetch", "--quiet", "origin"], directory)
  const branch = source.branch ?? await defaultBranch(directory)
  await git(["checkout", "--quiet", "--force", "-B", branch, "--track", `origin/${branch}`], directory)
}

/**
 * Prepares the selected repository before the runtime reports ready. The
 * checkout is made in place, so a boot killed mid-fetch leaves a repository
 * whose HEAD names no commit yet, which the next boot finishes. A checkout
 * with a commit is the person's work and is only checked against the origin.
 */
export async function prepareRuntimeRepository(directory: string, env: NodeJS.ProcessEnv) {
  const source = selectedSource(env)
  if (!source) return
  await mkdir(directory, { recursive: true })
  const entries = await readdir(directory)
  if (entries.includes(".git")) {
    const origin = (await git(["remote", "get-url", "origin"], directory)).trim()
    if (origin !== source.repoUrl) throw new Error("The workspace checkout's origin is not the selected repository")
    if (await hasCommit(directory)) return
  } else {
    if (entries.length) throw new Error("Cannot prepare the selected repository in a nonempty workspace directory")
    await git(["init", "--quiet"], directory)
    await git(["remote", "add", "origin", source.repoUrl], directory)
  }
  await checkOut(directory, source)
}
