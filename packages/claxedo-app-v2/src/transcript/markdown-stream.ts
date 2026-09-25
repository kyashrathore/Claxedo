import { marked, type Token } from "marked"
import remend from "remend"

export type Block = {
  raw: string
  src: string
  mode: "full" | "live" | "code"
  language?: string
  complete?: boolean
}

export type Projection = {
  text: string
  blocks: Block[]
}

function refs(text: string) {
  if (!text.includes("]:")) return false
  return /^[ \t]{0,3}\[[^\]]+\]:[ \t]*(?:\S+|\r?\n[ \t]+\S+)/m.test(text)
}

function definitionSuffix(links: Record<string, { href: string | null; title?: string | null }>): string {
  const entries = Object.entries(links)
  if (entries.length === 0) return ""
  return entries
    .map(([id, def]) => {
      const title = def.title ? ` "${def.title.replaceAll('"', '\\"')}"` : ""
      return `\n\n[${id}]: ${def.href ?? ""}${title}`
    })
    .join("")
}

function withDefinitions(blocks: Block[], defs: string): Block[] {
  if (!defs) return blocks
  return blocks.map((block) => (block.mode === "code" ? block : { ...block, src: `${block.src}${defs}` }))
}

function language(value: string | undefined) {
  return value?.trim().split(/\s+/, 1)[0] || undefined
}

function codeBlock(token: Token): { text: string; lang: string | undefined } | undefined {
  if (token.type !== "code") return undefined
  const text: unknown = token.text
  const lang: unknown = token.lang
  return {
    text: typeof text === "string" ? text : token.raw,
    lang: typeof lang === "string" ? lang : undefined,
  }
}

function openCode(raw: string) {
  const newline = raw.indexOf("\n")
  return newline < 0 ? "" : raw.slice(newline + 1)
}

function open(raw: string) {
  const match = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/)
  if (!match) return false
  const mark = match[1]
  if (!mark) return false
  const char = mark[0]
  const size = mark.length
  const last = raw.trimEnd().split("\n").at(-1)?.trim() ?? ""
  return !new RegExp(`^[\\t ]{0,3}${char}{${size},}[\\t ]*$`).test(last)
}

function closesFence(raw: string, suffix: string) {
  const mark = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/)?.[1]
  if (!mark) return suffix.includes("```") || suffix.includes("~~~")
  return `${raw.slice(-(mark.length - 1))}${suffix}`.includes(mark)
}

function heal(text: string) {
  return remend(text, { linkMode: "text-only" })
}

function complete(text: string) {
  const tokens = marked.lexer(text)
  const defs = refs(text) ? definitionSuffix(tokens.links ?? {}) : ""
  return withDefinitions(tokens.reduce<Block[]>((result, token) => {
    if (token.type === "space") {
      const previous = result.at(-1)
      if (!previous) return result
      previous.raw += token.raw
      if (previous.mode === "full") previous.src += token.raw
      return result
    }
    const fence = codeBlock(token)
    if (fence) {
      result.push({
        raw: token.raw,
        src: fence.text,
        mode: "code",
        language: language(fence.lang),
        complete: true,
      })
      return result
    }
    result.push({ raw: token.raw, src: token.raw, mode: "full" })
    return result
  }, []), defs)
}

export function stream(text: string, live: boolean): Block[] {
  if (!live) return complete(text)
  const tokens = marked.lexer(text)
  const defs = refs(text) ? definitionSuffix(tokens.links ?? {}) : ""
  const tail = tokens.findLastIndex((token) => token.type !== "space")
  if (tail < 0) return [{ raw: text, src: heal(text), mode: "live" }] satisfies Block[]
  const last = tokens[tail]
  if (!last) return [{ raw: text, src: heal(text), mode: "live" }] satisfies Block[]

  const result: Block[] = []
  for (let index = 0; index < tail; index++) {
    const token = tokens[index]
    if (!token || token.type === "space") continue
    let raw = token.raw
    while (tokens[index + 1]?.type === "space" && index + 1 < tail) raw += tokens[++index].raw
    const fence = codeBlock(token)
    if (fence) {
      result.push({ raw, src: fence.text, mode: "code", language: language(fence.lang), complete: true })
      continue
    }
    result.push({ raw, src: raw, mode: "full" })
  }

  const raw = tokens
    .slice(tail)
    .map((token) => token.raw)
    .join("")
  const fence = codeBlock(last)
  if (!fence) {
    return withDefinitions([...result, { raw, src: heal(raw), mode: "live" }], defs)
  }

  if (!open(last.raw))
    return withDefinitions(
      [...result, { raw, src: fence.text, mode: "code", language: language(fence.lang), complete: true }],
      defs,
    )
  return withDefinitions(
    [...result, { raw, src: openCode(last.raw), mode: "code", language: language(fence.lang) }],
    defs,
  )
}

export function canReusePendingBlock(current: Pick<Block, "mode" | "raw"> | undefined, next: Block) {
  if (!current) return false
  if (next.mode === "code") return next.raw.startsWith(current.raw)
  if (current.mode === "live" && (next.mode === "live" || next.mode === "full")) return next.raw.startsWith(current.raw)
  if (current.mode !== next.mode) return false
  return current.raw === next.raw
}

function extend(previous: Projection, text: string): Block[] {
  const open = previous.blocks.at(-1)
  if (!open || refs(text) || !previous.text.endsWith(open.raw)) return stream(text, true)
  const start = previous.text.length - open.raw.length
  return [...previous.blocks.slice(0, -1), ...stream(text.slice(start), true)]
}

export function project(previous: Projection | undefined, text: string, live: boolean): Projection {
  if (!live || !previous || !text.startsWith(previous.text)) return { text, blocks: stream(text, live) }
  const tail = previous.blocks.at(-1)
  const suffix = text.slice(previous.text.length)
  if (!suffix) return { text, blocks: stream(text, live) }
  if (tail?.mode !== "code" || tail.complete || closesFence(tail.raw, suffix)) return { text, blocks: extend(previous, text) }
  return {
    text,
    blocks: [
      ...previous.blocks.slice(0, -1),
      {
        ...tail,
        raw: tail.raw + suffix,
        src: tail.src + suffix,
      },
    ],
  }
}
