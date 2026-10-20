import { createSignal, untrack, type Accessor } from "solid-js"
import type { SurfaceDataBinding } from "@claxedo/plugin-api/surface"
import { isBinding, resolvePath } from "./data-path"
import type { DataPath, JsonValue, SurfaceData } from "./model"

export type Bindable<Value> = Value | SurfaceDataBinding

export type BoundValue<Value> = {
  readonly value: Accessor<Value>
  readonly set: (value: Value) => void
}

export function readDynamic(source: unknown, scope: DataPath, data: SurfaceData): unknown {
  return isBinding(source) ? data.read(resolvePath(source.path, scope)) : source
}

export function boundText(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value === undefined || value === null) return ""
  return JSON.stringify(value)
}

export function boundNumber(value: unknown): number {
  if (typeof value === "number") return value
  const parsed = typeof value === "string" ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

export function boundBoolean(value: unknown): boolean {
  return value === true
}

export function boundTextList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

export function createBoundValue<Value extends JsonValue>(
  source: Accessor<Bindable<Value> | undefined>,
  scope: Accessor<DataPath>,
  data: SurfaceData,
  coerce: (value: unknown) => Value,
): BoundValue<Value> {
  const initial = untrack(source)
  const [local, setLocal] = createSignal(coerce(isBinding(initial) ? undefined : initial))
  return {
    value: () => {
      const current = source()
      return isBinding(current) ? coerce(data.read(resolvePath(current.path, scope()))) : local()
    },
    set: (value) => {
      const current = untrack(source)
      if (isBinding(current)) data.write(resolvePath(current.path, untrack(scope)), value)
      else setLocal(() => value)
    },
  }
}
