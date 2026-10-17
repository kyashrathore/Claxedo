import { unwrap } from "solid-js/store"
import type { SurfaceActionDefinition, SurfaceActionEvent } from "@claxedo/plugin-api/surface"
import { isBinding, resolvePath } from "./data-path"
import type { DataPath, JsonValue, SurfaceData } from "./model"

export type ActionSource = {
  readonly surfaceId: string
  readonly sourceComponentId: string
  readonly scope: DataPath
}

export function resolveActionContext(
  context: SurfaceActionDefinition["event"]["context"],
  scope: DataPath,
  data: SurfaceData,
): Record<string, JsonValue> {
  const resolved: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(context ?? {})) {
    resolved[key] = isBinding(value) ? (data.snapshot(resolvePath(value.path, scope)) ?? null) : (structuredClone(unwrap(value)) as JsonValue)
  }
  return resolved
}

export function surfaceActionEvent(action: SurfaceActionDefinition, source: ActionSource, data: SurfaceData, now: Date): SurfaceActionEvent {
  return {
    name: action.event.name,
    surfaceId: source.surfaceId,
    sourceComponentId: source.sourceComponentId,
    timestamp: now.toISOString(),
    context: resolveActionContext(action.event.context, source.scope, data),
  }
}
