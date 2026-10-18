import { messagePartUpdated, messageUpdated } from "../../../session-core/src/projection/presentation-events"
import { openRuntimeStore } from "../../../workspace-runtime/src/store-file"
import { partPayloadBytes, type CorpusMessage, type CorpusSession, type CorpusTurn } from "./corpus"

type RuntimeStore = ReturnType<typeof openRuntimeStore>

export type StoredHistory = { messageCount: number; transcriptBytes: number }

function appendMessage(store: RuntimeStore, message: CorpusMessage) {
  const { info } = message
  store.appendEvent({ sessionId: info.sessionID, payload: messageUpdated(info) })
  for (const { part, time } of message.parts) {
    store.appendEvent({ sessionId: info.sessionID, payload: messagePartUpdated(part, time) })
  }
}

function corpusPromptModel(info: CorpusMessage["info"]) {
  const { model } = info
  return model?.providerID && model.modelID ? { providerID: model.providerID, modelID: model.modelID } : undefined
}

function recordTurn(store: RuntimeStore, sessionId: string, turn: CorpusTurn) {
  const first = turn.replies[0]
  if (!first) throw new Error(`Claxedo turn ${turn.user.info.id} has no reply`)
  const leaseId = store.acquireTurnLease(sessionId)
  if (!leaseId) throw new Error(`Claxedo session ${sessionId} refused a turn lease`)
  try {
    store.updateSession(sessionId, { humanTurn: true })
    const model = corpusPromptModel(turn.user.info)
    store.startTurn({
      sessionId,
      userMessageId: turn.user.info.id,
      assistantMessageId: first.info.id,
      ...(typeof turn.user.info.agent === "string" ? { agent: turn.user.info.agent } : {}),
      ...(model ? { model } : {}),
      parts: [],
      humanTurn: true,
    })
    appendMessage(store, turn.user)
    for (const reply of turn.replies) appendMessage(store, reply)
    const completed = turn.replies.at(-1)!.info.time?.completed
    store.finishTurn({
      sessionId,
      assistantMessageId: first.info.id,
      outcome: { status: "completed", completedAt: completed ?? Date.now() },
      leaseId,
    })
  } finally {
    store.releaseTurnLease(sessionId, leaseId)
  }
}

export function importHistory(storeRoot: string, sessions: CorpusSession[]) {
  const store = openRuntimeStore(storeRoot)
  try {
    for (const session of sessions) {
      if (!store.getSession(session.sessionId)) throw new Error(`Claxedo has no session row for ${session.sessionId}`)
      for (const turn of session.turns) recordTurn(store, session.sessionId, turn)
    }
    store.flush()
  } finally {
    store.close()
  }
}

export function readStoredHistory(storeRoot: string, sessionIds: string[]): StoredHistory {
  const store = openRuntimeStore(storeRoot)
  try {
    let messageCount = 0
    let transcriptBytes = 0
    for (const sessionId of sessionIds) {
      const messages = store.getMessages(sessionId)
      messageCount += messages.length
      for (const message of messages) for (const part of message.parts) transcriptBytes += partPayloadBytes(part)
    }
    return { messageCount, transcriptBytes }
  } finally {
    store.close()
  }
}
