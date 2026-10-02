import { requestQuestionAnswers, questionRequest, type RoutedEvent, type TurnBroker } from "../../contract"
import type { PiMessage, PiRpc } from "./rpc"
import { own } from "../../translate/value"

const dialogs = ["select", "confirm", "input", "editor"]
const notices: Record<string, { content: string; fields: Record<string, string> }> = {
  notify: { content: "message", fields: { notifyType: "notifyType", notification: "message" } },
  setStatus: { content: "statusText", fields: { statusKey: "statusKey", statusText: "statusText" } },
  setWidget: { content: "widgetLines", fields: { widgetKey: "widgetKey", widgetLines: "widgetLines", widgetPlacement: "widgetPlacement" } },
  setTitle: { content: "title", fields: { title: "title" } },
  set_editor_text: { content: "text", fields: { text: "text" } },
}

function noticeSeverity(message: PiMessage) {
  if (message.method !== "notify") return "debug"
  return message.notifyType === "error" ? "error" : message.notifyType === "warning" ? "warn" : "info"
}

export function piUiEvent(message: PiMessage): RoutedEvent | undefined {
  if (message.type !== "extension_ui_request" || typeof message.method !== "string") return undefined
  const notice = own(notices, message.method)
  if (!notice) return undefined
  const detail = message[notice.content]
  return {
    event: {
      type: "harness-notice", code: `pi.extension_ui.${message.method}`,
      message: typeof detail === "string" ? detail : JSON.stringify(detail ?? ""),
      severity: noticeSeverity(message),
      details: { method: message.method, id: message.id,
        ...Object.fromEntries(Object.entries(notice.fields).map(([field, source]) => [field, message[source]])) },
    },
      source: { dir: "in", method: `extension_ui.${message.method}`, requestId: typeof message.id === "string" ? message.id : "" },
  }
}

export function piDialog(message: PiMessage): boolean {
  return message.type === "extension_ui_request" && typeof message.method === "string" && dialogs.includes(message.method)
}

export async function answerPiDialog(message: PiMessage, rpc: PiRpc, broker: Pick<TurnBroker, "ask">, sessionId: string, now: number,
  signal: AbortSignal): Promise<void> {
  if (typeof message.id !== "string") throw new Error("Pi extension dialog lacks an id")
  const choices = Array.isArray(message.options) ? message.options.filter((item): item is string => typeof item === "string") : undefined
  const options = message.method === "confirm" ? ["Yes", "No"] : choices
  const timeout = typeof message.timeout === "number" && message.timeout >= 0 ? now + message.timeout : undefined
  const questionText = [message.title, message.message].find((value): value is string => typeof value === "string") ?? "Pi extension"
  const answers = requestQuestionAnswers(await broker.ask(questionRequest({
    requestId: message.id, sessionId, expiresAt: timeout,
    questions: [{
      header: "Pi", question: questionText,
      options: options?.map((label) => ({ label, description: "" })) ?? [],
      custom: message.method === "input" || message.method === "editor",
    }],
  }), { signal }))
  const value = answers?.[0]?.[0]
  if (answers && message.method === "confirm") rpc.send({ type: "extension_ui_response", id: message.id, confirmed: value === "Yes" })
  else if (typeof value === "string") rpc.send({ type: "extension_ui_response", id: message.id, value })
  else rpc.send({ type: "extension_ui_response", id: message.id, cancelled: true })
}
