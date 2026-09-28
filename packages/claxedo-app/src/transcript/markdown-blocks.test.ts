import { describe, expect, test } from "bun:test"
import { Marked } from "marked"
import { transcriptMarkdownExtensions } from "@/ui/utils"
import { blockEntry, enhanceTextBlock, entryBase, initialResult, type RenderedBlock } from "./markdown-blocks"
import { getCachedMarkdown, touchCachedMarkdown } from "./markdown-cache"
import { project } from "./markdown-stream"

const parser = new Marked(...transcriptMarkdownExtensions)

const plain = [
  "# Plain reply",
  "A paragraph with `code` and a [link](https://example.com).",
  "- one\n- two",
  "| a | b |\n|---|---|\n| 1 | 2 |",
  "```ts\nconst x = 1\n```",
  "> quoted",
].join("\n\n")

const enhanced = ["# Enhanced reply", "The sum $$x^2$$ closes.", "1. step\n\n       indented code", "Last words."].join("\n\n")

async function open(text: string) {
  const projection = project(undefined, text, false)
  const initial = initialResult(text, undefined, projection, "reply")
  const parsed: string[] = []
  const blocks = await Promise.all(
    projection.blocks.map((block, index) =>
      block.mode === "code"
        ? initial?.blocks[index]
        : enhanceTextBlock({
            initial,
            owner: "reply",
            cacheKey: undefined,
            base: entryBase(text, undefined),
            text,
            index,
            block,
            mode: block.mode,
            parse: async (src) => {
              parsed.push(src)
              return parser.parse(src, { async: false })
            },
          }),
    ),
  )
  return { painted: initial?.blocks ?? [], enhanced: blocks, parsed }
}

function morphTarget(block: RenderedBlock | undefined) {
  return block && { key: block.key, hash: block.hash }
}

describe("a completed reply's markdown blocks", () => {
  test("the enhancement pass parses no block its first paint already rendered in full", async () => {
    const reply = await open(plain)

    expect(reply.parsed).toEqual([])
    expect(reply.enhanced.map(morphTarget)).toEqual(reply.painted.map(morphTarget))
  })

  test("the pass fills the block cache for every block its first paint rendered in full", async () => {
    const text = `${plain}\n\nCached opening.`
    await open(text)

    const blocks = project(undefined, text, false).blocks.flatMap((block, index) =>
      block.mode === "code" ? [] : [{ block, index }],
    )
    expect(blocks.length).toBeGreaterThan(0)
    for (const { block, index } of blocks)
      expect(getCachedMarkdown(blockEntry(entryBase(text, undefined)!, index, block.mode))?.raw).toBe(block.raw)
  })

  test("only a block with math is parsed again, and it is replaced once; a code block inside prose is final at first paint", async () => {
    const reply = await open(enhanced)

    expect(reply.parsed).toEqual(["The sum $$x^2$$ closes.\n\n"])
    const changed = reply.enhanced.flatMap((block, index) =>
      morphTarget(block)?.hash === morphTarget(reply.painted[index])?.hash ? [] : [index],
    )
    expect(changed).toEqual([1])
    expect(reply.enhanced.map((block) => block?.key)).toEqual(reply.painted.map((block) => block.key))
  })
})

describe("a part's first paint from the block cache", () => {
  test("a block the cache misses is rendered alone, and the part's other blocks keep their cached html", () => {
    const key = "part-cache-hit"
    const text = ["# Cached heading", "A cached paragraph.", "The tail that changed."].join("\n\n")
    const projection = project(undefined, text, false)
    const base = entryBase(text, key)!
    projection.blocks.slice(0, 2).forEach((block, index) => {
      touchCachedMarkdown(blockEntry(base, index, block.mode), { raw: block.raw, hash: `cached-${index}`, html: `<p>cached ${index}</p>` })
    })

    const painted = initialResult(text, key, projection, "reply").blocks

    expect(painted.map((block) => (block.mode === "code" ? undefined : block.html))).toEqual([
      "<p>cached 0</p>",
      "<p>cached 1</p>",
      expect.not.stringMatching(/^<p>cached/),
    ])
    expect(painted.map((block) => block.key)).toEqual(projection.blocks.map((block, index) => `reply:${key}:${index}:${block.mode}`))
  })
})
