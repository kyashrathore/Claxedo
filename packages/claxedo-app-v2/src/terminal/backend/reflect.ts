export function objectProperty(value: unknown, property: PropertyKey): unknown {
  if (!value || typeof value !== "object") return undefined
  return Reflect.get(value, property)
}
