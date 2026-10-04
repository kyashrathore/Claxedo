export function readPartText(part: { text?: string }): string {
  return (part.text ?? "").trim()
}

export function clampLabel(value: string, max = 72) {
  const flat = value.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
