import { getFilename } from "@/lib/path"
import { parseOwnerRepo } from "./rail-git-remote"
import type { ProjectItem } from "./domain-types"
import { sessionRoute, workspaceSessionRoute } from "@/platform/identity/route"

export type RailSessionActivationIdentity = {
  sessionId: string
  sessionRef?: string
  workspaceId?: string
  directory: string
}

export function railSessionActivationRoute(input: RailSessionActivationIdentity & { project: ProjectItem }) {
  if (input.sessionRef?.startsWith("central:")) return sessionRoute(input.sessionId)
  // A workspace row routes by DIRECTORY, unconditionally — exactly as zen did.
  // Two prior behaviors of this function each destroyed retention:
  // - Falling back to the central `/s/` route minted a meta with no directory,
  //   which `sameWorkspaceSession` can never match again, so every later open
  //   was a miss that created fresh workbench content and evicted the retained
  //   surface.
  // - Preferring `workspaceId` when a row happened to carry one made two rows
  //   of the same workspace produce different URL forms, so each switch flipped
  //   the `:workspaceId` param and re-ran workspace resolution.
  return workspaceSessionRoute(input.directory, input.sessionId)
}

/**
 * Preserve the session selected at pointerdown when prefetch refreshes the
 * inventory before click. The encoded session ref is a transport projection
 * and may change as canonical workspace metadata arrives; workspace id is the
 * authoritative identity within a project section, with directory identity
 * retained for local rows that genuinely have no workspace id.
 */
export function sameRailSessionActivationTarget(
  selected: RailSessionActivationIdentity,
  candidate: RailSessionActivationIdentity,
) {
  if (selected.sessionId !== candidate.sessionId) return false
  if (selected.sessionRef && selected.sessionRef === candidate.sessionRef) return true
  if (selected.workspaceId || candidate.workspaceId) {
    return !!selected.workspaceId && selected.workspaceId === candidate.workspaceId
  }
  return selected.directory === candidate.directory
}

export function railSessionRowForActivation<T>(
  rows: readonly T[],
  selected: RailSessionActivationIdentity,
  identity: (row: T) => RailSessionActivationIdentity,
) {
  return rows.find((row) => sameRailSessionActivationTarget(selected, identity(row)))
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

export function shouldHydrateSidebarRuntime(input: { open: boolean; active: boolean; requested: boolean }) {
  return input.open && (input.active || input.requested)
}

export function sessionIsTerminalLike(session: { id: string; title?: string }) {
  return (
    session.id.startsWith("pty_") ||
    session.id.startsWith("pty-") ||
    session.id.startsWith("terminal_") ||
    session.id.startsWith("terminal-") ||
    (session.title ?? "").trim().toLowerCase() === "terminal"
  )
}

export function sessionProjectSort(
  a: { id: string; title?: string; time?: number },
  b: { id: string; title?: string; time?: number },
) {
  return Number(sessionIsTerminalLike(b)) - Number(sessionIsTerminalLike(a)) || (b.time ?? 0) - (a.time ?? 0)
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
  return (
    input.dir === input.projectWorktree ||
    input.workspace?.directory === input.projectWorktree ||
    input.workspace?.id === input.projectWorktree ||
    input.workspace?.workspaceId === input.projectWorktree
  )
}

export function workspaceInventoryGroupFor<TSession>(input: {
  groups: Record<
    string,
    {
      key?: string
      directory?: string
      workspaceId?: string
      sessions: TSession[]
    }
  >
  workspaceDir: string
  workspace?: {
    directory?: string
    id?: string
    workspaceId?: string
  }
}) {
  const direct = input.groups[input.workspaceDir]
  if (direct) return direct

  const aliases = [input.workspace?.workspaceId, input.workspace?.id, input.workspace?.directory].filter(
    (item): item is string => !!item,
  )

  const aliasHit = aliases.map((alias) => input.groups[alias]).find(Boolean)
  if (aliasHit) return aliasHit

  return Object.values(input.groups).find(
    (group) =>
      group.key === input.workspaceDir ||
      group.directory === input.workspaceDir ||
      aliases.includes(group.key ?? "") ||
      aliases.includes(group.directory ?? "") ||
      aliases.includes(group.workspaceId ?? ""),
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
