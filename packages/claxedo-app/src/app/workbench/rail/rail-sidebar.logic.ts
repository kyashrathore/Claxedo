import { getFilename } from "@/lib/path"
import { parseOwnerRepo } from "./rail-git-remote"
import type { ProjectItem } from "./domain-types"
import { resolveSessionTitle } from "@/features/session/lib/session-title-sync"
import type { WorkspaceSessionBacking } from "@/platform/identity/session-ref"
import { localWorkspaceAssociationId } from "@/platform/identity/legacy-resolver"
import { isRelayBackedWorkspaceKind, isUserHostedWorkspaceKind, workspaceKind } from "@/platform/runtime/agent/workspace-kind"

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
 * git remote (`repo_url`), or the worktree's folder name. This is the one real
 * implementation `rail-sidebar.tsx` calls — tests exercise it directly instead
 * of hand-mirroring the derivation, so the two can never drift apart.
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
  sessionRef?: string
  project: Pick<ProjectItem, "workspaces">
  directory: TDirectory
}): WorkspaceSessionBacking | undefined {
  if (
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
  // The project inventory is authoritative for a workspace it already knows. A
  // `workspace:<uuid>` navigation ref is also how the local sidecar associates
  // sessions with a project; it is not evidence of relay hosting, so a
  // confirmed-local inventory record must win over the optimistic user-hosted
  // guess below.
  if (workspace?.kind === "local") return
  const relayKind = workspaceKind(kind)
  if (isRelayBackedWorkspaceKind(relayKind)) {
    return workspaceId ? { workspaceId, kind: relayKind } : undefined
  }
  if (!input.workspaceId) return
  if (localWorkspaceAssociationId(input.workspaceId)) return
  // An unknown `ws_*` row can still predate signed inventory hydration. UUIDs
  // and inventory-confirmed local records have already returned above.
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

/** Prefer live busy/retry from the session cache over a stale rail batch read. */
export function mergedSessionStatusType(
  batchType: string | undefined,
  liveType: string | undefined,
): string | undefined {
  if (liveType === "busy" || liveType === "retry") return liveType
  if (batchType === "busy" || batchType === "retry") return batchType
  return liveType ?? batchType
}

/**
 * The badges under a workspace row's name, in the order they are read.
 *
 * All of it comes from the CATALOG, so a workspace a teammate shares says what
 * this account may do with it and whether the machine serving it is up before
 * any pane opens it. The two sharing badges are different facts and were one
 * word ("Shared") that meant only the first:
 *
 * - "published by this machine" — this desktop is the host serving it out;
 * - "shared with you" — someone else's machine serves it and this account
 *   holds a granted role on it.
 */
export function railWorkspaceMetaLabels(input: {
  kind: string | undefined
  status?: string
  role?: string
  hostOnline?: boolean
  publishedByThisMachine: boolean
  label: (key: "role" | "hostOffline" | "sharedWithYou" | "publishedByThisMachine", role?: string) => string
}) {
  const userHosted = isUserHostedWorkspaceKind(workspaceKind(input.kind))
  const granted = userHosted && !!input.role && input.role !== "owner"
  return [
    input.status,
    // Reachability is only a question about a machine someone owns; a cloud
    // workspace's runtime is provisioned on demand and reports its own state.
    userHosted && input.hostOnline === false ? input.label("hostOffline") : undefined,
    granted ? input.label("role", input.role) : undefined,
    input.publishedByThisMachine ? input.label("publishedByThisMachine") : undefined,
    granted && !input.publishedByThisMachine ? input.label("sharedWithYou") : undefined,
  ].filter((item): item is string => !!item)
}
