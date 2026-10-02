/** A nullable text column's read: `null` kept as `null`, a string as itself, anything else `undefined`. */
export function nullable(input: unknown): string | null | undefined {
  if (input === null) return null
  return typeof input === "string" ? input : undefined
}

export function actorKind(input: unknown): "human" | "agent" | undefined {
  return input === "human" || input === "agent" ? input : undefined
}
