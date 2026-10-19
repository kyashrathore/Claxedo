import { batch } from "solid-js"
import type { core } from "zod"
import { surfaceMessageSchema, surfaceMessageSurfaceId, type SurfaceMessage } from "@claxedo/plugin-api/surface"
import { machine, type Machine } from "@/lib/machine"
import { createComponentRegistry } from "./component-registry"
import { createSurfaceData } from "./data-model"
import { parsePointer, ROOT_PATH } from "./data-path"
import {
  surfaceLifecycle,
  SurfaceMessageError,
  surfaceState,
  type Surface,
  type SurfaceLifecycle,
  type DataPath,
  type SurfaceLifecycleEvent,
  type SurfacePatchWatcher,
  type SurfaceState,
} from "./model"

type IssueAt = { readonly path: readonly PropertyKey[]; readonly message: string }

function deepestIssue(issue: core.$ZodIssue): IssueAt {
  let deepest: IssueAt = { path: issue.path, message: issue.message }
  if (issue.code !== "invalid_union") return deepest
  for (const inner of issue.errors.flat()) {
    const found = deepestIssue(inner)
    if (issue.path.length + found.path.length > deepest.path.length) deepest = { path: [...issue.path, ...found.path], message: found.message }
  }
  return deepest
}

function parsedMessage(message: unknown): SurfaceMessage {
  const parsed = surfaceMessageSchema.safeParse(message)
  if (parsed.success) return parsed.data
  const issue = deepestIssue(parsed.error.issues[0])
  throw new SurfaceMessageError(`a malformed surface message at /${issue.path.map(String).join("/")}: ${issue.message}`)
}

function requireLive(lifecycle: Machine<SurfaceLifecycle, SurfaceLifecycleEvent>, surfaceId: string) {
  if (lifecycle.state().kind !== "live") throw new SurfaceMessageError(`the surface ${surfaceId} has not been created`)
}

type Patched = (path: DataPath) => void

function applyTo(state: SurfaceState, lifecycle: Machine<SurfaceLifecycle, SurfaceLifecycleEvent>, surfaceId: string, message: SurfaceMessage, patched: Patched) {
  if ("createSurface" in message) {
    if (lifecycle.state().kind === "live") throw new SurfaceMessageError(`the surface ${surfaceId} already exists`)
    return lifecycle.send({ type: "created" })
  }
  if ("deleteSurface" in message) {
    requireLive(lifecycle, surfaceId)
    state.components.clear()
    state.data.clear()
    patched(ROOT_PATH)
    return lifecycle.send({ type: "deleted" })
  }
  requireLive(lifecycle, surfaceId)
  if ("updateComponents" in message) return state.components.upsert(message.updateComponents.components)
  const path = parsePointer(message.updateDataModel.path ?? "/")
  state.data.write(path, message.updateDataModel.value)
  patched(path)
}

export function createSurface(surfaceId: string): Surface {
  const lifecycle = machine<SurfaceLifecycle, SurfaceLifecycleEvent>({ kind: "waiting" }, surfaceLifecycle)
  const watchers = new Set<SurfacePatchWatcher>()
  const patched: Patched = (path) => {
    for (const watcher of watchers) watcher(path)
  }
  const watchPatches = (watcher: SurfacePatchWatcher) => {
    watchers.add(watcher)
    return () => void watchers.delete(watcher)
  }
  const state: SurfaceState = { lifecycle: lifecycle.state, components: createComponentRegistry(), data: createSurfaceData(), watchPatches }
  return {
    surfaceId,
    apply: (message) => {
      const parsed = parsedMessage(message)
      const target = surfaceMessageSurfaceId(parsed)
      if (target !== surfaceId) throw new SurfaceMessageError(`a message for the surface ${target} reached the surface ${surfaceId}`)
      batch(() => applyTo(state, lifecycle, surfaceId, parsed, patched))
    },
    [surfaceState]: state,
  }
}
