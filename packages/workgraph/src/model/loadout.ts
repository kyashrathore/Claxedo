import type { WorkGraphRepo } from "./repo"
import type { LoadoutKind, LoadoutScopeType } from "./types"
import "./auto-policies"
import "./triage-modes"
import {
  defaultLoadoutPayload,
  resolveRegisteredLoadout,
  type LoadoutResolutionContext,
} from "./loadout-registry"

export type LoadoutSubject =
  | { type: "work_item"; id: string; role?: string; taskKind?: string }
  | { type: "intake_item"; id: string; sourceAdapter?: string }
  | { type: "system" }

export interface ResolvedLoadout {
  source: "slot" | "default"
  slotId: string | null
  scopeType: LoadoutScopeType
  scopeId: string | null
  kind: LoadoutKind
  name: string
  payload: Record<string, unknown>
}

export function resolveLoadout(subject: LoadoutSubject, kind: LoadoutKind, repo: WorkGraphRepo): ResolvedLoadout | null {
  const ctx = contextFor(subject, repo)
  const found = scopeChain(subject, repo)
    .flatMap((scope) => repo.listLoadoutSlotsByScope(scope.scopeType, scope.scopeId)
      .filter((slot) => slot.kind === kind)
      .map((slot) => ({ scope, slot })))
    .at(0)

  if (found) {
    const resolved = resolveRegisteredLoadout(kind, found.slot.payload, ctx)
    return {
      source: "slot",
      slotId: found.slot.id,
      scopeType: found.scope.scopeType,
      scopeId: found.scope.scopeId,
      kind,
      name: resolved.name,
      payload: resolved.payload,
    }
  }

  const resolved = resolveRegisteredLoadout(kind, defaultLoadoutPayload(kind), ctx)
  return {
    source: "default",
    slotId: null,
    scopeType: "system",
    scopeId: null,
    kind,
    name: resolved.name,
    payload: resolved.payload,
  }
}

function scopeChain(subject: LoadoutSubject, repo: WorkGraphRepo): Array<{ scopeType: LoadoutScopeType; scopeId: string | null }> {
  if (subject.type === "work_item") {
    const item = repo.getItem(subject.id)
    if (!item) return [{ scopeType: "system", scopeId: null }]
    const parent = item.parentId ? repo.getItem(item.parentId) : undefined
    return [
      { scopeType: "work_item", scopeId: item.id },
      ...(parent?.nodeType === "mission" ? [{ scopeType: "mission" as const, scopeId: parent.id }] : []),
      ...(item.repoRef ? [{ scopeType: "repo" as const, scopeId: item.repoRef }] : []),
      ...(subject.role ? [{ scopeType: "role" as const, scopeId: subject.role }] : []),
      ...(subject.taskKind ? [{ scopeType: "task_kind" as const, scopeId: subject.taskKind }] : []),
      { scopeType: "system", scopeId: null },
    ]
  }

  if (subject.type === "intake_item") {
    const intake = repo.getIntakeItem(subject.id)
    if (!intake) return [{ scopeType: "system", scopeId: null }]
    return [
      { scopeType: "intake_item", scopeId: intake.id },
      ...(subject.sourceAdapter ? [{ scopeType: "source_adapter" as const, scopeId: subject.sourceAdapter }] : []),
      ...(intake.repoRef ? [{ scopeType: "repo" as const, scopeId: intake.repoRef }] : []),
      { scopeType: "system", scopeId: null },
    ]
  }

  return [{ scopeType: "system", scopeId: null }]
}

function contextFor(subject: LoadoutSubject, repo: WorkGraphRepo): LoadoutResolutionContext {
  if (subject.type === "work_item") return { type: "work_item", item: repo.getItem(subject.id) }
  if (subject.type === "intake_item") return { type: "intake_item", intake: repo.getIntakeItem(subject.id) }
  return { type: "system" }
}
