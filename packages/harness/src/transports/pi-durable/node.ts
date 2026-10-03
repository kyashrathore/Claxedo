import fs from "node:fs/promises"
import path from "node:path"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createRegistry, Harness } from "@earendil-works/pi-durable"
import { StreamableHttpTransport, type McpTransport } from "@earendil-works/pi-mcp"
import type { HarnessServices, ProjectedMcpServer } from "../../contract/node"
import { piConfiguration } from "./errors"
import { OwnedStdioMcpTransport } from "./mcp-stdio"
import { piHarnessOptions, type PiPlacement, type PiSessionRuntime } from "./placement"
import { ownedExecutionEnv } from "./shell"
import { openPiStorage } from "./storage"

export type PiNodeOptions = { stateRoot: string; env: Readonly<Record<string, string | undefined>> }

const MCP_INHERITED_ENV = process.platform === "win32"
  ? ["APPDATA", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "PROCESSOR_ARCHITECTURE", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERNAME", "USERPROFILE"]
  : ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"]

function definedEnv(env: PiNodeOptions["env"], names?: readonly string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(env).flatMap(([name, value]) => value === undefined || (names && !names.includes(name)) ? [] : [[name, value]]))
}

export function createNodePiPlacement(input: PiNodeOptions & { services: HarnessServices }): PiPlacement {
  const env = definedEnv(input.env)
  const mcpEnv = definedEnv(input.env, MCP_INHERITED_ENV)
  const directories = new Map<string, string>()
  const placement: PiPlacement = {
    env: ({ sessionId, directory }) => ({ cwd }) => ownedExecutionEnv({ sessionId, services: input.services, env }, cwd ?? directory),
    async open({ sessionId, directory, models }): Promise<PiSessionRuntime> {
      if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw piConfiguration(`Pi cannot store session ${sessionId}`)
      const file = path.join(input.stateRoot, "sessions", `${sessionId}.sqlite`)
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      const registry = createRegistry()
      const options = piHarnessOptions({ models, registry, env: placement.env({ sessionId, directory }),
        onReport: (error) => input.services.log.error("Pi extension failure", { sessionId, error: String(error) }) })
      const harness = await Harness.open(await openPiStorage(file), options, BACKGROUND_CONTEXT)
      const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { cwd: directory } })
      directories.set(sessionId, directory)
      return {
        harness, conversation, registry,
        submit: async (content, { requestId, whenBusy }) => {
          await conversation.submit({ type: "input", content, requestId, whenBusy }, BACKGROUND_CONTEXT)
        },
        close: async () => { directories.delete(sessionId); await harness.close(BACKGROUND_CONTEXT) },
      }
    },
    async mcpTransport(server: ProjectedMcpServer, sessionId: string): Promise<McpTransport> {
      if (server.kind === "stdio") {
        return new OwnedStdioMcpTransport(server, { cwd: directories.get(sessionId) ?? input.stateRoot, sessionId, baseEnv: mcpEnv, services: input.services })
      }
      if (server.kind === "sse") throw piConfiguration(`Pi cannot load SSE MCP server ${server.name}`)
      return new StreamableHttpTransport({ url: server.url, headers: { ...server.headers } })
    },
  }
  return placement
}
