import fs from "node:fs/promises"
import path from "node:path"
import { safeRepoUrl } from "@claxedo/sandbox-contract"
import { createBoundedGit, GIT_CLONE_TIMEOUT_MS, type GitHttpCredential } from "@claxedo/workspace-runtime/host"

/**
 * A clone runs on a pool of its own: on the shared runner it would hold a slot
 * the file tree and diff routes are waiting for.
 */
const cloneGit = createBoundedGit({ timeoutMs: GIT_CLONE_TIMEOUT_MS })

export type CloneRepository = (repoUrl: string, directory: string, credential?: GitHttpCredential) => Promise<void>

export const cloneRepository: CloneRepository = async (repoUrl, directory, credential) => {
  const parent = path.dirname(directory)
  await fs.mkdir(parent, { recursive: true })
  await cloneGit(["clone", "--", repoUrl, directory], parent, credential ? { credential } : {})
}

/** A clone git refused or could not finish, named by git's first line. */
export class RepositoryCloneError extends Error {}

/**
 * Clones `repoUrl` into a `directory` this call owns, removing it again when
 * the clone fails. Only the URL forms `safeRepoUrl` admits reach git.
 */
export async function cloneInto(repoUrl: string, directory: string, credential: GitHttpCredential | undefined, clone: CloneRepository = cloneRepository) {
  try {
    if (!safeRepoUrl(repoUrl)) throw new RepositoryCloneError("That is not a repository URL git may clone")
    await clone(repoUrl, directory, credential)
  } catch (cause) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)
    if (cause instanceof RepositoryCloneError) throw cause
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new RepositoryCloneError(`Cloning failed: ${message.split("\n").find((line) => line.trim()) ?? message}`, { cause })
  }
}
