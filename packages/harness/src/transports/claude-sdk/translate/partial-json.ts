import { asRecord } from "@claxedo/helpers/guards"

type Frame = {
  kind: "{" | "["
  expectKey: boolean
  cut: number
}

type Scan = {
  frames: Frame[]
  inString: boolean
  stringIsKey: boolean
  escapeStart: number
  unicodeRemaining: number
  bareTokenStart: number
}

function stringCharacter(scan: Scan, ch: string, i: number): void {
  if (scan.unicodeRemaining > 0) {
    scan.unicodeRemaining -= 1
    if (scan.unicodeRemaining === 0) scan.escapeStart = -1
    return
  }
  if (scan.escapeStart >= 0) {
    if (ch === "u") scan.unicodeRemaining = 4
    else scan.escapeStart = -1
    return
  }
  if (ch === "\\") scan.escapeStart = i
  else if (ch === '"') {
    scan.inString = false
    const top = scan.frames.at(-1)
    if (top && !scan.stringIsKey) top.cut = i + 1
  }
  return
}

function structuralCharacter(scan: Scan, ch: string, i: number): void {
  const top = scan.frames.at(-1)
  switch (ch) {
    case '"':
      scan.inString = true
      scan.stringIsKey = top?.kind === "{" && top.expectKey
      break
    case "{":
      scan.frames.push({ kind: "{", expectKey: true, cut: i + 1 })
      break
    case "[":
      scan.frames.push({ kind: "[", expectKey: false, cut: i + 1 })
      break
    case "}":
    case "]": {
      scan.frames.pop()
      const parent = scan.frames.at(-1)
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
      if (!/\s/.test(ch)) scan.bareTokenStart = i
  }
}

function scanPartial(partial: string): Scan {
  const scan: Scan = {
    frames: [],
    inString: false,
    stringIsKey: false,
    escapeStart: -1,
    unicodeRemaining: 0,
    bareTokenStart: -1,
  }
  for (let i = 0; i < partial.length; i += 1) {
    const ch = partial.charAt(i)
    if (scan.inString) {
      stringCharacter(scan, ch, i)
      continue
    }
    if (scan.bareTokenStart >= 0 && !/[\s,\]}]/.test(ch)) continue
    if (scan.bareTokenStart >= 0) {
      scan.bareTokenStart = -1
      const top = scan.frames.at(-1)
      if (top) top.cut = i
    }
    structuralCharacter(scan, ch, i)
  }
  return scan
}

export function readPartialJsonRecord(partial: string): Record<string, unknown> | undefined {
  const complete = parseJsonRecord(partial)
  if (complete) return complete

  const scan = scanPartial(partial)

  const top = scan.frames.at(-1)
  if (!top) return undefined
  let head: string
  if (scan.inString && !scan.stringIsKey) {
    head = `${scan.escapeStart >= 0 ? partial.slice(0, scan.escapeStart) : partial}"`
  } else {
    head = partial.slice(0, top.cut)
  }
  const closers = scan.frames
    .map((frame) => (frame.kind === "{" ? "}" : "]"))
    .reverse()
    .join("")
  return parseJsonRecord(`${head}${closers}`)
}

export function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(value))
  } catch {
    return undefined
  }
}
