import type { HarnessSession, McpOperationRefusal, McpOperations, McpResourceRead, McpToolCall } from "@claxedo/harness/contract"
import type { SessionAttachments } from "./attachments"

export type SessionMcpUnsupported = { ok: false; status: "unsupported"; harness: string }

/**
 * Lists, calls and reads on the MCP connections the session's harness holds
 * for its owner. They are the harness's own connections, so a session that
 * holds no harness process answers `not_found` instead of launching one.
 */
export function createSessionMcp(attachments: Pick<SessionAttachments, "withoutAttaching">) {
  async function on<T>(sessionId: string, directory: string | undefined,
    run: (operations: McpOperations, session: HarnessSession) => Promise<T>): Promise<T | McpOperationRefusal | SessionMcpUnsupported> {
    const read = await attachments.withoutAttaching(sessionId, directory)
    const operations = read.handle.transport.mcp
    if (!operations) return { ok: false, status: "unsupported", harness: read.handle.runner.id }
    if (!read.attached) return { ok: false, status: "not_found", message: `Session ${sessionId} runs no harness process` }
    return await run(operations, read.attached.session)
  }
  return {
    listTools: (sessionId: string, server: string, directory?: string) =>
      on(sessionId, directory, (operations, session) => operations.listTools(session, server)),
    callTool: (sessionId: string, call: McpToolCall, directory?: string) =>
      on(sessionId, directory, (operations, session) => operations.callTool(session, call)),
    readResource: (sessionId: string, read: McpResourceRead, directory?: string) =>
      on(sessionId, directory, (operations, session) => operations.readResource(session, read)),
  }
}
