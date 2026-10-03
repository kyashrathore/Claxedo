import type { SessionTitleRequest } from "@claxedo/agent-runtime-contract"
import type { Api, Model, Models } from "@earendil-works/pi-ai"
import { piConfiguration } from "./errors"

export async function piSessionTitle(models: Models, model: Model<Api>, request: SessionTitleRequest): Promise<string | null> {
  const reply = await models.completeSimple(model, {
    systemPrompt: request.system,
    messages: [{ role: "user", content: request.user, timestamp: Date.now() }],
  }, { signal: request.signal })
  if (reply.stopReason === "error") throw piConfiguration(reply.errorMessage ?? "Pi could not generate a session title")
  const text = reply.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")
  return text.split("\n").map((line) => line.trim().replace(/^["'`]+|["'`]+$/g, "").trim()).find((line) => line.length > 0) ?? null
}
