import { getFilename } from "@/lib/path"
import { parseOwnerRepo } from "./rail-git-remote"
import type { ProjectItem } from "./domain-types"
import { resolveSessionTitle } from "@/features/session/lib/session-title-sync"
import type { SessionHost, WorkspaceSessionBacking } from "@/platform/identity/session-ref"

export function sessionRowTitle(title?: string, projectedTitle?: string, updatedAt?: number) {
  return resolveSessionTitle({
    // Projection output is already resolved state, not a new optimistic input.
    // Treating it as provisional gives even a stale "New Session" placeholder
    // precedence over fresh concrete inventory.
    directoryTitle: projectedTitle,
    inventoryTitle: title,
    inventoryUpdatedAt: updatedAt,
  }) ?? "Untitled session"
}

/**
 * The owner/repo label shown for a project in the rail, derived from (in order)
 * an explicit project name, the parsed owner/repo of the first workspace with a
 * git remote (`repo_url`), or the worktree's folder name. This is the real
 * implementation used by rail-sidebar.tsx — previously an inline closure that a
 * 1186-line test file hand-mirrored (and had already drifted from: the mirror
 * read `sessions[].git.remote`, not `workspaces[].repo_url`).
 */
export function railProjectLabel(project: Pick<ProjectItem, "name" | "worktree" | "workspaces">): string {
  return (
    project.name ??
    parseOwnerRepo(Object.values(project.workspaces ?? {}).find((item) => item.repo_url)?.repo_url) ??
    getFilename(project.worktree)
  )
}

/**
 * The project caption ("owner/repo · folder", or just one when they coincide).
 * Real implementation used by rail-sidebar.tsx's project header.
 */
export function railProjectCaptionFromName(project: Pick<ProjectItem, "name" | "worktree" | "workspaces">): string {
  const repo =
    project.name ?? parseOwnerRepo(Object.values(project.workspaces ?? {}).find((item) => item.repo_url)?.repo_url)
  const folder = getFilename(project.worktree)
  if (!repo) return folder
  if (repo === folder) return repo
  return `${repo} · ${folder}`
}

export function shouldAutoOpenWorkspaceSection(input: {
  rows: number
  terminals?: number
  autoOpened: boolean
  manuallyToggled: boolean
}) {
  if (input.autoOpened || input.manuallyToggled) return false
  return input.rows > 0 || (input.terminals ?? 0) > 0
}

export function shouldHydrateSidebarRuntime(input: {
  open: boolean
  active: boolean
  requested: boolean
}) {
  return input.open && (input.active || input.requested)
}

export function projectActionDirectory<TDirectory extends string>(input: {
  directories: readonly TDirectory[]
  activeDirectory?: string
  projectWorktree: TDirectory
  workspaceIdForDirectory: (directory: TDirectory) => string | undefined
}) {
  const active = input.activeDirectory
    ? input.directories.find((directory) =>
        directory === input.activeDirectory || input.workspaceIdForDirectory(directory) === input.activeDirectory)
    : undefined
  return active ?? input.directories[0] ?? input.projectWorktree
}

export function railWorkspaceSessionBacking<TDirectory extends string>(input: {
  workspaceId?: string
  environmentKind?: string
  host?: SessionHost
  sessionRef?: string
  project: Pick<ProjectItem, "workspaces">
  directory: TDirectory
}): WorkspaceSessionBacking | undefined {
  if (
    input.host === "central" ||
    input.sessionRef?.startsWith("central:") ||
    input.sessionRef?.startsWith("local:")
  ) return
  const workspace = input.project.workspaces?.[input.directory] ??
    Object.values(input.project.workspaces ?? {}).find((item) =>
      item.directory === input.directory ||
      item.id === input.directory ||
      item.workspaceId === input.directory
    )
  const kind = input.environmentKind ?? workspace?.kind
  const workspaceId = input.workspaceId ?? workspace?.workspaceId ?? workspace?.id
  if (kind === "cloud" || kind === "user-hosted") {
    return workspaceId ? { workspaceId, kind } : undefined
  }
  if (!input.workspaceId) return
  // Project and runtime environment labels can still say `local` for a
  // user-hosted workspace: its owner executes it locally while browsers reach
  // it through the relay. Canonical central/local refs above are placement;
  // these labels are not. An explicit workspace row with no signed kind stays
  // optimistically relay-backed until signed inventory hydrates.
  return { workspaceId: input.workspaceId, kind: "user-hosted" }
}

export function sessionIsTerminalLike(session: { id: string; title?: string }) {
  return session.id.startsWith("pty_") ||
    session.id.startsWith("pty-") ||
    session.id.startsWith("terminal_") ||
    session.id.startsWith("terminal-") ||
    (session.title ?? "").trim().toLowerCase() === "terminal"
}

export function sessionProjectSort(a: { id: string; title?: string; time?: number }, b: { id: string; title?: string; time?: number }) {
  return Number(sessionIsTerminalLike(b)) - Number(sessionIsTerminalLike(a)) ||
    (b.time ?? 0) - (a.time ?? 0)
}

export function isRootWorktreeRef(input: {
  dir: string
  projectWorktree: string
  workspace?: {
    directory?: string
    id?: string
    workspaceId?: string
  }
}) {
  return input.dir === input.projectWorktree ||
    input.workspace?.directory === input.projectWorktree ||
    input.workspace?.id === input.projectWorktree ||
    input.workspace?.workspaceId === input.projectWorktree
}

export function workspaceInventoryGroupFor<TSession>(input: {
  groups: Record<string, {
    key?: string
    directory?: string
    workspaceId?: string
    sessions: TSession[]
  }>
  workspaceDir: string
  workspace?: {
    directory?: string
    id?: string
    workspaceId?: string
  }
}) {
  const direct = input.groups[input.workspaceDir]
  if (direct) return direct

  const aliases = [
    input.workspace?.workspaceId,
    input.workspace?.id,
    input.workspace?.directory,
  ].filter((item): item is string => !!item)

  const aliasHit = aliases.map((alias) => input.groups[alias]).find(Boolean)
  if (aliasHit) return aliasHit

  return Object.values(input.groups).find((group) =>
    group.key === input.workspaceDir ||
    group.directory === input.workspaceDir ||
    aliases.includes(group.key ?? "") ||
    aliases.includes(group.directory ?? "") ||
    aliases.includes(group.workspaceId ?? "")
  )
}

export function isDisclosureToggleKey(key: string) {
  return key === "Enter" || key === " "
}

export function activateDisclosureFromKeyboard(
  event: { key: string; preventDefault: () => void; stopPropagation: () => void },
  toggle: () => void,
) {
  if (!isDisclosureToggleKey(event.key)) return
  event.preventDefault()
  event.stopPropagation()
  toggle()
}

export function unambiguousSessionStatusTarget<T extends { sessionID: string }>(
  targets: readonly T[],
  sessionID: string,
) {
  let match: T | undefined
  for (const target of targets) {
    if (target.sessionID !== sessionID) continue
    if (match) return undefined
    match = target
  }
  return match
}

export function indexUnambiguousSessionStatusTargets<T extends { sessionID: string }>(targets: readonly T[]) {
  const result = new Map<string, T>()
  const ambiguous = new Set<string>()
  for (const target of targets) {
    if (ambiguous.has(target.sessionID)) continue
    if (result.delete(target.sessionID)) {
      ambiguous.add(target.sessionID)
      continue
    }
    result.set(target.sessionID, target)
  }
  return result
}

export function primedSessionStatusType(status?: { type: string }) {
  return status?.type ?? "idle"
}
