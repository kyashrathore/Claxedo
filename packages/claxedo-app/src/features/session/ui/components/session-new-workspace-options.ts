import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"

export const MAIN_WORKTREE = "main"
export const CREATE_WORKTREE = "create"

export type NewSessionWorkspaceKind = "local" | "cloud" | "user-hosted"

export type ProjectWorkspace = {
  kind?: "local" | "cloud" | "user-hosted" | null
  workspace_name?: string | null
  available?: boolean | null
  /** Git remote — the only project-scoped identity a hosted cloud row carries. */
  repo_url?: string | null
  repo_name?: string | null
  /** Present on the ws-id-keyed bootstrap shape, where the KEY is the workspace id. */
  directory?: string | null
  id?: string | null
  workspaceId?: string | null
}

export type ProjectInventoryEntry = {
  worktree?: string
  name?: string
  sandboxes?: string[]
  workspaces?: Record<string, ProjectWorkspace>
}

/**
 * The environment options the composer may offer.
 *
 * On the web build there is no local machine to run on — the renderer has no
 * filesystem and no loopback runtime — so offering "Local" produced a chip that
 * could be selected but never resolved to a workspace. Desktop keeps both.
 * `signedControlPlane` (transport !== loopback) is what distinguishes a hosted
 * web session from a desktop app pointed at its own embedded server.
 */
export function newSessionEnvironmentOptions(input: {
  platform: "web" | "desktop"
  signedControlPlane: boolean
}): Array<"local" | "cloud"> {
  if (input.platform === "web" && input.signedControlPlane) return ["cloud"]
  return ["local", "cloud"]
}

/**
 * "owner/repo" from a git remote. Mirrors `app/workbench/rail/rail-git-remote.ts`
 * — inlined because `features/session` may not import `@/app/*`
 * (src/features/session/AGENTS.md).
 */
export function ownerRepoFromRemote(remote: string | null | undefined) {
  if (!remote) return undefined
  return remote.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1]
}

/**
 * A project label derived from the repo identity its workspaces carry.
 *
 * Hosted cloud projects live in the literal directory "/workspace", so the
 * directory basename — the composer's last-resort label — renders the word
 * "workspace" as if it were the project's name. The repo is the real identity;
 * prefer it over the basename, exactly as the rail's `railProjectLabel` does.
 */
export function repoDerivedProjectLabel(
  workspaces: Record<string, ProjectWorkspace> | undefined,
): string | undefined {
  const entries = Object.values(workspaces ?? {})
  const named = entries.find((workspace) => workspace?.repo_name?.trim())?.repo_name?.trim()
  if (named) return named
  return ownerRepoFromRemote(entries.find((workspace) => workspace?.repo_url)?.repo_url)
}

/**
 * Resolve the project a directory belongs to.
 *
 * The inventory arrives in TWO shapes that key `workspaces` differently: the
 * server bootstrap keys by WORKSPACE ID (routes/hosted/shell.ts, where
 * `directory` is a field on the value) and the client snapshot keys by
 * DIRECTORY (data/query/inventory.ts). Matching only the key missed the other
 * shape, so the active project came back undefined and the workspace chip —
 * which filters THAT project's workspaces — collapsed to the "create new" path
 * even when the project already had cloud workspaces. Match both shapes, plus
 * the id fields, so either inventory resolves.
 */
export function findProjectForDirectory<T extends ProjectInventoryEntry>(
  projects: readonly T[],
  directories: ReadonlyArray<string | undefined>,
): T | undefined {
  const wanted = directories.filter((value): value is string => !!value)
  if (wanted.length === 0) return undefined
  const matches = (value: string | null | undefined) => !!value && wanted.includes(value)
  return projects.find((project) =>
    matches(project.worktree) ||
    project.sandboxes?.some((sandbox) => matches(sandbox)) ||
    Object.entries(project.workspaces ?? {}).some(([key, workspace]) =>
      matches(key) ||
      matches(workspace?.directory) ||
      matches(workspace?.id) ||
      matches(workspace?.workspaceId)
    )
  )
}

export function createNewSessionWorkspaceState(input: {
  projectRoot: string
  selectedWorktree: string
  workspaceKind: NewSessionWorkspaceKind
  sandboxes?: string[]
  workspaces?: Record<string, ProjectWorkspace>
}) {
  const workspaces = input.workspaces ?? {}
  const directoryFor = (value: string) => value === MAIN_WORKTREE ? input.projectRoot : value
  const kindFor = (value: string): NewSessionWorkspaceKind => {
    // user-hosted (self-hosted, relay-connected) is its OWN kind — never collapse
    // it into "cloud". Collapsing is what let a misresolved self-hosted workspace
    // fall into the "New cloud sandbox" create path (creatingWorkspace below only
    // auto-fires for kind === "cloud"). A self-hosted workspace already exists and
    // connects through the relay; it is never provisioned.
    const wsKind = workspaces[directoryFor(value)]?.kind
    if (wsKind === "user-hosted") return "user-hosted"
    if (wsKind === "cloud" || !!sessionWorkspaceRuntimeRef({ directory: directoryFor(value) })) return "cloud"
    return "local"
  }
  // MAIN_WORKTREE already stands for the project root, and the signed
  // inventories list that root among `sandboxes` (both groupings push every
  // workspace's directory, the root's included). Without this filter the root
  // appears twice and the hosted picker offers two identical "main" rows.
  const candidates = [
    MAIN_WORKTREE,
    ...(input.sandboxes ?? []).filter((value) => value !== input.projectRoot && value !== MAIN_WORKTREE),
    ...Object.keys(workspaces).filter(
      (value) => value !== input.projectRoot && !(input.sandboxes ?? []).includes(value),
    ),
  ]
  const options = candidates.filter((value) => {
    const workspace = workspaces[directoryFor(value)]
    if (workspace?.available === false) return false
    return kindFor(value) === input.workspaceKind
  })
  const currentWorktree =
    input.selectedWorktree === CREATE_WORKTREE
      ? options[0]
      : options.includes(input.selectedWorktree)
        ? input.selectedWorktree
        : options[0]

  return {
    options,
    currentWorktree,
    creatingWorkspace: input.selectedWorktree === CREATE_WORKTREE || (input.workspaceKind === "cloud" && options.length === 0),
    createSessionWorktree: input.workspaceKind === "cloud" || input.selectedWorktree === CREATE_WORKTREE,
    directoryFor,
    kindFor,
  }
}
