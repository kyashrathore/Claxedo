import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { UiI18n } from "../context/i18n"

export function sessionRetryMessage(status: Extract<SessionStatus, { type: "retry" | "recovering" }>, i18n: UiI18n) {
  if (status.type === "recovering") return "Recovering ACP client..."
  if (status.message.includes("exceeded your current quota") && status.message.includes("gemini")) {
    return i18n.t("ui.sessionTurn.retry.geminiHot")
  }
  if (status.message.length > 80) return status.message.slice(0, 80) + "..."
  return status.message
}
