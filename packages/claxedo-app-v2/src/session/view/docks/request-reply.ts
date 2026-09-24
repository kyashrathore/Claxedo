import type { AgentRequestReply } from "@/server"
import { machine } from "@/lib/machine"
import { asAppError } from "@/composer"
import type { RequestReplyEvent, RequestReplyState } from "./model"
import { requestReplyTransition } from "./model"

export function createRequestReply(send: (reply: AgentRequestReply) => Promise<void>) {
  const state = machine<RequestReplyState, RequestReplyEvent>({ kind: "open" }, requestReplyTransition)
  const reply = async (value: AgentRequestReply) => {
    if (state.state().kind === "answering") return
    state.send({ type: "replyStarted" })
    try {
      await send(value)
    } catch (error) {
      state.send({ type: "replyRejected", error: asAppError(error) })
    }
  }
  return {
    state: state.state,
    answering: () => state.state().kind === "answering",
    error: () => {
      const current = state.state()
      return current.kind === "failed" ? current.error : undefined
    },
    reply,
    edited: () => state.send({ type: "edited" }),
  }
}

export type RequestReply = ReturnType<typeof createRequestReply>
