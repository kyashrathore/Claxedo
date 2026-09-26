import { asRecord } from "@claxedo/helpers/guards"
import { stringRecord } from "@claxedo/helpers"
import { AGENT_HARNESS_IDS, isAcpConnectionId, type HarnessConnectionRef } from "@claxedo/agent-runtime-contract"
import { acpConnectionConfig } from "@claxedo/harness/providers"
import type { ConnectionConfigHooks, HarnessConnectionDescriptor } from "@claxedo/harness/providers"
import {
  type RuntimeHarnessSelection,
  type RuntimeNativeHarnessId,
} from "@claxedo/workspace-runtime/config"

export type { ConnectionConfigHooks, HarnessConnectionDescriptor } from "@claxedo/harness/providers"
export type { HarnessConnectionRef } from "@claxedo/agent-runtime-contract"

export type HarnessConnectionProblem = {
  connectionId: string
  problem: string
}

type NativeHarnessSelection = Extract<RuntimeHarnessSelection, { kind: "native" }>

/** The providers a control plane accepts descriptors for when the composition installs none. */
export function defaultConnectionConfigs(): readonly ConnectionConfigHooks<unknown>[] {
  return [acpConnectionConfig()]
}

const DESCRIPTOR_KEYS = new Set([
  "connectionId",
  "providerKey",
  "configRevision",
  "enabled",
  "config",
  "secretRefs",
])

/**
 * The one descriptor policy: server-core owns identity, revision and
 * retargeting rules, while each installed provider's config hooks own the
 * shape of `config`.
 */
export function createHarnessConnectionSchema(
  configs: readonly ConnectionConfigHooks<unknown>[] = defaultConnectionConfigs(),
) {
  const providers = new Map<string, ConnectionConfigHooks<unknown>>()
  for (const provider of configs) {
    if (providers.has(provider.providerKey)) throw new Error(`Connection provider ${provider.providerKey} is registered more than once`)
    providers.set(provider.providerKey, provider)
  }
  const providerFor = (providerKey: string) => {
    const provider = providers.get(providerKey)
    if (!provider) throw new Error(`Connection provider ${providerKey} is not installed`)
    return provider
  }
  const validateDescriptor = (input: HarnessConnectionDescriptor): HarnessConnectionDescriptor => {
    if (!isAcpConnectionId(input.connectionId)) throw new Error("connectionId must be a lowercase session harness slug of at most 64 characters")
    if (!Number.isSafeInteger(input.configRevision) || input.configRevision < 1) throw new Error("configRevision must be a positive safe integer")
    return { ...input, config: providerFor(input.providerKey).validateConfig(input.config) }
  }
  const publicRef = (input: HarnessConnectionDescriptor): HarnessConnectionRef => {
    const descriptor = validateDescriptor(input)
    const projection = providerFor(descriptor.providerKey).project(descriptor.config)
    return { connectionId: descriptor.connectionId, enabled: descriptor.enabled,
      label: projection.label, readiness: descriptor.enabled ? projection.readiness : "disabled",
      capabilities: projection.capabilities,
      ...(projection.modelSelection ? { modelSelection: projection.modelSelection } : {}) }
  }
  const assertRevision = (input: HarnessConnectionDescriptor, previous: HarnessConnectionDescriptor): void => {
    if (input.connectionId !== previous.connectionId || input.providerKey !== previous.providerKey) {
      throw new Error("connectionId and providerKey are immutable")
    }
    if (input.configRevision < previous.configRevision) throw new Error(`Connection ${input.connectionId} config revision moved backwards`)
    const provider = providerFor(input.providerKey)
    if (provider.immutableIdentity
      && provider.immutableIdentity(validateDescriptor(input).config) !== provider.immutableIdentity(validateDescriptor(previous).config)) {
      throw new Error(`Connection ${input.connectionId} cannot be retargeted; create a new connectionId`)
    }
  }

  function validate(input: unknown): {
    accepted: Record<string, HarnessConnectionDescriptor>
    problems: HarnessConnectionProblem[]
  } {
    const accepted: Record<string, HarnessConnectionDescriptor> = {}
    const problems: HarnessConnectionProblem[] = []
    const rows = asRecord(input)
    if (!rows) {
      return {
        accepted,
        problems: [{ connectionId: "", problem: "connections must be an object map" }],
      }
    }

    for (const [mapKey, value] of Object.entries(rows)) {
      const row = asRecord(value)
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
        const descriptor = validateDescriptor(candidate.descriptor)
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
    return Object.values(connections).map((connection) => publicRef(connection))
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
        assertRevision(descriptor, prior)
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
  const refs = asRecord(row.secretRefs)
  const secretRefs = refs ? stringRecord(refs, { requireAllStrings: true }) : undefined
  if (row.secretRefs !== undefined && (!refs || Object.keys(secretRefs ?? {}).length !== Object.keys(refs).length)) {
    return { problem: "secretRefs must be a string map" }
  }
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
  return error instanceof Error ? error.message : "connection descriptor is invalid"
}
