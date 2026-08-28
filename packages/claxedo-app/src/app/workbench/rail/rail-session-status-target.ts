import { workspaceKey, type SessionRef } from "@/platform/identity/session-ref"
export type RailSessionStatusTarget = {
  key: string
  directory: string
  sessionID: string
  workspaceId?: string
}

export type RailSessionStatusTargetGroup = {
  directory: string
  workspaceId?: string
  targets: RailSessionStatusTarget[]
}

// The rail may have an arbitrary number of disclosed workspace sections. Its
// status projection is useful lightweight metadata, but it must not create an
// observer/request pair for every session ever paged into a long-lived rail.
export const MAX_RAIL_SESSION_STATUS_TARGETS = 50

export function pruneRailSessionActivityMap<T>(
  current: Record<string, T | undefined>,
  targets: readonly Pick<RailSessionStatusTarget, "key">[],
) {
  const targetKeys = new Set(targets.map((target) => target.key))
  const stale = Object.keys(current).filter((key) => !targetKeys.has(key))
  if (stale.length === 0) return current
  const next = { ...current }
  for (const key of stale) delete next[key]
  return next
}

export function boundRailSessionStatusTargets(
  targets: readonly RailSessionStatusTarget[],
  limit = MAX_RAIL_SESSION_STATUS_TARGETS,
  priorityKey?: string,
) {
  const seen = new Set<string>()
  const bounded: RailSessionStatusTarget[] = []
  const priority = priorityKey ? targets.find((target) => target.key === priorityKey) : undefined
  const ordered = priority ? [priority, ...targets] : targets
  for (const target of ordered) {
    if (seen.has(target.key)) continue
    seen.add(target.key)
    bounded.push(target)
    if (bounded.length >= limit) break
  }
  return bounded
}

export function activeRailSessionStatusTarget(input: {
  targets: readonly RailSessionStatusTarget[]
  sessionID?: string
  directory?: string
  host?: "central" | "workspace"
  workspaceId?: string
}) {
  return input.targets.find((target) =>
    target.sessionID === input.sessionID &&
    (input.host === "central"
      ? target.key.startsWith("central:") && target.directory === input.directory
      : input.workspaceId
        ? target.workspaceId === input.workspaceId
        : target.directory === input.directory))
}

export function railSessionStatusTarget(input: {
  key: string
  directory: string
  sessionID: string
  sessionRef: string
  workspaceId?: string
}): RailSessionStatusTarget {
  return {
    key: input.key,
    directory: input.directory,
    sessionID: input.sessionID,
    ...(input.sessionRef.startsWith("workspace:") && input.workspaceId
      ? { workspaceId: input.workspaceId }
      : {}),
  }
}

export function groupRailSessionStatusTargets(
  targets: readonly RailSessionStatusTarget[],
): RailSessionStatusTargetGroup[] {
  const groups = new Map<string, RailSessionStatusTargetGroup>()
  for (const target of targets) {
    const key = JSON.stringify([target.workspaceId ?? null, target.directory])
    const group = groups.get(key) ?? {
      directory: target.directory,
      ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
      targets: [],
    }
    group.targets.push(target)
    groups.set(key, group)
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      targets: [...group.targets].sort((a, b) => a.sessionID.localeCompare(b.sessionID)),
    }))
    .sort((a, b) =>
      (a.workspaceId ?? "").localeCompare(b.workspaceId ?? "") ||
      a.directory.localeCompare(b.directory),
    )
}

export function railSessionStatusBatchKey(group: RailSessionStatusTargetGroup) {
  return [group.workspaceId ?? "", group.directory, ...group.targets.map((target) => target.sessionID)].join("\0")
}

/**
 * The rail's status-target chain, derived once from the visible rows and the
 * focused pane.
 *
 * Kept together because the four values are one derivation, not four: the
 * focused row decides batch priority, priority decides which rows survive the
 * bound, the surviving rows decide the groups, and the groups decide the
 * signature the batch effect keys on. Splitting them across the component let
 * the focused-row lookup drift out of step with the bound it feeds.
 */
export function railSessionStatusTargetChain(input: {
  targets: () => RailSessionStatusTarget[]
  focusedSessionRef: () => SessionRef | undefined
  activeSessionID: () => string | undefined
  activeDirectory: () => string | undefined
}) {
  const focused = () => {
    const ref = input.focusedSessionRef()
    return activeRailSessionStatusTarget({
      targets: input.targets(),
      sessionID: input.activeSessionID(),
      directory: input.activeDirectory(),
      host: ref?.host,
      workspaceId: ref ? workspaceKey(ref) : undefined,
    })
  }
  const bounded = () => boundRailSessionStatusTargets(input.targets(), undefined, focused()?.key)
  const groups = () => groupRailSessionStatusTargets(bounded())
  return {
    focused,
    bounded,
    groups,
    signature: () => groups().map((group) => railSessionStatusBatchKey(group)).join("\n"),
  }
}
