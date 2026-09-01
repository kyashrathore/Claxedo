import { marked, type Tokens } from "marked"
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

/**
 * Reference-link support without collapsing the block projection.
 *
 * Blocks are parsed independently, so a `[docs][1]` use in one block cannot
 * see a `[1]: url` definition that lives in another (or arrives later in the
 * stream). Serializing the lexer's collected definitions and appending them
 * to every prose block's parse source resolves the links per block, while
 * the definitions themselves render as nothing. This is what lets a long
 * document keep its frozen prefix when a definition appears: collapsing the
 * whole text into one live blob re-renders the entire transcript as raw
 * healed text on every delta ("one giant paragraph"), then reflows it at
 * completion.
 */
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
    if (token.type === "code") {
      const code = token as Tokens.Code
      result.push({
        raw: token.raw,
        src: code.text,
        mode: "code",
        language: language(code.lang),
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
    while (tokens[index + 1]?.type === "space" && index + 1 < tail) raw += tokens[++index]!.raw
    if (token.type === "code") {
      const code = token as Tokens.Code
      result.push({ raw, src: code.text, mode: "code", language: language(code.lang), complete: true })
      continue
    }
    result.push({ raw, src: raw, mode: "full" })
  }

  const raw = tokens
    .slice(tail)
    .map((token) => token.raw)
    .join("")
  if (last.type !== "code") return withDefinitions([...result, { raw, src: heal(raw), mode: "live" }], defs)

  const code = last as Tokens.Code
  if (!open(code.raw))
    return withDefinitions(
      [...result, { raw, src: code.text, mode: "code", language: language(code.lang), complete: true }],
      defs,
    )
  return withDefinitions(
    [...result, { raw, src: openCode(code.raw), mode: "code", language: language(code.lang) }],
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

export function project(previous: Projection | undefined, text: string, live: boolean): Projection {
  // TODO: streaming `Run the `config` then `# User Guide` / `#userconfig` still
  // wraps the heading in healed inline code.
  // Tried and reverted: reuse frozenPrefix (all-but-last blocks) plus close the
  // unclosed tick before `# `. That caused a duplicate prose line until complete().
  // (Reference definitions no longer collapse the projection: `stream` keeps
  // the frozen blocks and resolves refs per block via `definitionSuffix`.)
  if (!live || !previous || !text.startsWith(previous.text)) return { text, blocks: stream(text, live) }
  const tail = previous.blocks.at(-1)
  const suffix = text.slice(previous.text.length)
  if (!suffix || tail?.mode !== "code" || tail.complete || closesFence(tail.raw, suffix))
    return { text, blocks: stream(text, live) }
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
