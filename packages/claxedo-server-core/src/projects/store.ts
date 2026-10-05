import type { GitHttpCredential } from "@claxedo/workspace-runtime/host"
import type { SignedControlPlaneAuth } from "../platform/auth/auth"
import { ClaxedoError } from "../platform/errors/base"

export type ProjectIcon = { override?: string; color?: string }

export type ProjectCommands = { start?: string }

/**
 * A project as every deployment answers it: a record with an id and a name.
 * Its environment lives in the credential store (`./environment`). `directory` is the checkout
 * a server with a filesystem keeps for it, and `repoUrl` the repository it was
 * created from; either is null where the deployment has no such thing.
 * `available` is false when none of its placements exists any more: its
 * folder is gone, or its cloud workspace failed. A stopped sandbox leaves it
 * available. `missingCheckout` is set when the project's own folder on this
 * server is gone, even while a worktree of it survives: the folder, and the
 * remote `reclone` fetches it from, null when none was recorded.
 */
export type ProjectRecord = {
  id: string
  name: string
  directory: string | null
  repoUrl: string | null
  icon?: ProjectIcon
  commands?: ProjectCommands
  available: boolean
  missingCheckout?: MissingCheckout
  created_at: number
  updated_at: number
}

export type MissingCheckout = { directory: string; remote: string | null }

/** The body shape a caller sends: a folder on the host, or a repository by URL or by connected account. */
export type ProjectSource =
  | { kind: "directory"; directory: string }
  | { kind: "repository"; repoUrl: string }
  | { kind: "repository"; connectionId: string; repo: { fullName: string } }

/**
 * A repository reduced to the URL to record, the name the project takes when
 * the caller sent none, and the credential a clone may carry. A store that
 * clones nothing ignores the credential.
 */
export type RepositoryResolution = { repoUrl: string; name: string; credential?: GitHttpCredential }

/**
 * A source as the store receives it: a folder as sent, or a repository the
 * store resolves when it is ready to — after its own admission and name
 * checks, so a caller nothing can bind a project to is refused before the
 * connections host or DNS is asked anything.
 */
export type ProjectSourceInput =
  | { kind: "directory"; directory: string }
  | { kind: "repository"; resolve: () => Promise<RepositoryResolution> }

export type ProjectCreateInput = {
  name?: string
  source: ProjectSourceInput
}

/** An empty `name` drops a name set by hand, so the project shows its default name again. */
export type ProjectUpdateInput = {
  name?: string
  icon?: ProjectIcon
  commands?: ProjectCommands
}

/**
 * What a deployment stores projects in. Access is not decided here: the route
 * asks the deployment's authority which records the caller may reach, and
 * hands the store only calls it has admitted.
 */
export type ProjectStore = {
  /** Whether a folder on this host can be a project's source. False where the host has no filesystem. */
  folders: boolean
  list(caller: SignedControlPlaneAuth | undefined): Promise<ProjectRecord[]>
  get(id: string): Promise<ProjectRecord | undefined>
  create(input: ProjectCreateInput, caller: SignedControlPlaneAuth | undefined): Promise<ProjectRecord>
  update(id: string, input: ProjectUpdateInput, caller: SignedControlPlaneAuth | undefined): Promise<ProjectRecord | undefined>
  /**
   * Removes the project and unregisters its placements. Files on disk are
   * untouched. Refuses with `project_has_cloud_workspaces` while a cloud
   * workspace of the project exists, because a sandbox is billed and owned
   * separately and must be deleted by its own route first.
   */
  remove(id: string, caller: SignedControlPlaneAuth | undefined): Promise<boolean>
  /**
   * Clones the project's recorded remote into its recorded folder, the only
   * place it goes, and answers the project with that folder back. `resolve`
   * is the route's admission of the remote for this caller. Refuses with
   * `project_checkout_present` while anything is at that path and
   * `project_remote_missing` when no remote was recorded, so a second call
   * while one runs is refused as present.
   */
  reclone(id: string, resolve: (repoUrl: string) => Promise<RepositoryResolution>): Promise<ProjectRecord | undefined>
}

export type ProjectErrorStatus = 400 | 401 | 402 | 403 | 404 | 409 | 501 | 502 | 503

/** A refusal the route answers as `{ error: { code, message } }` with the status it names. */
export class ProjectStoreError extends ClaxedoError {
  constructor(status: ProjectErrorStatus, code: string, message: string) {
    super({ code, message, status })
  }
}

export const PROJECT_NAME_MAX = 120

export function projectSlug(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}

/** A name shortened to what a project may carry, or undefined when nothing is left. */
export function trimmedProjectName(value: string) {
  const name = value.trim().slice(0, PROJECT_NAME_MAX)
  return name || undefined
}

/**
 * `base` when `taken` says no project bears it, else the first of `base-2`,
 * `base-3`, … that none does, so a derived name never lands on a 409 the
 * caller had no name to change.
 */
export async function freeProjectName(base: string, taken: (name: string) => Promise<boolean>) {
  if (!(await taken(base))) return base
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`
    if (!(await taken(candidate))) return candidate
  }
}
