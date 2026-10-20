import type { SurfaceChannel, SurfaceComponent, SurfaceMessage } from "@claxedo/plugin-api"
import { escapePointerKey, type Json, type JsonObject } from "./json"

export const SURFACE_CATALOG = "https://claxedo.dev/a2ui/v0.9/catalog.json"
const VERSION = "v0.9"

export type SurfaceFrame = {
  readonly components: readonly SurfaceComponent[]
  readonly data: JsonObject
}

export type SurfaceSync = {
  readonly draw: (frame: SurfaceFrame) => void
  readonly observe: (path: string, value: Json) => void
  readonly force: (path: string) => void
}

type Patch = { readonly path: string; readonly value: Json | undefined }

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function orderFreeJson(value: Json | undefined): string {
  if (Array.isArray(value)) return `[${value.map(orderFreeJson).join(",")}]`
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${orderFreeJson(value[key])}`).join(",")}}`
  return JSON.stringify(value) ?? "undefined"
}

function equalJsonValues(left: Json | undefined, right: Json | undefined): boolean {
  return orderFreeJson(left) === orderFreeJson(right)
}

function dataPatches(previous: Json | undefined, next: Json | undefined, path: string, forced: ReadonlySet<string>): Patch[] {
  if (forced.has(path) || !isObject(previous) || !isObject(next)) {
    return forced.has(path) || !equalJsonValues(previous, next) ? [{ path, value: next }] : []
  }
  const removed = Object.keys(previous).filter((key) => !(key in next))
  return [
    ...Object.keys(next).flatMap((key) => dataPatches(previous[key], next[key], `${path}/${escapePointerKey(key)}`, forced)),
    ...removed.map((key) => ({ path: `${path}/${escapePointerKey(key)}`, value: undefined })),
  ]
}

function writeAt(model: JsonObject, path: string, value: Json): JsonObject {
  const keys = path.split("/").slice(1).map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~"))
  const root: JsonObject = structuredClone(model)
  let cursor: Json = root
  for (const [index, key] of keys.entries()) {
    const last = index === keys.length - 1
    if (Array.isArray(cursor)) {
      if (last) cursor[Number(key)] = value
      else cursor = cursor[Number(key)] ?? null
    } else if (isObject(cursor)) {
      if (last) cursor[key] = value
      else cursor = cursor[key] ??= {}
    }
  }
  return root
}

export function createSurfaceSync(channel: SurfaceChannel): SurfaceSync {
  const { surfaceId } = channel
  let sentComponents: Map<string, string> | undefined
  let sentData: JsonObject = {}
  const forced = new Set<string>()
  const dataMessage = (patch: Patch): SurfaceMessage => ({
    version: VERSION,
    updateDataModel: patch.value === undefined ? { surfaceId, path: patch.path } : { surfaceId, path: patch.path, value: patch.value },
  })
  const firstDraw = (frame: SurfaceFrame) => {
    sentComponents = new Map(frame.components.map((component) => [component.id, JSON.stringify(component)]))
    sentData = structuredClone(frame.data)
    channel.send(
      { version: VERSION, createSurface: { surfaceId, catalogId: SURFACE_CATALOG } },
      { version: VERSION, updateComponents: { surfaceId, components: [...frame.components] } },
      { version: VERSION, updateDataModel: { surfaceId, path: "/", value: sentData } },
    )
  }
  const nextDraw = (sent: Map<string, string>, frame: SurfaceFrame) => {
    const changed = frame.components.filter((component) => sent.get(component.id) !== JSON.stringify(component))
    for (const component of changed) sent.set(component.id, JSON.stringify(component))
    const patches = dataPatches(sentData, frame.data, "", forced)
    forced.clear()
    sentData = structuredClone(frame.data)
    const messages: SurfaceMessage[] = [
      ...(changed.length > 0 ? [{ version: VERSION, updateComponents: { surfaceId, components: changed } } as const] : []),
      ...patches.map(dataMessage),
    ]
    if (messages.length > 0) channel.send(...messages)
  }
  return {
    draw: (frame) => (sentComponents ? nextDraw(sentComponents, frame) : firstDraw(frame)),
    observe: (path, value) => {
      sentData = writeAt(sentData, path, value)
    },
    force: (path) => void forced.add(path),
  }
}
