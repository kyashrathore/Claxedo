import fs from "node:fs/promises"
import path from "node:path"
import { connectFirstPartyMcp } from "../../first-party-mcp-client"
import type { FirstPartyMcpServer } from "../../first-party-mcp"
import { controlRequestDeadline } from "../shared/request-deadline"
import type { PiTitleProcess } from "./title-extension"

export const PI_MCP_COMMAND = "claxedo-mcp"

export function piMcpExtensionSource() {
  return `const connect = ${connectFirstPartyMcp.toString()}
export default function (pi) {
  let connection
  const registered = new Set()
  pi.registerCommand("${PI_MCP_COMMAND}", {
    description: "Connect this session's Claxedo tools",
    handler: async (args) => {
      if (connection) await connection.close()
      connection = undefined
      pi.setActiveTools(pi.getActiveTools().filter((name) => !registered.has(name)))
      const server = JSON.parse(args)
      if (!server) return
      connection = await connect(server)
      const tools = await connection.tools()
      for (const tool of tools) {
        const name = "mcp__claxedo__" + tool.name
        if (!registered.has(name)) {
          pi.registerTool({
            name, label: tool.name, description: tool.description || tool.name,
            parameters: tool.inputSchema,
            execute: async (_id, args, signal) => {
              if (!connection) throw new Error("Claxedo MCP is disconnected")
              const result = await connection.call(tool.name, args, signal)
              if (result.isError) throw new Error(result.content.map((block) => block.text || JSON.stringify(block)).join("\\n"))
              return { content: result.content, details: {} }
            },
          })
          registered.add(name)
        }
      }
      pi.setActiveTools([...pi.getActiveTools(), ...tools.map((tool) => "mcp__claxedo__" + tool.name)])
    },
  })
  pi.on("session_shutdown", async () => { if (connection) await connection.close() })
}
`
}

export async function ensurePiMcpExtension(agentDir: string) {
  const file = path.join(agentDir, "claxedo-mcp.mjs")
  const source = piMcpExtensionSource()
  if (await fs.readFile(file, "utf8").catch(() => null) !== source) await fs.writeFile(file, source, { mode: 0o600 })
  return file
}

export async function configurePiMcp(process: PiTitleProcess, server: FirstPartyMcpServer | undefined) {
  let failure: string | undefined
  const stop = process.onEvent((event) => {
    if (event.type === "extension_error" && event.extensionPath === `command:${PI_MCP_COMMAND}`) failure = String(event.error)
  })
  try {
    await process.request("prompt", { message: `/${PI_MCP_COMMAND} ${JSON.stringify(server ?? null)}` }, controlRequestDeadline())
    if (failure) throw new Error(failure)
  } finally {
    stop()
  }
}
