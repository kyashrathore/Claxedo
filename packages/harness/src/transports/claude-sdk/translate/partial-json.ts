import { asRecord } from "@claxedo/helpers/guards"

type Frame = {
  kind: "{" | "["
  expectKey: boolean
  cut: number
}

export function readPartialJsonRecord(partial: string): Record<string, unknown> | undefined {
  const complete = parseJsonRecord(partial)
  if (complete) return complete

  const frames: Frame[] = []
  let inString = false
  let stringIsKey = false
  let escapeStart = -1
  let unicodeRemaining = 0
  let bareTokenStart = -1

  for (let i = 0; i < partial.length; i += 1) {
    const ch = partial.charAt(i)
    if (inString) {
      if (unicodeRemaining > 0) {
        unicodeRemaining -= 1
        if (unicodeRemaining === 0) escapeStart = -1
        continue
      }
      if (escapeStart >= 0) {
        if (ch === "u") unicodeRemaining = 4
        else escapeStart = -1
        continue
      }
      if (ch === "\\") escapeStart = i
      else if (ch === '"') {
        inString = false
        const top = frames.at(-1)
        if (top && !stringIsKey) top.cut = i + 1
      }
      continue
    }
    if (bareTokenStart >= 0 && !/[\s,\]}]/.test(ch)) continue
    if (bareTokenStart >= 0) {
      bareTokenStart = -1
      const top = frames.at(-1)
      if (top) top.cut = i
    }
    const top = frames.at(-1)
    switch (ch) {
      case '"':
        inString = true
        stringIsKey = top?.kind === "{" && top.expectKey
        break
      case "{":
        frames.push({ kind: "{", expectKey: true, cut: i + 1 })
        break
      case "[":
        frames.push({ kind: "[", expectKey: false, cut: i + 1 })
        break
      case "}":
      case "]": {
        frames.pop()
        const parent = frames.at(-1)
        if (parent) parent.cut = i + 1
        break
      }
      case ":":
        if (top) top.expectKey = false
        break
      case ",":
        if (top) {
          top.cut = i
          top.expectKey = top.kind === "{"
        }
        break
      default:
        if (!/\s/.test(ch)) bareTokenStart = i
    }
  }

  const top = frames.at(-1)
  if (!top) return undefined
  let head: string
  if (inString && !stringIsKey) {
    head = `${escapeStart >= 0 ? partial.slice(0, escapeStart) : partial}"`
  } else {
    head = partial.slice(0, top.cut)
  }
  const closers = frames.map((frame) => (frame.kind === "{" ? "}" : "]")).reverse().join("")
  return parseJsonRecord(`${head}${closers}`)
}

/** A complete JSON object, or `undefined` for anything else — including a document still streaming. */
export function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(value))
  } catch {
    return undefined
  }
}
