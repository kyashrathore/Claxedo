import { decodeModelSelection, type ModelSelection } from "@claxedo/agent-runtime-contract"
import { configObject, onlyFields, resolveBindings, secretBindings, configStringArray, configStringRecord, configText, type SecretBindings } from "./bindings"
import { transportNotBuilt, type CustomHarnessProvider } from "./types"
import { TransportError } from "../../contract/errors"

export type AcpConnection =
  | { kind: "process"; command: string; args?: string[]; env?: Record<string, string>; supportsMcpServers?: boolean; sharedFilesystem?: boolean }
  | { kind: "streamable-http"; url: string; headers?: Record<string, string>; supportsMcpServers?: boolean; sharedFilesystem?: boolean }
  | { kind: "websocket"; url: string; protocols?: string[]; headers?: Record<string, string>; supportsMcpServers?: boolean; sharedFilesystem?: boolean }

export type AcpProviderConfig = {
  label: string
  connection: AcpConnection
  modelSelection?: ModelSelection
  secretBindings?: SecretBindings
}

export function validateAcpConnection(input: unknown): AcpConnection {
  const row = configObject(input, "connection")
  const supportsMcpServers = acpConfigBoolean(row.supportsMcpServers, "supportsMcpServers")
  const sharedFilesystem = acpConfigBoolean(row.sharedFilesystem, "sharedFilesystem")
  const common = { ...(supportsMcpServers !== undefined ? { supportsMcpServers } : {}), ...(sharedFilesystem !== undefined ? { sharedFilesystem } : {}) }
  if (row.kind === "process") {
    onlyFields(row, ["kind", "command", "args", "env", "supportsMcpServers", "sharedFilesystem"], "connection")
    return { kind: "process", command: configText(row.command, "command"), ...common,
      ...(row.args !== undefined ? { args: configStringArray(row.args, "args")! } : {}),
      ...(row.env !== undefined ? { env: configStringRecord(row.env, "env")! } : {}) }
  }
  if (row.kind === "streamable-http" || row.kind === "websocket") {
    onlyFields(row, row.kind === "websocket" ? ["kind", "url", "protocols", "headers", "supportsMcpServers", "sharedFilesystem"] : ["kind", "url", "headers", "supportsMcpServers", "sharedFilesystem"], "connection")
    const url = configText(row.url, "url")
    let protocol: string
    try { protocol = new URL(url).protocol } catch { throw new TransportError("provider", "invalid_config", "connection URL is invalid") }
    const allowed = row.kind === "websocket" ? ["ws:", "wss:"] : ["http:", "https:"]
    if (!allowed.includes(protocol)) throw new TransportError("provider", "invalid_config", "connection URL protocol is invalid")
    return { kind: row.kind, url, ...common,
      ...(row.headers !== undefined ? { headers: configStringRecord(row.headers, "headers")! } : {}),
      ...(row.kind === "websocket" && row.protocols !== undefined ? { protocols: configStringArray(row.protocols, "protocols")! } : {}) }
  }
  throw new TransportError("provider", "invalid_config", "connection kind must be process, streamable-http, or websocket")
}

function acpConfigBoolean(input: unknown, field: string): boolean | undefined {
  if (input === undefined) return undefined
  if (typeof input !== "boolean") throw new TransportError("provider", "invalid_config", `${field} must be boolean`)
  return input
}

export function createAcpProvider(): CustomHarnessProvider<AcpProviderConfig> {
  return {
    providerKey: "acp",
    validateConfig(input) {
      const row = configObject(input, "config")
      onlyFields(row, ["label", "connection", "modelSelection", "secretBindings"], "config")
      const connection = validateAcpConnection(row.connection)
      const bindings = secretBindings(row.secretBindings, connection.kind === "process" ? "process" : "remote", connection.kind === "process" ? connection.env ?? {} : connection.headers ?? {})
      return { label: configText(row.label, "label"), connection,
        ...(row.modelSelection !== undefined ? { modelSelection: decodeModelSelection(row.modelSelection) } : {}),
        ...(bindings ? { secretBindings: bindings } : {}) }
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
      return { label: config.label, readiness: "configured",
        capabilities: { abort: true, reconnect: false, replay: true, permissions: true, questions: true, todos: false, commands: false, fork: false, revert: false, unrevert: false, configOptions: true, subagents: false },
        ...(config.modelSelection ? { modelSelection: config.modelSelection } : {}) }
    },
    resolve({ descriptor, secrets }) {
      const config = descriptor.config
      const materialized = resolveBindings(config.secretBindings, secrets)
      const connection = config.connection.kind === "process"
        ? { ...config.connection, env: { ...config.connection.env, ...materialized } }
        : { ...config.connection, headers: { ...config.connection.headers, ...materialized } }
      return { config: { ...config, connection } }
    },
    createTransport() { return transportNotBuilt("acp") },
  }
}
