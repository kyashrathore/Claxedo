const sessionArgumentMeta = "io.claxedo/session-argument"

export function withMcpSessionContext(
  definition: { _meta?: Record<string, unknown> },
  args: Record<string, unknown>,
  sessionID: string,
) {
  const argument = definition._meta?.[sessionArgumentMeta]
  if (typeof argument !== "string" || !argument.trim() || args[argument] !== undefined) return args
  return { ...args, [argument]: sessionID }
}
