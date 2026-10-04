import type { Draft, ImageMark, Prompt, PromptPart } from "./model"
import { emptyPrompt, promptText } from "./model"

export function withPart(draft: Draft, part: PromptPart, cursor?: number): Pick<Draft, "prompt" | "cursor"> {
  const at = cursor ?? draft.cursor ?? promptText(draft.prompt).length
  return { prompt: insertPart(draft.prompt, at, part), cursor: at + ("content" in part ? part.content.length : 0) }
}

export function withImageMarks(prompt: Prompt, id: string, marks: ImageMark[]): Prompt {
  return prompt.map((part) => {
    if (part.type !== "image" || part.id !== id) return part
    if (marks.length > 0) return { ...part, marks }
    const { marks: _removed, ...rest } = part
    return rest
  })
}

function insertPart(prompt: Prompt, at: number, part: PromptPart): Prompt {
  if (part.type === "image") return [...prompt, part]
  const parts: Prompt = []
  let position = 0
  let inserted = false
  for (const existing of prompt) {
    if (existing.type === "image") {
      parts.push(existing)
      continue
    }
    const start = position
    position += existing.content.length
    if (!inserted && existing.type === "text" && at >= start && at <= position) {
      const offset = at - start
      if (part.type === "text") {
        parts.push({ ...existing, content: existing.content.slice(0, offset) + part.content + existing.content.slice(offset) })
      } else {
        const before = existing.content.slice(0, offset)
        const after = existing.content.slice(offset)
        if (before) parts.push({ type: "text", content: before, start: 0, end: 0 })
        parts.push(part, { type: "text", content: after || " ", start: 0, end: 0 })
      }
      inserted = true
      continue
    }
    if (!inserted && at <= start) {
      parts.push(part.type === "text" ? part : part, existing)
      inserted = true
      continue
    }
    parts.push(existing)
  }
  if (!inserted) parts.push(part)
  return withOffsets(parts.length ? parts : emptyPrompt())
}

export function withOffsets(prompt: Prompt): Prompt {
  let offset = 0
  return prompt.map((part) => {
    if (part.type === "image") return part
    const next = { ...part, start: offset, end: offset + part.content.length }
    offset = next.end
    return next
  })
}
