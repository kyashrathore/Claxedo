type DebugConfig = string | number | boolean | Record<string, string | number | boolean | undefined>

type DebugOptions = {
  legacyKey?: string
  defaultLevel?: number
}

/**
 * Unified frontend debug toggles.
 *
 * Supported controls:
 * - window.__OPENCODE_DEBUG__ = 1
 * - window.__OPENCODE_DEBUG__ = { "terminal.wrapper": 2, "terminal.backend": 1, "*": 0 }
 * - localStorage.setItem("opencode.debug", "terminal.wrapper=2,terminal.backend=1")
 *
 * Legacy keys can be bridged per logger via DebugOptions.legacyKey.
 */

declare global {
  interface Window {
    __OPENCODE_DEBUG__?: DebugConfig
  }
}

const normalize = (value: unknown) => {
  if (typeof value === "boolean") return value ? 1 : 0
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value !== "string") return undefined
  const raw = value.trim()
  if (!raw) return undefined
  if (raw === "true" || raw === "on") return 1
  if (raw === "false" || raw === "off") return 0
  const n = Number(raw)
  if (Number.isFinite(n)) return n
  return undefined
}

const parseMap = (value: string) => {
  const out = new Map<string, number>()
  const chunks = value
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter(Boolean)
  for (const chunk of chunks) {
    const eq = chunk.indexOf("=")
    const sep = eq >= 0 ? eq : chunk.indexOf(":")
    if (sep <= 0) {
      const level = normalize(chunk)
      if (level !== undefined) out.set("*", level)
      continue
    }
    const key = chunk.slice(0, sep).trim()
    const level = normalize(chunk.slice(sep + 1))
    if (!key || level === undefined) continue
    out.set(key, level)
  }
  return out
}

const bestMatch = (scope: string, map: Map<string, number>) => {
  if (map.has(scope)) return map.get(scope)
  const parts = scope.split(".")
  while (parts.length > 1) {
    parts.pop()
    const key = parts.join(".")
    if (map.has(key)) return map.get(key)
  }
  return map.get("*")
}

const fromObject = (scope: string, obj: Record<string, unknown>) => {
  const direct = bestMatch(
    scope,
    new Map(Object.entries(obj).flatMap(([key, value]) => {
      const level = normalize(value)
      if (level === undefined) return []
      return [[key, level] as const]
    })),
  )
  return direct
}

const readStorage = (key: string) => {
  if (typeof localStorage === "undefined") return
  try {
    return localStorage.getItem(key) ?? undefined
  } catch {
    return
  }
}

const windowLevel = (scope: string) => {
  if (typeof window === "undefined") return
  const config = window.__OPENCODE_DEBUG__
  if (config === undefined) return
  if (typeof config === "object" && config !== null && !Array.isArray(config)) {
    return fromObject(scope, config)
  }
  if (typeof config === "string" && /[=:;,]/.test(config)) {
    return bestMatch(scope, parseMap(config))
  }
  return normalize(config)
}

const storageLevel = (scope: string) => {
  const value = readStorage("opencode.debug")
  if (!value) return
  if (/[=:;,]/.test(value)) return bestMatch(scope, parseMap(value))
  return normalize(value)
}

const clamp = (value: number) => {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(9, Math.floor(value)))
}

export function getDebugLevel(scope: string, options?: DebugOptions) {
  const fromWindow = windowLevel(scope)
  if (fromWindow !== undefined) return clamp(fromWindow)
  const fromStorage = storageLevel(scope)
  if (fromStorage !== undefined) return clamp(fromStorage)
  if (options?.legacyKey) {
    const fromLegacy = normalize(readStorage(options.legacyKey))
    if (fromLegacy !== undefined) return clamp(fromLegacy)
  }
  return clamp(options?.defaultLevel ?? 0)
}

export function isDebugEnabled(scope: string, level = 1, options?: DebugOptions) {
  return getDebugLevel(scope, options) >= level
}

export function createDebugLogger(scope: string, label: string, options?: DebugOptions) {
  const enabled = (level = 1) => isDebugEnabled(scope, level, options)
  const log = (...args: unknown[]) => {
    if (!enabled(1)) return
    // eslint-disable-next-line no-console
    console.log(`[${label}]`, ...args)
  }
  const verbose = (...args: unknown[]) => {
    if (!enabled(2)) return
    // eslint-disable-next-line no-console
    console.log(`[${label}:verbose]`, ...args)
  }
  return {
    level: () => getDebugLevel(scope, options),
    enabled,
    log,
    verbose,
  }
}
