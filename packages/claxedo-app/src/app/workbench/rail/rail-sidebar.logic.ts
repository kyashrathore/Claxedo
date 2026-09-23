import { getFilename } from "@opencode-ai/ui/utils/path"
import { parseOwnerRepo } from "./rail-git-remote"
import type { ProjectItem, RuntimeKind } from "./domain-types"
import { resolveSessionTitle } from "@/features/session/lib/session-title-sync"
import { remoteAccessSessionLink } from "@/features/settings/remote-access/remote-access-state"
import type { WorkspaceSessionBacking } from "@/platform/identity/session-ref"
import { localWorkspaceAssociationId } from "@/platform/identity/legacy-resolver"
import { type WorkspaceHostKind, asHostKind, inventoryHostKind, isRelayHostKind } from "@/platform/runtime/placement-wire"
import { projectWorkspaceForRef } from "@/platform/identity/project-workspace"
import { sessionDeepLink } from "../state/route-deep-links"

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

/**
 * The identity a relay-backed workspace is addressed by. Falls back to the
 * ref itself, which for a control-plane row IS `workspace:<id>` — the same
 * identity, in the form the catalog keyed it under.
 */
export function workspaceRowId(project: Pick<ProjectItem, "workspaces">, directory: string) {
  const workspace = projectWorkspaceForRef(project.workspaces, directory)
  return workspace?.workspaceId ?? workspace?.id ?? directory
}

/** The runtime that serves a workspace, as its catalog row reports it. */
export function workspaceRuntimeKind(
  project: Pick<ProjectItem, "workspaces" | "worktree">,
  directory: string,
  mainIsCloud?: boolean,
): RuntimeKind {
  const kind = inventoryHostKind(projectWorkspaceForRef(project.workspaces, directory)?.kind)
  if (kind) return kind
  if (directory === project.worktree && mainIsCloud) return "provisioner"
  return "self"
}

// `directory` is a directory string, spelled as one. It used to be a
// `TDirectory extends string` type parameter that constrained nothing and
// whose only effect was to keep this parameter out of the `directoryStringParams`
// debt regex; the debt is the same either way, so it is counted now.
export function railWorkspaceSessionBacking(input: {
  workspaceId?: string
  environmentKind?: string
  sessionRef?: string
  project: Pick<ProjectItem, "workspaces">
  directory: string
}): WorkspaceSessionBacking | undefined {
  if (
    input.sessionRef?.startsWith("central:") ||
    input.sessionRef?.startsWith("local:")
  ) return undefined
  // A relay-backed session row is addressed as `workspace:<id>`, which is the
  // catalog's row under another of its identities — `projectWorkspaceForRef`
  // is what makes the two meet, so the row's own kind and id decide the
  // backing instead of the `ws_*`-shape guess below.
  const workspace = projectWorkspaceForRef(input.project.workspaces, input.directory)
  const rowKind = inventoryHostKind(workspace?.kind)
  const workspaceId = input.workspaceId ?? workspace?.workspaceId ?? workspace?.id
  // The project inventory is authoritative for a workspace it already knows. A
  // `workspace:<uuid>` navigation ref is also how the local sidecar associates
  // sessions with a project; it is not evidence of relay hosting, so a
  // confirmed-self inventory record must win over the optimistic guess below.
  if (rowKind === "self") return undefined
  const relayKind = asHostKind(input.environmentKind) ?? rowKind
  if (isRelayHostKind(relayKind)) {
    return workspaceId ? { workspaceId, kind: relayKind } : undefined
  }
  if (!input.workspaceId) return undefined
  if (localWorkspaceAssociationId(input.workspaceId)) return undefined
  // An unknown `ws_*` row can still predate signed inventory hydration. UUIDs
  // and inventory-confirmed local records have already returned above.
  return { workspaceId: input.workspaceId, kind: "machine" }
}

