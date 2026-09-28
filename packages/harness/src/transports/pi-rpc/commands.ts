import { piRegisteredCommands } from "./extension"
import type { PiRpc } from "./rpc"
import { PI_TITLE_COMMAND } from "./title"
import { PI_MCP_COMMAND } from "./mcp"

export async function piCommands(rpc: PiRpc) {
  return (await piRegisteredCommands(rpc)).flatMap(({ name, description }) =>
    name === PI_TITLE_COMMAND || name === PI_MCP_COMMAND ? [] : [{ name, description }])
}
