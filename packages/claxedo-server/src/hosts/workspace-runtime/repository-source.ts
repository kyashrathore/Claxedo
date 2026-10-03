import { mkdir, readdir } from "node:fs/promises"
import { asRecord } from "@claxedo/helpers/guards"
import { createBoundedGit, GIT_CLONE_TIMEOUT_MS, GitTimeoutError } from "@claxedo/workspace-runtime/host"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { RUNTIME_PREPARATION_DEADLINE_MS } from "./boot-contract"

const git = createBoundedGit({ timeoutMs: GIT_CLONE_TIMEOUT_MS })
const log = Log.create({ service: "runtime-repository" })

// Each deepening fetch is kept once it finishes, so a runtime stopped while the
// history arrives loses at most one step.
const HISTORY_STEP_COMMITS = 1_000

type RepositorySource = { repoUrl: string; branch?: string }
type Git = (args: string[], directory: string) => Promise<string>

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
    if (asRecord(error)?.code === 1) return false
    throw error
  }
}

function untilDeadline(deadline: number): Git {
  return (args, directory) => {
    const timeoutMs = deadline - Date.now()
    if (timeoutMs <= 0) return Promise.reject(new GitTimeoutError(args))
    return git(args, directory, { timeoutMs })
  }
}

async function originDefaultBranch(run: Git, directory: string) {
  const head = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(await run(["ls-remote", "--symref", "origin", "HEAD"], directory))
  if (!head?.[1]) throw new Error("The selected repository has no default branch to check out")
  return head[1]
}

async function checkOut(run: Git, directory: string, source: RepositorySource) {
  const branch = source.branch ?? await originDefaultBranch(run, directory)
  await run(["fetch", "--quiet", "--depth=1", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], directory)
  await run(["checkout", "--quiet", "--force", "-B", branch, "--track", `origin/${branch}`], directory)
  if (!source.branch) await run(["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`], directory)
}

/**
 * Checks out the tip of the selected repository before the runtime reports
 * ready, within one deadline for the whole preparation. The checkout is made in
 * place, so a boot stopped mid-fetch leaves a repository whose HEAD names no
 * commit yet, which the next boot finishes. A checkout with a commit is the
 * person's work and is left exactly as it is. Answers whether a repository
 * was selected.
 */
export async function prepareRuntimeRepository(directory: string, env: NodeJS.ProcessEnv) {
  const source = selectedSource(env)
  if (!source) return false
  const run = untilDeadline(Date.now() + RUNTIME_PREPARATION_DEADLINE_MS)
  try {
    await mkdir(directory, { recursive: true })
    const entries = await readdir(directory)
    if (entries.includes(".git")) {
      if (await hasCommit(directory)) return true
      const origin = (await run(["remote", "get-url", "origin"], directory)).trim()
      if (origin !== source.repoUrl) throw new Error("The workspace checkout's origin is not the selected repository")
    } else {
      if (entries.length) throw new Error("Cannot prepare the selected repository in a nonempty workspace directory")
      await run(["init", "--quiet"], directory)
      await run(["remote", "add", "origin", source.repoUrl], directory)
    }
    await checkOut(run, directory, source)
    return true
  } catch (error) {
    if (error instanceof GitTimeoutError) {
      throw new Error(`The selected repository was not checked out within ${RUNTIME_PREPARATION_DEADLINE_MS / 60_000} minutes`, { cause: error })
    }
    throw error
  }
}

/**
 * Fetches the history a prepared checkout started without, in steps, while the
 * runtime serves. A step that fails is logged and the next boot continues from
 * the last finished one.
 */
export async function completeRuntimeRepositoryHistory(directory: string) {
  try {
    while ((await git(["rev-parse", "--is-shallow-repository"], directory)).trim() === "true") {
      await git(["fetch", "--quiet", `--deepen=${HISTORY_STEP_COMMITS}`, "origin"], directory)
    }
  } catch (error) {
    log.warn("repository history fetch stopped", { error: error instanceof Error ? error.message : String(error) })
  }
}
