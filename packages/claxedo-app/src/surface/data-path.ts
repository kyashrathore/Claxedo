import type { SurfaceDataBinding } from "@claxedo/plugin-api/surface"
import type { DataPath } from "./model"

export const ROOT_PATH: DataPath = []

function unescapeSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~")
}

export function parsePointer(pointer: string): DataPath {
  if (pointer === "" || pointer === "/") return ROOT_PATH
  return pointer.slice(1).split("/").map(unescapeSegment)
}

function parseRelative(path: string): DataPath {
  return path.split("/").filter((segment) => segment.length > 0).map(unescapeSegment)
}

export function resolvePath(path: string, scope: DataPath): DataPath {
  return path.startsWith("/") ? parsePointer(path) : [...scope, ...parseRelative(path)]
}

export function isBinding(value: unknown): value is SurfaceDataBinding {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { path?: unknown }).path === "string"
}

export function itemScope(listPath: DataPath, index: number): DataPath {
  return [...listPath, String(index)]
}
