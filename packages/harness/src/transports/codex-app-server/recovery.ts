import type { v2 } from "@claxedo/agent-event-runtime/harnesses/codex"
import { errorMessage } from "@claxedo/helpers"
import { CodexTransportError, isMissingCodexThread } from "./errors"
import type { CodexRpc } from "./rpc"

export async function startCodexTurn(rpc: CodexRpc, params: v2.TurnStartParams, resume: v2.ThreadResumeParams): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await rpc.request("turn/start", params, 60_000) }
    catch (error) {
      if (!isMissingCodexThread(error)) throw error
      if (attempt === 2) throw new CodexTransportError("session", `Codex session is gone: ${errorMessage(error)}`, { cause: error })
      await rpc.request("thread/resume", resume)
    }
  }
  throw new CodexTransportError("session", "Codex thread recovery was exhausted")
}
