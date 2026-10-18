// The plugin check typechecks every .ts file in the package with no ambient types, so the test runner's module needs this declaration.
declare module "bun:test" {
  interface Matchers {
    readonly not: Matchers
    toBe(expected: unknown): void
    toEqual(expected: unknown): void
    toContain(expected: unknown): void
    toHaveLength(length: number): void
    toBeGreaterThan(expected: number): void
    toBeLessThanOrEqual(expected: number): void
    toBeUndefined(): void
    toMatch(pattern: RegExp | string): void
  }
  export function describe(name: string, body: () => void): void
  export function test(name: string, body: () => void | Promise<void>): void
  export function expect(actual: unknown): Matchers
}
