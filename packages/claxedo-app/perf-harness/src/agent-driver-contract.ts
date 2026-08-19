import path from "node:path"
import { PRIMARY_AGENT_APP_METRICS } from "./agent-metrics"

export const AGENT_APP_DRIVER_PROTOCOL_VERSION = 1 as const

export const AGENT_APP_PROFILES = [
  "workspace-core-v1",
  "conversation-rich-v1",
  "terminal-core-v1",
  "resource-core-v1",
] as const
export type AgentAppProfile = typeof AGENT_APP_PROFILES[number]

export const AGENT_APP_SCENARIOS = [
  "app-cold-ready-v1",
  "work-item-cold-open-v1",
  "work-item-warm-switch-v1",
  "history-navigation-v1",
  "controlled-stream-v1",
  "terminal-input-v1",
  "terminal-output-v1",
  "resource-sweep-v1",
  "resource-quiescence-v1",
] as const
export type AgentAppScenario = typeof AGENT_APP_SCENARIOS[number]

export type AgentDriverRequest =
  | DriverRequestBase & { method: "hello"; params: { frameworkVersion: 1 } }
  | DriverRequestBase & {
      method: "prepare"
      params: {
        corpusPath: string
        corpusDigestSha256: string
        runDirectory: string
        profiles: AgentAppProfile[]
      }
    }
  | DriverRequestBase & { method: "launch"; params: { isolatedProfilePath: string } }
  | DriverRequestBase & {
      method: "run-scenario"
      params: { attemptId: string; profile: AgentAppProfile; scenario: AgentAppScenario; seed: string }
    }
  | DriverRequestBase & { method: "inspect"; params: Record<string, never> }
  | DriverRequestBase & { method: "shutdown"; params: { reason: string } }

type DriverRequestBase = {
  protocolVersion: 1
  kind: "request"
  correlationId: string
}

export function driverHello(input: {
  applicationVersion: string
  driverVersion: string
  driverDigestSha256: string
  applicationSourceCommit?: string
  driverSourceCommit?: string
}) {
  return {
    protocolVersion: AGENT_APP_DRIVER_PROTOCOL_VERSION,
    application: {
      name: "Claxedo",
      version: input.applicationVersion,
      build: "release" as const,
      ...(input.applicationSourceCommit ? { sourceCommit: input.applicationSourceCommit } : {}),
    },
    driver: {
      name: "claxedo-agent-app-driver",
      version: input.driverVersion,
      digestSha256: sha256(input.driverDigestSha256, "driverDigestSha256"),
      ...(input.driverSourceCommit ? { sourceCommit: input.driverSourceCommit } : {}),
    },
    capabilities: {
      profiles: [...AGENT_APP_PROFILES],
      scenarios: [...AGENT_APP_SCENARIOS],
      metrics: [...PRIMARY_AGENT_APP_METRICS],
      readinessDetection: "Canonical latest-turn message IDs plus complete-first-fold and trusted-input checks",
      paintDetection: "Two identical renderer animation-frame snapshots for session paint; terminal parsed-model receipt plus two animation frames for terminal metrics",
      requiredPreparation: [
        "release Claxedo executable",
        "isolated application profile",
        "v1 agent-app corpus materialized through Claxedo's production OpenCode storage path",
      ],
    },
  }
}

export function decodeDriverRequest(line: string): AgentDriverRequest {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error("driver request must be valid JSON")
  }
  const input = record(value, "driver request")
  exactKeys(input, ["protocolVersion", "kind", "correlationId", "method", "params"])
  if (input.protocolVersion !== 1) throw new Error(`unsupported protocolVersion: ${String(input.protocolVersion)}`)
  if (input.kind !== "request") throw new Error("driver request kind must be request")
  const correlationId = identifier(input.correlationId, "correlationId")
  const method = identifier(input.method, "method")
  const params = record(input.params, "params")
  const base = { protocolVersion: 1 as const, kind: "request" as const, correlationId }

  if (method === "hello") {
    exactKeys(params, ["frameworkVersion"])
    if (params.frameworkVersion !== 1) throw new Error("unsupported frameworkVersion")
    return { ...base, method, params: { frameworkVersion: 1 } }
  }
  if (method === "prepare") {
    exactKeys(params, ["corpusPath", "corpusDigestSha256", "runDirectory", "profiles"])
    const requestedProfiles = stringArray(params.profiles, "profiles")
    if (requestedProfiles.length === 0) throw new Error("profiles must be non-empty")
    if (new Set(requestedProfiles).size !== requestedProfiles.length) throw new Error("profiles must not contain duplicates")
    const profiles: AgentAppProfile[] = []
    for (const profile of requestedProfiles) {
      if (!includes(AGENT_APP_PROFILES, profile)) throw new Error(`unsupported profile: ${profile}`)
      profiles.push(profile)
    }
    return {
      ...base,
      method,
      params: {
        corpusPath: absolutePath(params.corpusPath, "corpusPath"),
        corpusDigestSha256: sha256(params.corpusDigestSha256, "corpusDigestSha256"),
        runDirectory: absolutePath(params.runDirectory, "runDirectory"),
        profiles,
      },
    }
  }
  if (method === "launch") {
    exactKeys(params, ["isolatedProfilePath"])
    return { ...base, method, params: { isolatedProfilePath: absolutePath(params.isolatedProfilePath, "isolatedProfilePath") } }
  }
  if (method === "run-scenario") {
    exactKeys(params, ["attemptId", "profile", "scenario", "seed"])
    const profile = identifier(params.profile, "profile")
    const scenario = identifier(params.scenario, "scenario")
    if (!includes(AGENT_APP_PROFILES, profile)) throw new Error(`unsupported profile: ${profile}`)
    if (!includes(AGENT_APP_SCENARIOS, scenario)) throw new Error(`unsupported scenario: ${scenario}`)
    return {
      ...base,
      method,
      params: {
        attemptId: identifier(params.attemptId, "attemptId"),
        profile,
        scenario,
        seed: identifier(params.seed, "seed"),
      },
    }
  }
  if (method === "inspect") {
    exactKeys(params, [])
    return { ...base, method, params: {} }
  }
  if (method === "shutdown") {
    exactKeys(params, ["reason"])
    return { ...base, method, params: { reason: boundedText(params.reason, "reason") } }
  }
  throw new Error(`unsupported method: ${method}`)
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(input: Record<string, unknown>, allowed: string[]) {
  const unknown = Object.keys(input).find((key) => !allowed.includes(key))
  if (unknown) throw new Error(`unknown field: ${unknown}`)
  const missing = allowed.find((key) => !(key in input))
  if (missing) throw new Error(`missing field: ${missing}`)
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > 256) {
    throw new Error(`${name} must be a bounded identifier`)
  }
  return value
}

function boundedText(value: unknown, name: string) {
  if (typeof value !== "string" || value.length > 4_096) throw new Error(`${name} must be bounded text`)
  return value
}

function absolutePath(value: unknown, name: string) {
  const candidate = identifier(value, name)
  if (!path.isAbsolute(candidate)) throw new Error(`${name} must be absolute`)
  return path.normalize(candidate)
}

function sha256(value: unknown, name: string) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} must be lowercase sha256`)
  return value
}

function stringArray(value: unknown, name: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${name} must be a string array`)
  return value as string[]
}

function includes<const T extends readonly string[]>(values: T, value: string): value is T[number] {
  return values.includes(value as T[number])
}
