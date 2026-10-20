import { batch, untrack } from "solid-js"
import { isRecord } from "@claxedo/helpers/guards"
import { createStore, produce, reconcile, unwrap } from "solid-js/store"
import { SurfaceMessageError, type DataPath, type JsonValue, type SurfaceData } from "./model"

type Container = Record<string, unknown> | unknown[]

type PathSetter = (...pathAndValue: unknown[]) => void

function isContainer(value: unknown): value is Container {
  return typeof value === "object" && value !== null
}

function childAt(node: JsonValue | undefined, key: string): JsonValue | undefined {
  if (Array.isArray(node)) return node[Number(key)]
  return isRecord(node) ? node[key] : undefined
}

function readDataAt(model: Record<string, JsonValue>, path: DataPath): JsonValue | undefined {
  let node: JsonValue | undefined = model
  for (const key of path) node = childAt(node, key)
  return node
}

function nested(path: DataPath, value: JsonValue): JsonValue {
  return path.reduceRight((inner: JsonValue, key) => ({ [key]: inner }), value)
}

function sameShape(previous: unknown, value: JsonValue): boolean {
  return isContainer(previous) && isContainer(value) && Array.isArray(previous) === Array.isArray(value)
}

function arrayIndex(list: unknown[], key: string): number | undefined {
  const index = Number(key)
  return Number.isInteger(index) && index >= 0 && index < list.length ? index : undefined
}

type ModelStore = {
  readonly setAt: PathSetter
  readonly peek: (path: DataPath) => JsonValue | undefined
}

function replaceRoot(store: ModelStore, value: JsonValue | undefined) {
  if (value === undefined) return store.setAt(reconcile({}))
  if (!isRecord(value)) throw new SurfaceMessageError("the data model at / must be an object")
  store.setAt(reconcile(value, { merge: true }))
}

function removeDataAt(store: ModelStore, path: DataPath) {
  const parentPath = path.slice(0, -1)
  const key = path[path.length - 1]
  const parent = store.peek(parentPath)
  if (Array.isArray(parent)) {
    const index = arrayIndex(parent, key)
    if (index !== undefined) store.setAt(...parentPath, produce((list: unknown[]) => void list.splice(index, 1)))
    return
  }
  if (isContainer(parent) && key in parent) store.setAt(...path, undefined)
}

function replaceDataLeaf(store: ModelStore, path: DataPath, value: JsonValue) {
  const previous = store.peek(path)
  if (sameShape(previous, value)) return store.setAt(...path, reconcile(value, { merge: true }))
  batch(() => {
    if (isContainer(previous)) store.setAt(...path, undefined)
    store.setAt(...path, value)
  })
}

function upsertDataAt(store: ModelStore, path: DataPath, value: JsonValue) {
  for (let depth = 1; depth < path.length; depth += 1) {
    if (!isContainer(store.peek(path.slice(0, depth)))) return store.setAt(...path.slice(0, depth), nested(path.slice(depth), value))
  }
  replaceDataLeaf(store, path, value)
}

export function createSurfaceData(): SurfaceData {
  const [model, setModel] = createStore<Record<string, JsonValue>>({})
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const store: ModelStore = { setAt: setModel as unknown as PathSetter, peek: (path) => untrack(() => readDataAt(model, path)) }
  return {
    read: (path) => readDataAt(model, path),
    write: (path, value) => {
      if (path.length === 0) return replaceRoot(store, value)
      if (value === undefined) return removeDataAt(store, path)
      upsertDataAt(store, path, value)
    },
    snapshot: (path) => {
      const value = store.peek(path)
      return value === undefined ? undefined : structuredClone(unwrap(value))
    },
    clear: () => setModel(reconcile({})),
  }
}
