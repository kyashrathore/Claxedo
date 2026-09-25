import { TransportError, type HarnessServices, type HarnessTransport } from "./contract"
import { harnessRecord, type BuiltInHarnessId } from "./registry/table"
import { createAcpProvider } from "./registry/providers/acp"
import { createPiRpcProvider } from "./registry/providers/pi-rpc"
import type { CustomHarnessProvider, HarnessConnectionDescriptor } from "./registry/providers/types"
import { filterMcpServers } from "./capabilities/mcp-filter"
import { AcpTransport } from "./transports/acp"
import type { MissingSessionContext } from "./transports/acp/restore"
import { PiRpcTransport, type PiRpcOptions } from "./transports/pi-rpc"
import { CodexAppServerTransport, type CodexTransportOptions } from "./transports/codex-app-server"
import { ClaudeSdkTransport } from "./transports/claude-sdk"
import type { ClaudeSdkOptions } from "./transports/claude-sdk/launch-context"
import { CursorSdkTransport } from "./transports/cursor-sdk"

export type HarnessCompositionOptions = {
  acp: { missingContext: MissingSessionContext }
  pi: PiRpcOptions
  codex: CodexTransportOptions
  claude: ClaudeSdkOptions
  cursor: { env: NodeJS.ProcessEnv }
}

export type ConnectionTransportInput = {
  descriptor: HarnessConnectionDescriptor
  expectedRevision: number
  directory: string
  secrets: Readonly<Record<string, string>>
}

export function createHarnessComposer(services: HarnessServices, options: HarnessCompositionOptions) {
  const acp = createAcpProvider((config, host) => new AcpTransport(host, config.connection, filterMcpServers, options.acp.missingContext))
  const pi = createPiRpcProvider((config, host) => new PiRpcTransport(host, {
    ...options.pi, binary: config.command, args: config.args, env: { ...options.pi.env, ...config.env },
    ownerAgentDir: config.profileDir ?? options.pi.ownerAgentDir,
  }))
  const createConnection = <TConfig>(provider: CustomHarnessProvider<TConfig>, input: ConnectionTransportInput): HarnessTransport => {
    const config = provider.validateConfig(input.descriptor.config)
    const descriptor = { ...input.descriptor, config }
    const resolved = provider.resolve({ descriptor, directory: input.directory, secrets: input.secrets })
    return provider.createTransport({ descriptor, expectedRevision: input.expectedRevision, resolved, services })
  }
  return {
    builtIn(id: BuiltInHarnessId | "pi"): HarnessTransport {
      const record = harnessRecord(id)
      if (!record || record.access !== "native") throw new TransportError("provider", "connection_unavailable", `Unknown built-in harness: ${id}`)
      if (record.transport === "pi-rpc") return new PiRpcTransport(services, options.pi)
      if (record.transport === "codex-app-server") return new CodexAppServerTransport(services, options.codex)
      if (record.transport === "claude-sdk") return new ClaudeSdkTransport(services, options.claude)
      if (record.transport === "cursor-sdk") return new CursorSdkTransport(services, options.cursor.env)
      throw new TransportError("provider", "connection_unavailable", `Transport is not composed: ${record.transport}`)
    },
    connection(input: ConnectionTransportInput): HarnessTransport {
      if (input.descriptor.providerKey === "acp") return createConnection(acp, input)
      if (input.descriptor.providerKey === "pi-rpc") return createConnection(pi, input)
      throw new TransportError("provider", "connection_unavailable", `Unknown harness provider: ${input.descriptor.providerKey}`)
    },
  }
}
