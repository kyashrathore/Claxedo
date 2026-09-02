export type GoalComposerIntent =
  | { kind: "none" }
  | { kind: "arm" }
  | { kind: "submit"; objective: string }

export function resolveGoalComposerIntent(input: {
  text: string
  armed: boolean
  mode: "normal" | "shell"
}): GoalComposerIntent {
  if (input.mode !== "normal") return { kind: "none" }
  const trimmed = input.text.trim()
  const match = /^\/goal(?:\s+([\s\S]*))?$/i.exec(trimmed)
  if (match) {
    const objective = match[1]?.trim()
    return objective ? { kind: "submit", objective } : { kind: "arm" }
  }
  if (input.armed && trimmed) return { kind: "submit", objective: trimmed }
  return { kind: "none" }
}
