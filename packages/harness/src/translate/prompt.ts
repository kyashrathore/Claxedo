import type { TurnInput } from "../contract"

export function flattenTurnPrompt(turn: TurnInput, options: { separator: "\n" | "\n\n"; system: "prefix" | "channel" }): string {
  const system = options.system === "prefix" ? turn.system : undefined
  const texts = turn.prompt.parts.flatMap((part) => part.type === "text" ? [part.text] : [])
  if (options.separator === "\n") return [system, texts.join("\n")].filter(Boolean).join("\n\n")
  return [system, ...texts].filter(Boolean).join("\n\n")
}

export function inlineDataUrl(url: string, options: { imageOnly: boolean; strictBase64: boolean }):
  { mimeType: string; data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url)
  if (!match?.[1] || !match[2]) return undefined
  if (options.imageOnly && !match[1].startsWith("image/")) return undefined
  if (options.strictBase64 && !/^[A-Za-z0-9+/=]+$/.test(match[2])) return undefined
  return { mimeType: match[1], data: match[2] }
}

export function isInlineImageUrl(url: string): boolean { return url.startsWith("data:image/") }
