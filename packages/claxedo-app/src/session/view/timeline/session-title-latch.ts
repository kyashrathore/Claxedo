export type LatchedSessionTitle = { sessionKey: string; title: string }

export function latchSessionTitle(
  previous: LatchedSessionTitle | undefined,
  input: { sessionKey: string | undefined; title: string | undefined },
): LatchedSessionTitle | undefined {
  if (!input.sessionKey) return undefined
  const prior = previous?.sessionKey === input.sessionKey ? previous : undefined
  const title = normalizedTitle(input.title)
  if (!title) return prior
  if (prior?.title === title) return prior
  return { sessionKey: input.sessionKey, title }
}

function normalizedTitle(title: string | null | undefined) {
  const value = title?.replace(/\s+/g, " ").trim()
  return value || undefined
}
