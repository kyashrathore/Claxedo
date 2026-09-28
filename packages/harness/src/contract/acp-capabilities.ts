import type { TransportCapabilities } from "./capabilities"

export const acpDeclaredCapabilities = {
  requests: { permissions: true, questions: false, elicitation: true },
  todos: true,
  history: "store",
} as const satisfies Pick<TransportCapabilities, "requests" | "todos" | "history">

export const acpOfferedOperations = ["config", "commands"] as const
