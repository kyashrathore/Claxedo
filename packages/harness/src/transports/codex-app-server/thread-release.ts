import type { Deadline } from "../../contract"
import type { Entry } from "./entry"
import { CodexNoActiveTurnError } from "./errors"

async function interruptChildren(entry: Entry): Promise<void> {
  for (const child of entry.children.running()) {
    try { await entry.rpc.request("turn/interrupt", { threadId: child.threadId, turnId: child.turnId }) }
    catch (error) { if (!(error instanceof CodexNoActiveTurnError)) throw error }
  }
}

export async function releaseCodexThreads(entry: Entry, deadline: Deadline): Promise<void> {
  if (entry.rpc.alive) {
    const turnId = entry.turn?.id ?? entry.providerTurn?.id
    if (turnId) await entry.terminals.stop(turnId, deadline)
    await interruptChildren(entry)
    await entry.terminals.clear(deadline)
  }
  await entry.rpc.archive(entry.session.binding.upstreamSessionId)
}
