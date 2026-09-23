/**
 * Minimal, safe property reflection off values of unknown shape.
 *
 * Both the clipboard handlers (reaching into the Electron `window.api` bridge)
 * and the resize handlers (probing xterm's private `_core._renderService`
 * internals) need to read a property from an object that TypeScript can't type,
 * without throwing on `null`/non-objects. This is the single shared helper for
 * that so the reflection pattern has one definition instead of one per module.
 */
export function objectProperty(value: unknown, property: PropertyKey): unknown {
  if (!value || typeof value !== "object") return undefined
  return Reflect.get(value, property)
}
