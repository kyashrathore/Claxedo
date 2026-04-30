import * as path from "path"
import type { ResolvedMcpServer } from "../../../mcp-resolver"
import { toOpencodeConfig } from "../../../mcp-resolver"

export function opencodePaths(root: string) {
  const config = path.join(root, "opencode-config")
  return {
    config,
    plugin: path.join(config, "plugin"),
    agent: path.join(config, "agent"),
  }
}

export function generateOpencodeJsonc(mcp: Record<string, ResolvedMcpServer>): string {
  return JSON.stringify(toOpencodeConfig(mcp), null, 2) + "\n"
}
