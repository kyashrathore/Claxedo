import { mkdir, readdir } from "node:fs/promises"
import { asRecord } from "@claxedo/helpers/guards"
import { createBoundedGit, GIT_CLONE_TIMEOUT_MS, GitTimeoutError } from "@claxedo/workspace-runtime/host"
import { RUNTIME_PREPARATION_DEADLINE_MS } from "./boot-contract"
import { clearStaleShallowLock } from "./repository-history"

const git = createBoundedGit({ timeoutMs: GIT_CLONE_TIMEOUT_MS })

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

export function selectsRepository(env: NodeJS.ProcessEnv) {
  return selectedSource(env) !== undefined
}

/** The checkout's object store on disk, packed and loose, as `git count-objects` reports it in KiB. */
export async function repositorySizeBytes(directory: string) {
  const counts = await git(["count-objects", "-v"], directory)
  const kib = (name: string) => Number(new RegExp(`^${name}: (\\d+)$`, "m").exec(counts)?.[1] ?? 0)
  return (kib("size") + kib("size-pack")) * 1024
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

/** git's one line for a ref the remote does not have, under the command echo and before any advice. */
const MISSING_REMOTE_REF = /couldn't find remote ref/

/**
 * git's lines for a remote that wants a credential it was not given or refused
 * the one it was: a 401 with prompts disabled, a refused credential, a 403, and
 * the 404 GitHub answers a credential that cannot see a private repository.
 */
const ACCESS_REFUSED = /could not read (Username|Password) for|Authentication failed for|The requested URL returned error: 403|repository '[^']*' not found/

function hostName(repoUrl: string) {
  const host = new URL(repoUrl).hostname
  return host === "github.com" ? "GitHub" : host
}

function accessRefused(error: unknown, source: RepositorySource, env: NodeJS.ProcessEnv) {
  if (!(error instanceof Error) || !ACCESS_REFUSED.test(error.message)) return undefined
  const host = hostName(source.repoUrl)
  const message = env.CLAXEDO_GITHUB_CLONE_AUTH
    ? `The ${host} connection this workspace clones with cannot read ${source.repoUrl}. Give it access to the repository, or choose another connection.`
    : `${source.repoUrl} is private or does not exist. Connect ${host} with access to it, or use a public repository.`
  return new Error(message, { cause: error })
}

async function checkOut(run: Git, directory: string, source: RepositorySource) {
  const branch = source.branch ?? await originDefaultBranch(run, directory)
  try {
    await run(["fetch", "--quiet", "--depth=1", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], directory)
  } catch (error) {
    if (error instanceof Error && MISSING_REMOTE_REF.test(error.message)) {
      throw new Error(`The branch "${branch}" does not exist in ${source.repoUrl}`, { cause: error })
    }
    throw error
  }
  await run(["checkout", "--quiet", "--force", "-B", branch, "--track", `origin/${branch}`], directory)
  if (!source.branch) await run(["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`], directory)
  return branch
}

/** The branch an earlier boot checked out: the selected one, else the origin default it recorded. */
async function preparedBranch(directory: string, source: RepositorySource) {
  if (source.branch) return source.branch
  const head = await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], directory).catch(() => "")
  return head.trim().replace(/^origin\//, "") || undefined
}

/**
 * Checks out the tip of the selected repository before the runtime reports
 * ready, within one deadline for the whole preparation. The checkout is made in
 * place, so a boot stopped after init or mid-fetch leaves a repository whose
 * HEAD names no commit yet, which the next boot finishes. A checkout with a
 * commit is the person's work and is left exactly as it is. Answers, when a
 * repository is selected, the branch whose history is still to come, and
 * whether this boot made the checkout.
 */
export async function prepareRuntimeRepository(directory: string, env: NodeJS.ProcessEnv) {
  const source = selectedSource(env)
  if (!source) return undefined
  const run = untilDeadline(Date.now() + RUNTIME_PREPARATION_DEADLINE_MS)
  try {
    await mkdir(directory, { recursive: true })
    const entries = await readdir(directory)
    if (entries.includes(".git")) {
      await clearStaleShallowLock(directory)
      if (await hasCommit(directory)) return { branch: await preparedBranch(directory, source) }
    } else {
      if (entries.length) throw new Error("Cannot prepare the selected repository in a nonempty workspace directory")
      await run(["init", "--quiet"], directory)
    }
    if (!(await run(["remote"], directory)).trim()) {
      if (entries.some((entry) => entry !== ".git")) throw new Error("Cannot prepare the selected repository in a nonempty workspace directory")
      await run(["remote", "add", "origin", source.repoUrl], directory)
    }
    // `remote get-url` answers the broker's rewrite of the URL, not the one the checkout records.
    const origin = (await run(["config", "--get", "remote.origin.url"], directory)).trim()
    if (origin !== source.repoUrl) throw new Error("The workspace checkout's origin is not the selected repository")
    return { branch: await checkOut(run, directory, source), fresh: true as const }
  } catch (error) {
    if (error instanceof GitTimeoutError) {
      throw new Error(`The selected repository was not checked out within ${RUNTIME_PREPARATION_DEADLINE_MS / 60_000} minutes`, { cause: error })
    }
    throw accessRefused(error, source, env) ?? error
  }
}