/**
 * Which "copy" affordances a session row may offer.
 *
 * `link` is a hosted-app URL, so it exists only where the deployment can
 * resolve the session: workspace-backed rows (the workspace id goes through
 * the control plane whoever opens it), or any row when the app's own server
 * IS the control plane — `localServer` false means hosted or self-hosted web,
 * where the registry answers `/s/<id>` for central sessions.
 *
 * `deepLink` is the `claxedo://` address of a session that lives on this
 * machine's disk — the `local:<dir>:session:<id>` rows. A workspace-backed
 * row's directory is a path on another machine, so it earns no deep link.
 */
export function sessionRowLinks(input: {
  sessionId: string
  sessionRef: string
  workspaceDirectory: string
  workspaceId?: string
  localServer: boolean
  /** Absolute path of the local daemon's session sqlite store, when known. */
  sessionStore?: string
}): { link?: string; deepLink?: string } {
  const link =
    input.workspaceId || !input.localServer
      ? remoteAccessSessionLink({
          sessionId: input.sessionId,
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        })
      : undefined
  const deepLink =
    !input.workspaceId && input.sessionRef.startsWith("local:")
      ? sessionDeepLink({
          workspaceDirectory: input.workspaceDirectory,
          sessionId: input.sessionId,
          ...(input.sessionStore ? { store: input.sessionStore } : {}),
        })
      : undefined
  return { link, deepLink }
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
 * Which authority a rail row's status comes from.
 *
 * The focused pane's session-id cache entry always participates: a gap on
 * its stream resyncs that session. A BACKGROUND row's entry is written by
 * the same `wr/events` stream (every session of the routed workspace frames
 * its status there) but nothing resyncs it across a gap, and a row of a
 * workspace not routed has no stream at all — so a background row follows
 * the rail's own `/session/status` batch read, which every row gets.
 *
 * The exception is the window this function exists for. The client's own send
 * writes an OPTIMISTIC busy for the session it sent to; a background row used
 * to discard that outright, so a turn that started and finished between two
 * batch reads (they are ~10s apart) was never once rendered as working, and
 * the unseen-done dot that depends on having observed the active state never
 * appeared either. The optimistic dispatch is authoritative until a batch read
 * that could actually have seen it comes back: the comparison is against the
 * read's START time, since a read already in flight when the prompt was sent
 * answers a question asked before the turn existed.
 */
export function railRowStatusType(input: {
  batchType: string | undefined
  liveType: string | undefined
  focused: boolean
  optimisticStartedAt?: number
  batchReadStartedAt?: number
}): string | undefined {
  if (input.focused) return mergedSessionStatusType(input.batchType, input.liveType)
  if (
    input.optimisticStartedAt !== undefined &&
    (input.batchReadStartedAt === undefined || input.optimisticStartedAt > input.batchReadStartedAt)
  ) {
    return mergedSessionStatusType(input.batchType, input.liveType)
  }
  return input.batchType
}

/**
 * The badges under a workspace row's name, in the order they are read.
 *
 * All of it comes from the CATALOG, so a workspace a teammate shares says what
 * this account may do with it and whether the machine serving it is up before
 * any pane opens it. The two sharing badges are different facts and one word
 * for both would state only the first:
 *
 * - "published to your account" — this desktop serves the workspace out;
 * - "shared with you" — someone else's machine serves it and this account
 *   holds a granted role on it.
 */
export function railWorkspaceMetaLabels(input: {
  kind: WorkspaceHostKind | undefined
  status?: string
  role?: string
  hostOnline?: boolean
  publishedToYourAccount: boolean
  label: (key: "role" | "hostOffline" | "sharedWithYou" | "publishedToYourAccount", role?: string) => string
}) {
  const onAMachine = input.kind === "machine"
  const granted = onAMachine && !!input.role && input.role !== "owner"
  return [
    input.status,
    // Reachability is only a question about a machine someone owns; the
    // provisioner brings a runtime up on demand and reports its own state.
    onAMachine && input.hostOnline === false ? input.label("hostOffline") : undefined,
    granted ? input.label("role", input.role) : undefined,
    input.publishedToYourAccount ? input.label("publishedToYourAccount") : undefined,
    granted && !input.publishedToYourAccount ? input.label("sharedWithYou") : undefined,
  ].filter((item): item is string => !!item)
}
