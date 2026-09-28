import { errorMessage, settleAtRequestDeadline } from "@claxedo/helpers"
import type { AdapterCancelOutcome } from "@claxedo/agent-runtime-contract"
import type { Deadline } from "../../contract"
import type { Entry } from "./entry"
import { OpenCodeInterruptExpiredError } from "./errors"
import type { OpenCodeRuntime } from "./runtime"
import { eventAssistantMessageID, eventSessionID, terminal } from "./translate/event"

export async function cancelOpenCodeTurn(runtime: OpenCodeRuntime, entry: Entry, deadline: Deadline): Promise<AdapterCancelOutcome> {
  const expected = entry.assistantMessageID
  let finish!: (state: "terminal" | "uncorrelated") => void
  const settled = new Promise<"terminal" | "uncorrelated">((resolve) => { finish = resolve })
  const unsubscribe = runtime.events.subscribe((event) => {
    if (eventSessionID(event) !== entry.upstream || !terminal(event, entry.upstream)) return
    const id = eventAssistantMessageID(event)
    if (!id || !expected) finish("uncorrelated")
    else if (id === expected) finish("terminal")
  })
  try {
    const interrupted = runtime.sessions.interrupt(entry.scope, entry.upstream).then(() => settled)
    const state = await settleAtRequestDeadline("OpenCode interrupt", { deadlineAt: deadline.at, signal: deadline.signal },
      interrupted, () => {}, () => new OpenCodeInterruptExpiredError())
    return { execution: state === "terminal" ? "terminal" : "unknown", cleanup: "unknown" }
  } catch (cause) {
    if (cause instanceof OpenCodeInterruptExpiredError) return { execution: "running", cleanup: "unknown" }
    return { execution: "unknown", cleanup: "unknown",
      error: { code: "provider_unreachable", message: `OpenCode refused the interrupt: ${errorMessage(cause)}` } }
  } finally {
    unsubscribe()
  }
}
