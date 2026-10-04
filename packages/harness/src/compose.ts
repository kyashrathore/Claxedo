import { TransportError, type HarnessServices, type HarnessTransport } from "./contract"
export type { ConnectionTransportInput } from "./registry/providers/connection"
import { harnessRecord, type NativeHarnessId } from "./registry/table"
import { createAcpProvider } from "./registry/providers/acp"
import type { CustomHarnessProvider } from "./registry/providers/types"
import { connectionTransport, type ConnectionTransportInput } from "./registry/providers/connection"
import { filterMcpServers } from "./capabilities/mcp-filter"
import { AcpTransport } from "./transports/acp"
import { PiDurableTransport } from "./transports/pi-durable"
import { createNodePiPlacement, type PiNodeOptions } from "./transports/pi-durable/node"
import { CodexAppServerTransport, type CodexTransportOptions } from "./transports/codex-app-server"
import { ClaudeSdkTransport } from "./transports/claude-sdk"
import type { ClaudeSdkOptions } from "./transports/claude-sdk/launch-context"
import { CursorSdkTransport, type CursorSdkTransportOptions } from "./transports/cursor-sdk"
export { CURSOR_WORKER_FILE } from "./transports/cursor-sdk"
import { OpenCodeSdkTransport, type OpenCodeSdkTransportOptions } from "./transports/opencode-sdk/transport"

export type HarnessCompositionOptions = {
  pi: () => PiNodeOptions
  codex: () => CodexTransportOptions
  claude: () => ClaudeSdkOptions
  cursor: () => CursorSdkTransportOptions
  opencode: () => OpenCodeSdkTransportOptions
}

export function createHarnessComposer(
  services: HarnessServices,
  options: HarnessCompositionOptions,
  custom: readonly CustomHarnessProvider<unknown>[] = [],
) {
  const acp = createAcpProvider((config, host) => new AcpTransport(host, config.connection, filterMcpServers))
  return {
    builtIn(id: NativeHarnessId): HarnessTransport {
      const record = harnessRecord(id)
      if (!record || record.access !== "native") throw new TransportError("provider", "connection_unavailable", `Unknown built-in harness: ${id}`)
      if (record.transport === "pi-durable") return new PiDurableTransport(services, createNodePiPlacement({ ...options.pi(), services }))
      if (record.transport === "codex-app-server") return new CodexAppServerTransport(services, options.codex())
      if (record.transport === "claude-sdk") return new ClaudeSdkTransport(services, options.claude())
      if (record.transport === "cursor-sdk") return new CursorSdkTransport(services, options.cursor())
      if (record.transport === "opencode-sdk") return new OpenCodeSdkTransport(services, options.opencode())
      throw new TransportError("provider", "connection_unavailable", `Transport is not native: ${record.transport}`)
    },
    connection(input: ConnectionTransportInput): HarnessTransport {
      return connectionTransport(services, [acp, ...custom], input)
    },
  }
}
