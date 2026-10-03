import type { SessionRow, SessionSelections } from "@/server"

function laterHumanTurn(current: SessionRow, incoming: SessionRow): number | undefined {
  if (current.lastHumanTurnAt === undefined) return incoming.lastHumanTurnAt
  if (incoming.lastHumanTurnAt === undefined) return current.lastHumanTurnAt
  return Math.max(current.lastHumanTurnAt, incoming.lastHumanTurnAt)
}

function withSelections(row: SessionRow, from: SessionSelections): SessionRow {
  const { harness: _harness, model: _model, permissionMode: _permissionMode, permissionModeLabel: _permissionModeLabel, ...rest } = row
  return {
    ...rest,
    ...(from.harness ? { harness: from.harness } : {}),
    ...(from.model ? { model: from.model } : {}),
    ...(from.permissionMode ? { permissionMode: from.permissionMode } : {}),
    ...(from.permissionModeLabel ? { permissionModeLabel: from.permissionModeLabel } : {}),
  }
}

function activitySnapshot(current: SessionRow, incoming: SessionRow): Pick<SessionRow, "attention" | "lastTurn"> {
  if (!incoming.attention) return { attention: current.attention, lastTurn: current.attention ? current.lastTurn : incoming.lastTurn ?? current.lastTurn }
  if (current.attention && current.attention.sequence > incoming.attention.sequence) return { attention: current.attention, lastTurn: current.lastTurn }
  return { attention: incoming.attention, lastTurn: incoming.lastTurn }
}

export function newerRow(current: SessionRow, incoming: SessionRow): SessionRow | undefined {
  const activity = activitySnapshot(current, incoming)
  const reader = !incoming.reader || current.reader && (current.reader.generation > incoming.reader.generation || current.reader.generation === incoming.reader.generation && current.reader.revision > incoming.reader.revision) ? current.reader : incoming.reader
  if (incoming.updatedAt < current.updatedAt) return activity.attention === current.attention && activity.lastTurn === current.lastTurn && reader === current.reader ? undefined : { ...current, ...activity, reader }
  const merged = {
    ...incoming,
    ...activity,
    reader,
    ownership: incoming.ownership ?? current.ownership,
    projectName: Object.hasOwn(incoming, "projectName") ? incoming.projectName : current.projectName,
    placement: Object.hasOwn(incoming, "placement") ? incoming.placement : current.placement,
    executionAvailability: Object.hasOwn(incoming, "executionAvailability") ? incoming.executionAvailability : current.executionAvailability,
    createdAt: current.createdAt,
    lastHumanTurnAt: laterHumanTurn(current, incoming),
  }
  return withSelections(merged, incoming.harness || !current.harness ? incoming : current)
}
