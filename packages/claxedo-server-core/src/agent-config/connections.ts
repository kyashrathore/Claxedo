import {
  AGENT_HARNESS_IDS,
  ConnectionProviderError,
  createAcpConnectionProvider,
  createConnectionProviderRegistry,
  type HarnessConnectionDescriptor,
  type HarnessConnectionRef,
} from "@claxedo/agent-sdk-runtime"
import {
  type RuntimeHarnessSelection,
  type RuntimeNativeHarnessId,
} from "@claxedo/workspace-runtime/config"
import { jsonRecord } from "@claxedo/server-core/platform/runtime/lib/json"

export type {
  HarnessConnectionDescriptor,
  HarnessConnectionRef,
} from "@claxedo/agent-sdk-runtime"


export type HarnessConnectionProblem = {
  connectionId: string
  problem: string
}

type NativeHarnessSelection = Extract<RuntimeHarnessSelection, { kind: "native" }>
type ConnectionProviderRegistry = ReturnType<typeof createConnectionProviderRegistry>

const DESCRIPTOR_KEYS = new Set([
  "connectionId",
  "providerKey",
  "configRevision",
  "enabled",
  "config",
  "secretRefs",
])

/**
 * Server-core owns persistence and atomic-map validation, while the installed
 * agent-sdk providers own descriptor config validation and public projection.
 */
export function createHarnessConnectionSchema(
  registry: ConnectionProviderRegistry = createConnectionProviderRegistry([createAcpConnectionProvider()]),
) {
  function validate(input: unknown): {
    accepted: Record<string, HarnessConnectionDescriptor>
    problems: HarnessConnectionProblem[]
  } {
    const accepted: Record<string, HarnessConnectionDescriptor> = {}
    const problems: HarnessConnectionProblem[] = []
    const rows = objectRecord(input)
    if (!rows) {
      return {
        accepted,
        problems: [{ connectionId: "", problem: "connections must be an object map" }],
      }
    }

    for (const [mapKey, value] of Object.entries(rows)) {
      const row = objectRecord(value)
      if (!row) {
        problems.push({ connectionId: mapKey, problem: "connection descriptor must be an object" })
        continue
      }
      const candidate = descriptorCandidate(mapKey, row)
      if ("problem" in candidate) {
        problems.push({ connectionId: mapKey, problem: candidate.problem })
        continue
      }
      try {
        const descriptor = registry.validateDescriptor(candidate.descriptor)
        accepted[mapKey] = descriptor
      } catch (error) {
        problems.push({ connectionId: mapKey, problem: providerProblem(error) })
      }
    }
    return { accepted, problems }
  }

  function publicRows(
    connections: Record<string, HarnessConnectionDescriptor>,
  ): HarnessConnectionRef[] {
    return Object.values(connections).map((connection) => registry.publicRef(connection))
  }

  function revisionProblems(
    previous: Record<string, HarnessConnectionDescriptor>,
    next: Record<string, HarnessConnectionDescriptor>,
  ): HarnessConnectionProblem[] {
    const problems: HarnessConnectionProblem[] = []
    for (const [connectionId, descriptor] of Object.entries(next)) {
      const prior = previous[connectionId]
      if (!prior) continue
      try {
        registry.assertRevision(descriptor, prior)
      } catch (error) {
        problems.push({ connectionId, problem: providerProblem(error) })
        continue
      }
      if (
        descriptor.configRevision === prior.configRevision
        && JSON.stringify(descriptor) !== JSON.stringify(prior)
      ) {
        problems.push({ connectionId, problem: "changed connection config requires a higher configRevision" })
      }
    }
    return problems
  }

  return { publicRows, revisionProblems, validate }
}

export function isConnectionId(input: string): boolean {
  return input.trim().length > 0
}

export function isNativeHarnessId(input: string): input is RuntimeNativeHarnessId {
  return AGENT_HARNESS_IDS.some((id) => id === input)
}

export function explicitDefaultHarness(input: {
  defaultConnectionId?: string
  defaultHarness?: NativeHarnessSelection
}): RuntimeHarnessSelection | undefined {
  if (input.defaultConnectionId) {
    return { kind: "connection", connectionId: input.defaultConnectionId }
  }
  return input.defaultHarness
}

function descriptorCandidate(
  mapKey: string,
  row: Record<string, unknown>,
): { descriptor: HarnessConnectionDescriptor } | { problem: string } {
  if (!isConnectionId(mapKey)) return { problem: "connectionId must be a non-empty opaque string" }
  const extra = Object.keys(row).find((key) => !DESCRIPTOR_KEYS.has(key))
  if (extra) return { problem: `unsupported descriptor field: ${extra}` }
  if (row.connectionId !== mapKey) return { problem: "connectionId must exactly match its map key" }
  if (typeof row.providerKey !== "string") return { problem: "providerKey must be a non-empty opaque string" }
  if (typeof row.configRevision !== "number") return { problem: "configRevision must be a non-negative safe integer" }
  if (typeof row.enabled !== "boolean") return { problem: "enabled must be a boolean" }
  const secretRefs = stringRecord(row.secretRefs)
  if (row.secretRefs !== undefined && !secretRefs) return { problem: "secretRefs must be a string map" }
  return {
    descriptor: {
      connectionId: row.connectionId,
      providerKey: row.providerKey,
      configRevision: row.configRevision,
      enabled: row.enabled,
      config: row.config,
      ...(secretRefs ? { secretRefs } : {}),
    },
  }
}

function providerProblem(error: unknown) {
  if (error instanceof ConnectionProviderError) return error.message
  return error instanceof Error ? error.message : "connection descriptor is invalid"
}

/** A shallow copy of a JSON object, so a caller can keep it without aliasing the parsed value. */
function objectRecord(input: unknown): Record<string, unknown> | undefined {
  const row = jsonRecord(input)
  return row && { ...row }
}

function stringRecord(input: unknown): Record<string, string> | undefined {
  const row = jsonRecord(input)
  if (!row) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(row)) {
    if (typeof value !== "string") return undefined
    out[key] = value
  }
  return out
}
