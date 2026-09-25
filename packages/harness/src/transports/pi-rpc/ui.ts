import { requestQuestionAnswers, questionRequest, type RoutedEvent, type TurnBroker } from "../../contract"
import type { PiMessage, PiRpc } from "./rpc"

const dialogs = ["select", "confirm", "input", "editor"]
const notices = ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]

export function piUiEvent(message: PiMessage): RoutedEvent | undefined {
  if (message.type !== "extension_ui_request" || typeof message.method !== "string" || !notices.includes(message.method)) return undefined
  const detail = message.method === "setStatus" ? message.statusText
    : message.method === "setWidget" ? message.widgetLines
    : message.method === "setTitle" ? message.title
    : message.method === "set_editor_text" ? message.text : message.message
  return {
    event: {
      type: "harness-notice", code: `pi.extension_ui.${message.method}`,
      message: typeof detail === "string" ? detail : JSON.stringify(detail ?? ""),
      severity: message.notifyType === "error" ? "error" : message.notifyType === "warning" ? "warn" : "info",
      details: { method: message.method, id: message.id,
        ...(message.method === "setStatus" ? { statusKey: message.statusKey, statusText: message.statusText } : {}),
        ...(message.method === "setWidget" ? { widgetKey: message.widgetKey, widgetLines: message.widgetLines, widgetPlacement: message.widgetPlacement } : {}),
        ...(message.method === "setTitle" ? { title: message.title } : {}),
        ...(message.method === "set_editor_text" ? { text: message.text } : {}),
        ...(message.method === "notify" ? { notifyType: message.notifyType, notification: message.message } : {}),
      },
    },
      source: { dir: "in", method: `extension_ui.${message.method}`, requestId: typeof message.id === "string" ? message.id : "" },
  }
}

export async function answerPiDialog(message: PiMessage, rpc: PiRpc, broker: TurnBroker, sessionId: string, now: number): Promise<void> {
  if (message.type !== "extension_ui_request" || typeof message.method !== "string" || !dialogs.includes(message.method)) return
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
  })))
  if (!answers) {
    rpc.send({ type: "extension_ui_response", id: message.id, cancelled: true })
    return
  }
  const value = answers[0]?.[0]
  if (message.method === "confirm") rpc.send({ type: "extension_ui_response", id: message.id, confirmed: value === "Yes" })
  else if (typeof value === "string") rpc.send({ type: "extension_ui_response", id: message.id, value })
  else rpc.send({ type: "extension_ui_response", id: message.id, cancelled: true })
}
