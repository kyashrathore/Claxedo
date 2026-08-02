import { expect } from "vitest"

/** Assert value is defined and return it narrowed. Use in tests after async lookups. */
export function defined<T>(value: T | undefined | null, label?: string): T {
  expect(value, label ?? "expected defined value").toBeDefined()
  return value as T
}
