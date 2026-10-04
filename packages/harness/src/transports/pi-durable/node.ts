import fs from "node:fs/promises"
import path from "node:path"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createRegistry, Harness } from "@earendil-works/pi-durable"
import { StreamableHttpTransport, type McpTransport } from "@earendil-works/pi-mcp"
import type { HarnessServices, ProjectedMcpServer } from "../../contract/node"
import { piConfiguration } from "./errors"
import { mcpStdioBaseEnv, OwnedStdioMcpTransport } from "./mcp-stdio"
import type { PiPlacement, PiSessionRuntime } from "./placement"
import { ownedExecutionEnv, sessionCommands } from "./shell"
import { openPiStorage } from "./storage"

export type PiNodeOptions = { stateRoot: string; env: Readonly<Record<string, string | undefined>> }

function definedEnv(env: PiNodeOptions["env"]): Record<string, string> {
  return Object.fromEntries(Object.entries(env).flatMap(([name, value]) => value === undefined ? [] : [[name, value]]))
}

async function sessionStorage(stateRoot: string, sessionId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw piConfiguration(`Pi cannot store session ${sessionId}`)
  const file = path.join(stateRoot, "sessions", `${sessionId}.sqlite`)
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  return openPiStorage(file)
}

export function createNodePiPlacement(input: PiNodeOptions & { services: HarnessServices }): PiPlacement {
  const env = definedEnv(input.env)
  const mcpEnv = mcpStdioBaseEnv(input.env)
  const directories = new Map<string, string>()
  const commands = sessionCommands(input.services)
  const placement: PiPlacement = {
    env: ({ sessionId, directory }) => ({ cwd }) => ownedExecutionEnv({ sessionId, services: input.services, env, live: commands.of(sessionId) }, cwd ?? directory),
    async open({ sessionId, directory, models }): Promise<PiSessionRuntime> {
      const registry = createRegistry()
      const harness = await Harness.open(await sessionStorage(input.stateRoot, sessionId), { models, registry, env: placement.env({ sessionId, directory }),
        onReport: (error) => input.services.log.error("Pi extension failure", { sessionId, error: String(error) }) }, BACKGROUND_CONTEXT)
      const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { cwd: directory } })
      directories.set(sessionId, directory)
      return {
        harness, conversation, registry,
        submit: async (content, { requestId, whenBusy }) => {
          await conversation.submit({ type: "input", content, requestId, whenBusy }, BACKGROUND_CONTEXT)
        },
        close: async () => {
          directories.delete(sessionId)
          await harness.close(BACKGROUND_CONTEXT)
          await commands.retire(sessionId)
        },
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
