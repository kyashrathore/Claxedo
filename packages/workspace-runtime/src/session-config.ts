import {
  normalizeAgentHarnessTransport,
  normalizeHarnessIdentity,
  type HarnessConnection,
  type PromptModel,
  type SessionConfig,
  type SessionConfigRequestUpdate,
  type SessionHarness,
} from "@claxedo/agent-sdk-runtime"

function record(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  return input as Record<string, unknown>
}

function stringRecord(input: unknown): Record<string, string> | undefined {
  const row = record(input)
  if (!row) return
  if (!Object.values(row).every((item) => typeof item === "string")) return
  return row as Record<string, string>
}

export function normalizeSessionHarness(input: unknown): SessionHarness | undefined {
  const row = record(input)
  if (!row) return
  const identity = normalizeHarnessIdentity(row)
  if (!identity) return
  const connection = harnessConnection(row)
  return {
    id: identity.id,
    access: identity.access,
    ...(connection ? { connection } : {}),
  }
}

function harnessConnection(row: Record<string, unknown>): HarnessConnection | undefined {
  const nested = record(row.connection)
  if (nested?.kind === "process") {
    return {
      kind: "process",
      ...(typeof nested.binary === "string" ? { binary: nested.binary } : {}),
      ...(Array.isArray(nested.args) && nested.args.every((item) => typeof item === "string")
        ? { args: nested.args }
        : {}),
    }
  }
  if (nested?.kind === "remote") {
    const transport = normalizeAgentHarnessTransport(nested.transport)
    const headers = stringRecord(nested.headers)
    return {
      kind: "remote",
      ...(transport ? { transport } : {}),
      ...(typeof nested.url === "string" ? { url: nested.url } : {}),
      ...(headers ? { headers } : {}),
    }
  }
  const headers = stringRecord(row.headers)
  if (typeof row.url === "string" || row.transport !== undefined || headers) {
    const transport = normalizeAgentHarnessTransport(row.transport)
    return {
      kind: "remote",
      ...(transport ? { transport } : {}),
      ...(typeof row.url === "string" ? { url: row.url } : {}),
      ...(headers ? { headers } : {}),
    }
  }
  if (typeof row.binary === "string") return { kind: "process", binary: row.binary }
}

function promptModel(input: unknown): PromptModel | null | undefined {
  if (input === null) return null
  const row = record(input)
  if (!row) return
  if (typeof row.providerID !== "string" || typeof row.modelID !== "string") return
  return {
    providerID: row.providerID,
    modelID: row.modelID,
  }
}

export function normalizeSessionConfigUpdate(input: unknown): SessionConfigRequestUpdate {
  const row = record(input) ?? {}
  const legacyRunner = record(row.runner)
  const harness = normalizeSessionHarness(row.harness ?? legacyRunner)
  const model = "model" in row
    ? promptModel(row.model)
    : typeof legacyRunner?.model === "string" && typeof legacyRunner.type === "string"
      ? { providerID: legacyRunner.type, modelID: legacyRunner.model }
      : undefined
  return {
    ...(harness ? { harness } : {}),
    ...(model !== undefined ? { model } : {}),
    ...("variant" in row && (typeof row.variant === "string" || row.variant === null) ? { variant: row.variant } : {}),
    ...("agent" in row && (typeof row.agent === "string" || row.agent === null) ? { agent: row.agent } : {}),
  }
}

export function normalizeSessionCreateConfig(input: unknown): SessionConfigRequestUpdate {
  const row = record(input) ?? {}
  const model = record(row.model)
  return normalizeSessionConfigUpdate({
    ...row,
    ...(typeof model?.providerID === "string" && typeof model.id === "string"
      ? { model: { providerID: model.providerID, modelID: model.id } }
      : {}),
    ...(!("variant" in row) && typeof model?.variant === "string" ? { variant: model.variant } : {}),
  })
}

export function normalizeSessionConfig(input: unknown): SessionConfig | undefined {
  const row = record(input) ?? {}
  const update = normalizeSessionConfigUpdate(input)
  if (!update.harness) return
  return {
    harness: update.harness,
    ...(update.model && update.model !== null ? { model: update.model } : {}),
    variant: "variant" in row && (typeof row.variant === "string" || row.variant === null) ? row.variant : null,
    agent: "agent" in row && (typeof row.agent === "string" || row.agent === null) ? row.agent : null,
  }
}
