/**
 * Claxedo Extensions
 *
 * Single-tenant extension accessor. Replaces the @opencode-ai/app-shared
 * registry — same getExtensions() shape, no plugin map / merge / globalThis
 * dance. Call setExtensions() once during boot (initClaxedo) and read with
 * getExtensions() everywhere else.
 *
 * State is parked on globalThis to survive HMR; resetting on every module
 * reload would otherwise wipe claxedo's config until the next page refresh.
 */

import type { Extensions } from "./types"

export type {
  AppExtensions,
  ServerExtensions,
  Extensions,
} from "./types"

// Note: factory functions (appExtensions, serverExtensions, etc.) are NOT
// re-exported here. Consumers that only need getExtensions() shouldn't pull
// in the entire factory chain (which transitively loads UI/auth deps).
// Importers of factories should reach for ./app, ./server, etc. directly —
// only `index.tsx` does that today.

const EMPTY: Extensions = { app: {}, server: {} }

const globalKey = "__CLAXEDO_EXTENSIONS__"
const state = extensionState()

function extensionState() {
  const existing = Reflect.get(globalThis, globalKey)
  if (isExtensionState(existing)) return existing
  const next = { ext: EMPTY }
  Reflect.set(globalThis, globalKey, next)
  return next
}

function isExtensionState(input: unknown): input is { ext: Extensions } {
  return !!input && typeof input === "object" && "ext" in input
}

export function setExtensions(ext: Extensions): void {
  state.ext = ext
}

export function getExtensions(): Extensions {
  return state.ext
}

export function resetExtensions(): void {
  state.ext = EMPTY
}
