import { asRecord, decodeModelSelection, type ModelSelection } from "@claxedo/agent-runtime-contract"
import { ConnectionProviderError, type ConnectionProvider, type HarnessConnectionCapabilities } from "../../connection-provider"
import { AcpHarnessAdapter } from "."
import { validateACPConnection, type ACPConnection } from "./transport"

export type AcpConnectionProviderConfig = {
  label: string
  connection: ACPConnection
  modelSelection?: ModelSelection
  secretBindings?: {
    env?: Record<string, string>
    headers?: Record<string, string>
  }
}

const ACP_CONNECTION_CAPABILITIES: HarnessConnectionCapabilities = {
  abort: true,
  reconnect: false,
  replay: true,
  permissions: true,
  questions: true,
  todos: false,
  commands: false,
  fork: false,
  revert: false,
  unrevert: false,
  configOptions: true,
  subagents: false,
}

export function createAcpConnectionProvider(): ConnectionProvider<AcpConnectionProviderConfig> {
  return {
    providerKey: "acp",
    validateConfig(input) {
      const config = asRecord(input)
      if (!config) throw new Error("config must be an object")
      const extra = Object.keys(config).find((key) => !["label", "connection", "modelSelection", "secretBindings"].includes(key))
      if (extra) throw new Error(`config cannot include ${extra}`)
      if (typeof config.label !== "string" || config.label.length === 0) throw new Error("label must be a non-empty string")
      const connection = validateACPConnection(config.connection)
      const modelSelection = config.modelSelection === undefined ? undefined : decodeModelSelection(config.modelSelection)
      const secretBindings = validateSecretBindings(config.secretBindings, connection)
      return {
        label: config.label,
        connection,
        ...(modelSelection ? { modelSelection } : {}),
        ...(secretBindings ? { secretBindings } : {}),
      }
    },
    immutableIdentity(config) {
      const connection = config.connection
      return JSON.stringify(connection.kind === "process"
        ? { kind: connection.kind, command: connection.command, args: connection.args ?? [] }
        : connection.kind === "websocket"
          ? { kind: connection.kind, url: connection.url, protocols: connection.protocols ?? [] }
          : { kind: connection.kind, url: connection.url })
    },
    project(config) {
      return {
        label: config.label,
        readiness: "configured",
        capabilities: ACP_CONNECTION_CAPABILITIES,
        ...(config.modelSelection ? { modelSelection: config.modelSelection } : {}),
      }
    },
    resolve({ descriptor, secrets }) {
      const configured = configuredSecretNames(descriptor.config)
      const received = Object.keys(secrets).sort()
      if (configured.length !== received.length || configured.some((name, index) => name !== received[index])) {
        throw new ConnectionProviderError("connection_unavailable", `ACP connection ${descriptor.connectionId} secret lease does not match its bindings`)
      }
      return {
        config: materializeSecrets(descriptor.config, secrets),
      }
    },
    createAdapter({ descriptor, resolved, context }) {
      return new AcpHarnessAdapter({
        harness: descriptor.connectionId,
        connection: resolved.config.connection,
        store: context.store,
        eventHub: context.eventHub,
        ...(context.processObserver ? { processObserver: context.processObserver } : {}),
      })
    },
  }
}

function validateSecretBindings(input: unknown, connection: ACPConnection): AcpConnectionProviderConfig["secretBindings"] {
  if (input === undefined) return undefined
  const row = asRecord(input)
  if (!row) throw new Error("secretBindings must be an object")
  const extra = Object.keys(row).find((key) => key !== "env" && key !== "headers")
  if (extra) throw new Error(`secretBindings cannot include ${extra}`)
  const env = secretBindingRecord(row.env, "secretBindings.env")
  const headers = secretBindingRecord(row.headers, "secretBindings.headers")
  if (connection.kind === "process" && headers) throw new Error("process ACP connections cannot bind header secrets")
  if (connection.kind !== "process" && env) throw new Error("remote ACP connections cannot bind env secrets")
  if (env && Object.keys(env).some((name) => connection.kind === "process" && connection.env?.[name] !== undefined)) {
    throw new Error("secretBindings.env cannot overwrite a literal env value")
  }
  if (headers && Object.keys(headers).some((name) => connection.kind !== "process" && connection.headers?.[name] !== undefined)) {
    throw new Error("secretBindings.headers cannot overwrite a literal header value")
  }
  if (!env && !headers) return undefined
  return { ...(env ? { env } : {}), ...(headers ? { headers } : {}) }
}

function secretBindingRecord(input: unknown, field: string): Record<string, string> | undefined {
  if (input === undefined) return undefined
  const row = asRecord(input)
  if (!row) throw new Error(`${field} must be a string record`)
  const entries = Object.entries(row)
  const named = entries.filter((entry): entry is [string, string] => !!entry[0] && typeof entry[1] === "string" && !!entry[1])
  if (named.length === 0 || named.length !== entries.length) {
    throw new Error(`${field} must be a non-empty string record`)
  }
  return Object.fromEntries(named)
}

function configuredSecretNames(config: AcpConnectionProviderConfig) {
  return [...new Set([
    ...Object.values(config.secretBindings?.env ?? {}),
    ...Object.values(config.secretBindings?.headers ?? {}),
  ])].sort()
}

function materializeSecrets(
  config: AcpConnectionProviderConfig,
  secrets: Readonly<Record<string, string>>,
): AcpConnectionProviderConfig {
  const connection = config.connection.kind === "process"
    ? {
        ...config.connection,
        env: {
          ...config.connection.env,
          ...materializedBindings(config.secretBindings?.env, secrets),
        },
      }
    : {
        ...config.connection,
        headers: {
          ...config.connection.headers,
          ...materializedBindings(config.secretBindings?.headers, secrets),
        },
      }
  return { ...config, connection }
}

function materializedBindings(
  bindings: Readonly<Record<string, string>> | undefined,
  secrets: Readonly<Record<string, string>>,
) {
  const materialized: Record<string, string> = {}
  for (const [target, name] of Object.entries(bindings ?? {})) {
    const value = secrets[name]
    if (value !== undefined) materialized[target] = value
  }
  return materialized
}
