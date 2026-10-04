import { isRecord } from "@claxedo/helpers/guards"
import type { NotApplied, PluginProjection, ProjectedMcpServer } from "./projection"

export function parsePluginSelection(value: unknown): NonNullable<PluginProjection["pluginSelection"]> {
  if (isRecord(value) && value.mode === "default") return { mode: "default" }
  if (isRecord(value) && value.mode === "selected" && typeof value.selectionHash === "string" && value.selectionHash) {
    return { mode: "selected", selectionHash: value.selectionHash }
  }
  throw new Error("Invalid plugin execution metadata")
}

function isMcpStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string")
}

export function parseNotApplied(value: unknown): NotApplied[] {
  if (!Array.isArray(value)) throw new Error("Not-applied projection must be an array")
  return value.map((entry): NotApplied => {
    if (!isRecord(entry) || typeof entry.item !== "string"
      || (entry.reason !== "remote-harness" && entry.reason !== "unsupported-by-harness" && entry.reason !== "unsupported-transport"
        && entry.reason !== "not-installed" && entry.reason !== "not-consented")) throw new Error("Invalid not-applied projection")
    return { item: entry.item, reason: entry.reason }
  })
}

export function parseProjectedMcpServers(value: unknown): ProjectedMcpServer[] {
  if (!Array.isArray(value)) throw new Error("MCP projection must be an array")
  return value.map((server): ProjectedMcpServer => {
    if (!isRecord(server) || typeof server.name !== "string"
      || (server.origin !== "first-party" && server.origin !== "configured" && server.origin !== "plugin")) throw new Error("Invalid MCP projection identity")
    const origin = server.origin
    if (server.kind === "stdio" && typeof server.command === "string"
      && (server.args === undefined || (Array.isArray(server.args) && server.args.every((arg) => typeof arg === "string")))
      && (server.env === undefined || isMcpStringMap(server.env)) && (server.cwd === undefined || typeof server.cwd === "string")) {
      return { kind: "stdio", name: server.name, origin, command: server.command,
        ...(server.args === undefined ? {} : { args: server.args }),
        ...(server.env === undefined ? {} : { env: server.env }),
        ...(server.cwd === undefined ? {} : { cwd: server.cwd }) }
    }
    if ((server.kind === "http" || server.kind === "sse") && typeof server.url === "string"
      && (server.headers === undefined || isMcpStringMap(server.headers))) {
      return { kind: server.kind, name: server.name, origin, url: server.url,
        ...(server.headers === undefined ? {} : { headers: server.headers }) }
    }
    throw new Error(`Invalid MCP projection for ${server.name}`)
  })
}
