import type { AnswerResult, RequestAnswer } from "../../contract/broker"
import { grantToSave } from "../grants"
import type { BrokerPorts } from "../ports"
import { requestRefusal } from "./authority"
import type { RequestEntries, RequestEntry } from "./entries"
import { validateAnswer } from "./validation"

export async function validateAndCommit(ports: BrokerPorts, entries: RequestEntries, entry: RequestEntry, answer: RequestAnswer): Promise<AnswerResult> {
  entry.phase = "validating"
  const controller = new AbortController()
  const { promise: settled, resolve: settle } = Promise.withResolvers<void>()
  entry.validating = { controller, settled }
  try {
    await validateAnswer(ports, entry.pending.request, answer, controller.signal)
  } catch (error) {
    entry.validating = undefined
    settle()
    if (entry.cancelRequested) return entries.retryTermination(entry)
    entry.phase = "asked"
    throw error
  }
  entry.validating = undefined
  settle()
  if (entry.cancelRequested) return entries.retryTermination(entry)
  return commitAnswer(ports, entries, entry, answer)
}

async function commitAnswer(ports: BrokerPorts, entries: RequestEntries, entry: RequestEntry, answer: RequestAnswer): Promise<AnswerResult> {
  entry.phase = "committing"
  try {
    const grant = entry.pending.request.kind === "permission" ?
      grantToSave(entry.authority.value, entry.pending.request, answer) : undefined
    const events = await ports.persistAnswer(entry.pending, answer, false, grant)
    entries.finish(entry, answer)
    return { ok: true, events }
  } catch (error) {
    ports.reportOwnerFailure(entry.pending.sessionId, error)
    if (entry.cancelRequested) await entries.finishTermination(entry)
    else entry.phase = "asked"
    return requestRefusal("persistence")
  }
}
