import { randomUUID } from "node:crypto"
import type { SessionTitleRequest } from "@claxedo/agent-runtime-contract"
import { errorMessage } from "@claxedo/helpers"
import type { Logger } from "../../contract"
import type { CursorHost } from "./host-registry"
import { cursorModelId } from "./launch"
import type { HostSession } from "./protocol"

export async function cursorSessionTitle(input: { host: CursorHost; session: HostSession; request: SessionTitleRequest; log: Logger }): Promise<string | null> {
  const { request } = input
  if (request.signal.aborted) return null
  const session: HostSession = {
    sessionId: `${input.session.sessionId}:title:${randomUUID()}`, directory: request.directory, apiKey: input.session.apiKey,
    model: cursorModelId(request.model?.modelID), mcpServers: {},
    local: input.session.local.settingSources ? { settingSources: input.session.local.settingSources } : {},
  }
  const onAbort = () => {
    void input.host.call({ kind: "cancel", sessionId: session.sessionId }).then(undefined,
      (error: unknown) => input.log.warn("Cursor title cancellation failed", { error: errorMessage(error) }))
  }
  request.signal.addEventListener("abort", onAbort, { once: true })
  try {
    const reply = await input.host.call({ kind: "title", session, prompt: `${request.system}\n\n${request.user}` })
    if (request.signal.aborted) return null
    return reply.value?.result ?? null
  } finally { request.signal.removeEventListener("abort", onAbort) }
}
