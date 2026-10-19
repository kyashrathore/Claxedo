import type { SurfaceDataBinding } from "@claxedo/plugin-api/surface"
import { parsePointer, unescapePointerSegment } from "@/lib/json-pointer"
import type { DataPath } from "./model"

export const ROOT_PATH: DataPath = []

function parseRelative(path: string): DataPath {
  return path.split("/").filter((segment) => segment.length > 0).map(unescapePointerSegment)
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

function isPathWithin(path: DataPath, prefix: DataPath): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment)
}

export function pathsOverlap(first: DataPath, second: DataPath): boolean {
  return isPathWithin(first, second) || isPathWithin(second, first)
}
