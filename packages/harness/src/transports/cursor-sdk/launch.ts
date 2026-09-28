import type { AttachInput, HarnessServices, StartInput } from "../../contract"
import { sessionMcpServers } from "../../contract"
import { projectCursorMcpServers, type CursorPluginOptions } from "../../profiles/cursor"
import { permissionLocalOptions } from "./permission-modes"
import type { HostSession } from "./protocol"

export function cursorModelId(modelID: string | undefined): string {
  return modelID && modelID !== "default" ? modelID : "auto"
}

export function hostSession(input: StartInput | AttachInput, services: HarnessServices, apiKey: string,
  plugins: CursorPluginOptions, agentId?: string, model?: string): HostSession {
  const servers = sessionMcpServers(input, services, { includeFirstParty: input.locality === "local",
    duplicate: (name) => new Error(`Duplicate Cursor MCP server ${name}`) })
  return {
    sessionId: input.sessionId, directory: input.directory, apiKey, ...(agentId ? { agentId } : {}),
    model: cursorModelId(model ?? input.model?.modelID),
    mcpServers: projectCursorMcpServers(servers),
    local: { ...plugins, ...permissionLocalOptions(input.config) },
  }
}
