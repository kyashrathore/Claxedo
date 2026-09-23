/** Map the workspace runtime's canonical lifecycle vocabulary to UI status. */
export function terminalAgentStatusFromEventType(eventType: unknown) {
  if (eventType === "Busy") return "working"
  if (eventType === "Idle") return "idle"
  if (eventType === "UserActionRequired" || eventType === "Error") return "permission"
  return undefined
}
