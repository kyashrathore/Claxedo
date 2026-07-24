import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"

export const MAIN_WORKTREE = "main"
export const CREATE_WORKTREE = "create"

export type NewSessionWorkspaceKind = "local" | "cloud" | "user-hosted"

export type ProjectWorkspace = {
  kind?: "local" | "cloud" | "user-hosted" | null
  workspace_name?: string | null
  available?: boolean | null
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
  const candidates = [
    MAIN_WORKTREE,
    ...(input.sandboxes ?? []),
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
