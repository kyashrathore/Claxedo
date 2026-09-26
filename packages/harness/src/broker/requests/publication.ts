import type { PendingRequest } from "../../contract/broker"
import type { BrokerPorts } from "../ports"
import { elicitationQuestion } from "./elicitation-question"
import { requestKey } from "./request-key"

export async function publishAsked(ports: BrokerPorts, pending: PendingRequest, connectionId: string): Promise<void> {
  const request = pending.request
  const key = requestKey(pending.sessionId, request.requestId)
  const id = `question.asked:${key}`
  if (request.kind === "permission") {
    await ports.publish({ id: `permission.asked:${key}`, type: "permission.asked", properties: request.permission }, pending)
  } else if (request.kind === "question") {
    await ports.publish({ id, type: "question.asked", properties: request.question }, pending)
  } else {
    await ports.publish({ id, type: "question.asked", properties: elicitationQuestion(pending, connectionId) }, pending)
  }
}
