export type Declaration = { readonly property: string; readonly value: string; readonly line: number }

export type StyleRule = { readonly line: number; readonly selectors: readonly string[]; readonly declarations: Declaration[] }

type Scan = { readonly text: string; pos: number; readonly rules: StyleRule[] }

type Prelude = { readonly text: string; readonly start: number; readonly terminator: string | undefined }

const declarationBlocks = new Set(["font-face", "page", "property", "counter-style", "font-palette-values", "font-feature-values"])

export function parseStylesheet(source: string): StyleRule[] {
  const scan: Scan = { text: stripComments(source), pos: 0, rules: [] }
  parseBlock(scan, undefined, false)
  return scan.rules
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
}

export function lineOf(text: string, position: number): number {
  let line = 1
  for (let index = 0; index < position && index < text.length; index += 1) if (text[index] === "\n") line += 1
  return line
}

function parseBlock(scan: Scan, context: StyleRule | undefined, inKeyframes: boolean): void {
  while (scan.pos < scan.text.length) {
    skipSpace(scan)
    if (scan.pos >= scan.text.length) return
    if (scan.text[scan.pos] === "}") {
      scan.pos += 1
      return
    }
    const prelude = readPrelude(scan)
    if (prelude.terminator === "{") {
      scan.pos += 1
      parseNested(scan, prelude, context, inKeyframes)
      continue
    }
    if (prelude.terminator === ";") scan.pos += 1
    if (context && !inKeyframes && prelude.text.trim()) context.declarations.push(declarationOf(scan.text, prelude))
  }
}

function parseNested(scan: Scan, prelude: Prelude, context: StyleRule | undefined, inKeyframes: boolean): void {
  const text = prelude.text.trim()
  if (inKeyframes) return parseBlock(scan, undefined, true)
  const atRule = /^@([\w-]+)/.exec(text)
  if (atRule) {
    const name = atRule[1] ?? ""
    if (name.endsWith("keyframes")) return parseBlock(scan, undefined, true)
    return parseBlock(scan, declarationBlocks.has(name) ? undefined : context, false)
  }
  const rule: StyleRule = { line: lineOf(scan.text, prelude.start), selectors: splitTopLevel(text, ","), declarations: [] }
  scan.rules.push(rule)
  parseBlock(scan, rule, false)
}

function skipSpace(scan: Scan): void {
  while (scan.pos < scan.text.length && /\s/.test(scan.text[scan.pos] ?? "")) scan.pos += 1
}

function readPrelude(scan: Scan): Prelude {
  const start = scan.pos
  let depth = 0
  let quote: string | undefined
  while (scan.pos < scan.text.length) {
    const char = scan.text[scan.pos] ?? ""
    if (quote) {
      if (char === "\\") scan.pos += 1
      else if (char === quote) quote = undefined
    } else if (char === '"' || char === "'") quote = char
    else if (char === "(" || char === "[") depth += 1
    else if (char === ")" || char === "]") depth = Math.max(0, depth - 1)
    else if (depth === 0 && (char === "{" || char === ";" || char === "}")) {
      return { text: scan.text.slice(start, scan.pos), start, terminator: char }
    }
    scan.pos += 1
  }
  return { text: scan.text.slice(start), start, terminator: undefined }
}

function declarationOf(text: string, prelude: Prelude): Declaration {
  const colon = prelude.text.indexOf(":")
  const property = (colon < 0 ? prelude.text : prelude.text.slice(0, colon)).trim().toLowerCase()
  const value = colon < 0 ? "" : prelude.text.slice(colon + 1).trim()
  return { property, value, line: lineOf(text, prelude.start + (prelude.text.length - prelude.text.trimStart().length)) }
}

export function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = []
  let current = ""
  let depth = 0
  let quote: string | undefined
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = undefined
    } else if (char === '"' || char === "'") quote = char
    else if (char === "(" || char === "[") depth += 1
    else if (char === ")" || char === "]") depth = Math.max(0, depth - 1)
    else if (depth === 0 && char === separator) {
      parts.push(current.trim())
      current = ""
      continue
    }
    current += char
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}
