/**
 * Shared test helper for claxedo layout tests.
 *
 * All test files that transitively import claxedo-layout.tsx must call
 * ensureLayoutMocked() in beforeAll BEFORE any import of claxedo-layout.
 *
 * Mocks are always re-registered because bun may restore them between test
 * files while the module cache persists. The init function is only captured
 * on the first call (when claxedo-layout.tsx is first evaluated).
 */
// @ts-expect-error bun:test types only available at test runtime
import { mock } from "bun:test"

let _initLayout: (() => any) | undefined
let _persistTarget: unknown

export async function ensureLayoutMocked() {
  // Always re-register mocks — bun restores them between test files
  // but the module cache (and _initLayout) persists across files.
  mock.module("@opencode-ai/ui/context", () => ({
    createSimpleContext: (config: any) => {
      if (config.name === "ClaxedoLayout") _initLayout = config.init
      return { use: () => {}, provider: () => {} }
    },
  }))

  mock.module("@opencode-ai/claxedo-app", () => ({
    Persist: { global: () => ({}) },
    persisted: (target: unknown, storeResult: any) => {
      _persistTarget = target
      return [...storeResult, undefined, () => true]
    },
  }))

  // Use a cache-busted specifier so we can capture init even when another
  // test file mocked "./claxedo-layout" earlier in the same Bun process.
  const key = `${Date.now()}-${Math.random()}`
  await import(`./claxedo-layout.tsx?test=${key}`)
}

export function getInitLayout(): () => any {
  if (!_initLayout) throw new Error("initLayout not captured — call ensureLayoutMocked() in beforeAll first")
  return _initLayout
}

export function getPersistTarget() {
  return _persistTarget
}
