import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { readString } from "@claxedo/helpers/readers"
import { createBoundedGit } from "@claxedo/workspace-runtime/host"
import { dataDir } from "../../platform/runtime/lib/paths"

/**
 * `worktree add` copies a repository onto disk, so it gets a deadline no
 * working operation reaches and a pool of its own: on the shared runner it
 * would park a listing behind a copy that runs for minutes.
 */
const worktreeGit = createBoundedGit({ timeoutMs: 30 * 60_000 })

export type WorktreeCheckout =
  | Readonly<{ kind: "detached"; revision: string }>
  | Readonly<{ kind: "branch"; branch: string; baseRef?: string }>

export type ResolvedWorktreeCheckout =
  | Readonly<{ kind: "detached"; revision: string }>
  | Readonly<{ kind: "branch"; branch: string; baseCommit?: string }>

export type WorktreeInfo = { readonly name: string; readonly branch: string; readonly directory: string }

export class WorktreeProvisionError extends Error {
  constructor(message: string, readonly detail: string) {
    super(message)
  }
}

async function worktreeCommand(directory: string, args: string[]) {
  try {
    return { ok: true as const, out: (await worktreeGit(args, directory)).trim() }
  } catch (error) {
    return { ok: false as const, detail: readString(error, "stderr")?.trim() || readString(error, "message") || "git failed" }
  }
}

function slug(input: string) {
  return input.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").replace(/-+$/, "")
}

/** Where this machine keeps the worktrees of one project: `<dataDir>/worktree/<projectId>`. */
export function worktreeRoot(projectId: string) {
  return path.join(dataDir(), "worktree", projectId)
}

/**
 * A free name for a new worktree of `repositoryDirectory`: its folder under
 * the project's worktree root and its `claxedo/<name>` branch, both unused.
 * Named after `name` when one is given, else a random `wt-` name.
 */
export async function nextWorktreeInfo(repositoryDirectory: string, projectId: string, name?: string): Promise<WorktreeInfo | undefined> {
  const root = worktreeRoot(projectId)
  await fs.mkdir(root, { recursive: true })
  const base = name ? slug(name) : ""
  for (let attempt = 0; attempt < 26; attempt += 1) {
    const next = base || `wt-${randomUUID().slice(0, 8)}`
    const item = attempt === 0 ? next : `${next}-${randomUUID().slice(0, 4)}`
    const branch = `claxedo/${item}`
    const directory = path.join(root, item)
    if (await fs.stat(directory).then(() => true, () => false)) continue
    if ((await worktreeCommand(repositoryDirectory, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).ok) continue
    return { name: item, branch, directory }
  }
  return undefined
}

/** The commit a branch checkout's base names, so an invalid base is refused before anything is written. */
export async function resolveWorktreeCheckout(repositoryDirectory: string, checkout: WorktreeCheckout): Promise<ResolvedWorktreeCheckout> {
  if (checkout.kind === "detached") return checkout
  if (checkout.baseRef === undefined) return { kind: "branch", branch: checkout.branch }
  const resolved = await worktreeCommand(repositoryDirectory, ["rev-parse", "--verify", "--end-of-options", `${checkout.baseRef}^{commit}`])
  if (!resolved.ok) throw new WorktreeProvisionError("Invalid worktree base", resolved.detail)
  return { kind: "branch", branch: checkout.branch, baseCommit: resolved.out }
}

/**
 * Checks out `checkout` of `repositoryDirectory` as a git worktree at
 * `directory`, unless one is already there. Answers whether this call made it,
 * so a caller that fails to register it can take it back.
 */
export async function addGitWorktree(repositoryDirectory: string, directory: string, checkout: ResolvedWorktreeCheckout): Promise<{ created: boolean }> {
  if (await fs.stat(path.join(directory, ".git")).then(() => true, () => false)) return { created: false }
  await fs.mkdir(path.dirname(directory), { recursive: true })
  const args = checkout.kind === "detached"
    ? ["worktree", "add", "--detach", directory, checkout.revision]
    : ["worktree", "add", "-b", checkout.branch, directory, ...(checkout.baseCommit !== undefined ? [checkout.baseCommit] : [])]
  const created = await worktreeCommand(repositoryDirectory, args)
  if (!created.ok) throw new WorktreeProvisionError("Failed to create git worktree", created.detail)
  return { created: true }
}

export async function removeGitWorktree(directory: string) {
  if (!(await fs.stat(directory).then(() => true, () => false))) return
  const common = await worktreeCommand(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  if (!common.ok) throw new WorktreeProvisionError("Failed to locate git worktree", common.detail)
  const removed = await worktreeCommand(directory, ["--git-dir", common.out, "worktree", "remove", "--force", directory])
  if (!removed.ok) throw new WorktreeProvisionError("Failed to remove git worktree", removed.detail)
}
