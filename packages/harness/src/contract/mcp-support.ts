import type { McpServerSpec, NotApplied, ProjectedMcpServer } from "./projection"
import type { NativeHarnessId } from "@claxedo/agent-runtime-contract"

const PI_SERVER_NAME = /^[A-Za-z0-9_-]+$/

export function harnessSupportsMcpServer(harness: NativeHarnessId | "acp", server: Pick<McpServerSpec, "kind" | "name"> & { cwd?: string }): boolean {
  if (harness === "pi") return server.kind !== "sse" && PI_SERVER_NAME.test(server.name)
  if (harness === "codex" && server.kind === "sse") return false
  return server.kind !== "stdio" || server.cwd === undefined || (harness !== "acp" && harness !== "claude")
}

export function projectMcpForHarness(harness: NativeHarnessId | "acp", servers: readonly ProjectedMcpServer[]): { servers: ProjectedMcpServer[]; notApplied: NotApplied[] } {
  const supported: ProjectedMcpServer[] = []
  const notApplied: NotApplied[] = []
  for (const server of servers) {
    if (harnessSupportsMcpServer(harness, server)) supported.push(server)
    else notApplied.push({ item: server.name, reason: "unsupported-by-harness" })
  }
  return { servers: supported, notApplied }
}
