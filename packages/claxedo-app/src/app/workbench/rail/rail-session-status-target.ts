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
