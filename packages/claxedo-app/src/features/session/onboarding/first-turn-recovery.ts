export type FirstTurnRecoveryClass = "credential" | "harness" | "model" | "workspace"
export type FirstTurnMessage =
  | { id: string; role: "user"; time: { created: number } }
  | { id: string; role: "assistant"; parentID: string; time: { created: number; completed?: number }; error?: unknown }

const recoveries = {
  credential: { kind: "credential", title: "Reconnect your AI provider", description: "The provider rejected the credential used for this first turn.", label: "Reconnect provider" },
  harness: { kind: "harness", title: "Restart the harness", description: "The selected agent harness could not run this turn.", label: "Restart harness" },
  model: { kind: "model", title: "Try another model", description: "The selected model could not serve this first turn.", label: "Switch model and retry" },
  workspace: { kind: "workspace", title: "Retry the workspace", description: "The project workspace was not ready to run this turn.", label: "Retry workspace" },
} as const satisfies Record<FirstTurnRecoveryClass, { kind: FirstTurnRecoveryClass; title: string; description: string; label: string }>

export function shouldShowStarterPrompts(input: { completedTurns: number; sentTurns: number }) {
  return input.completedTurns === 0 && input.sentTurns === 0
}

export function firstTurnRecovery(kind: FirstTurnRecoveryClass) {
  return recoveries[kind]
}

export function firstTurnRecoveryClass(error: unknown): FirstTurnRecoveryClass {
  const data = record(record(error)?.data)
  const classified = data?.firstTurnErrorClass
  if (classified === "credential" || classified === "harness" || classified === "model" || classified === "workspace") return classified
  const message = typeof data?.message === "string" ? data.message : ""
  if (/\b(401|403|unauthori[sz]ed|api[ _-]?key|oauth|token|credential|authentication|billing)\b/i.test(message)) return "credential"
  if (/(harness|adapter|acp|agent process|spawn|executable|binary|capabilit(?:y|ies))/i.test(message)) return "harness"
  if (/(model|provider\/model|model id|deployment)/i.test(message)) return "model"
  return "workspace"
}

export function firstTurnOutcome(messages: FirstTurnMessage[]) {
  const first = messages.find((message): message is Extract<FirstTurnMessage, { role: "user" }> => message.role === "user")
  if (!first) return
  const assistant = messages.find((message): message is Extract<FirstTurnMessage, { role: "assistant" }> =>
    message.role === "assistant" && message.parentID === first.id,
  )
  if (!assistant || (typeof assistant.time.completed !== "number" && !assistant.error)) return
  if (!assistant.error) return { name: "first_turn_ok" as const }
  return { name: "first_turn_failed" as const, class: firstTurnRecoveryClass(assistant.error) }
}

export function firstTurnFunnelEvents(messages: FirstTurnMessage[], cloud: boolean) {
  const outcome = firstTurnOutcome(messages)
  if (!outcome) return []
  if (outcome.name !== "first_turn_ok" || !cloud) return [outcome]
  return [outcome, { name: "first_cloud_turn_ok" as const }]
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}
