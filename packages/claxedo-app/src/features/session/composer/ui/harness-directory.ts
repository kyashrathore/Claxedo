export function promptHarnessDirectory(input: {
  sdkDirectory: string
  sessionDirectory?: string
  sessionId?: string
}) {
  if (!input.sessionId || input.sessionId === "new") return input.sdkDirectory
  return input.sessionDirectory ?? input.sdkDirectory
}
