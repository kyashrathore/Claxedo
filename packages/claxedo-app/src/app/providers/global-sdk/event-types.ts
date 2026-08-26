const claxedoExtensionEventTypes: ReadonlySet<string> = new Set([
  "message.completed",
  "session.agent",
  "session.config",
  "session.usage",
  "runtime.diagnostic",
])

export function isOpenCodeSdkEventType(type: string) {
  return !claxedoExtensionEventTypes.has(type)
}
