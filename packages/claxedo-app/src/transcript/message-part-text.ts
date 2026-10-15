export function readPartText(part: { text?: string }): string {
  return (part.text ?? "").trim()
}

export type AssistantCopy = { readonly partId: string; readonly text: () => string }

export function responseText(parts: readonly { text?: string }[]): string {
  return parts.map(readPartText).filter(Boolean).join("\n\n")
}

export function clampLabel(value: string, max = 72) {
  const flat = value.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
