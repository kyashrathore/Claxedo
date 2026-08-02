import { parse } from "smol-toml"
import type { ACPTransportEnv } from "./transport"

export function codexAcpLaunch(args: string[], env: ACPTransportEnv) {
  const overrides: string[] = []
  const passthrough: string[] = []

  args.forEach((arg, index) => {
    if ((arg === "-c" || arg === "--config") && args[index + 1]) {
      if (index === 0 || (args[index - 1] !== "-c" && args[index - 1] !== "--config")) {
        overrides.push(args[index + 1]!)
      }
      return
    }
    if (index > 0 && (args[index - 1] === "-c" || args[index - 1] === "--config")) return
    if (arg.startsWith("--config=")) {
      overrides.push(arg.slice("--config=".length))
      return
    }
    passthrough.push(arg)
  })

  const config = overrides.reduce(
    (current, override) => mergeConfig(current, parseOverride(override)),
    initialConfig(env.CODEX_CONFIG),
  )
  return {
    args: passthrough,
    env: Object.keys(config).length > 0
      ? { ...env, CODEX_CONFIG: JSON.stringify(config) }
      : env,
  }
}

function initialConfig(value: string | undefined) {
  if (!value) return {}
  const parsed: unknown = JSON.parse(value)
  if (!isRecord(parsed)) throw new Error("CODEX_CONFIG must be a JSON object")
  return parsed
}

function parseOverride(override: string) {
  const separator = override.indexOf("=")
  if (separator <= 0) throw new Error(`Invalid Codex config override: ${override}`)
  try {
    return parse(override)
  } catch {
    return parse(`${override.slice(0, separator)} = ${JSON.stringify(override.slice(separator + 1).trim())}`)
  }
}

function mergeConfig(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    [...new Set([...Object.keys(base), ...Object.keys(override)])].map((key) => {
      const previous = base[key]
      const next = override[key]
      if (isRecord(previous) && isRecord(next)) return [key, mergeConfig(previous, next)]
      return [key, next === undefined ? previous : next]
    }),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
