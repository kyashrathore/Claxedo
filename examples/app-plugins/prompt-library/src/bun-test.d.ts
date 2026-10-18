// The plugin check typechecks every .ts file with no ambient types, so the test runner's module is declared here.
declare module "bun:test" {
  interface Matchers {
    readonly not: Matchers
    toBe(expected: unknown): void
    toEqual(expected: unknown): void
    toContain(expected: unknown): void
    toBeNull(): void
    toBeUndefined(): void
    toBeTruthy(): void
    toBeGreaterThan(expected: number): void
    toBeLessThan(expected: number): void
    toHaveLength(expected: number): void
    toMatch(expected: string | RegExp): void
    toThrow(expected?: string | RegExp): void
  }
  export function expect(actual: unknown): Matchers
  export function test(name: string, body: () => void | Promise<void>): void
  export function describe(name: string, body: () => void): void
}
