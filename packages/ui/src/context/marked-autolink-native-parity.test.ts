import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { Marked } from "marked"
import { markedCodeSpanBoundary } from "./marked-code-span"
import { markedTranscriptAutolink, transcriptLinkPrefixes } from "./marked"

/**
 * The desktop renders transcript Markdown in a Rust process, which cannot read
 * the list above, so it declares its own copy of it. A prefix added on one side
 * only would autolink on the web and stay inert on the desktop, or the reverse.
 */
const nativePrefixes = (() => {
  const source = readFileSync(
    new URL("../../../claxedo-desktop/native/rich-content-renderer/src/main.rs", import.meta.url),
    "utf8",
  )
  const declaration = /const TRANSCRIPT_LINK_PREFIXES:\s*\[&str;\s*\d+\]\s*=\s*\[([^\]]*)\]/.exec(source)
  if (!declaration) throw new Error("the native renderer no longer declares TRANSCRIPT_LINK_PREFIXES")
  return [...declaration[1].matchAll(/"([^"]*)"/g)].map(([, prefix]) => prefix)
})()

test("the native renderer carries the same closed prefix list", () => {
  expect([...nativePrefixes].sort()).toEqual([...transcriptLinkPrefixes].sort())
})

const parser = new Marked(markedCodeSpanBoundary, markedTranscriptAutolink)

/**
 * The other half of the agreement, for the destination an author writes rather
 * than one prose starts: comrak blanks a `file:` image source, so the native
 * renderer masks the scheme across its formatter and its own test asserts the
 * result. Marked hands the destination through untouched. Both then meet the
 * same DOMPurify config, whose URI allowlist is derived from the list above, so
 * the parse is the last stage where the two can differ over an image.
 */
test("the web renderer keeps an image source on the closed list", () => {
  expect(parser.parse("![shot](file:///Users/dev/shot.png)", { async: false })).toContain(
    'src="file:///Users/dev/shot.png"',
  )
  for (const prefix of transcriptLinkPrefixes) {
    expect(parser.parse(`![shot](${prefix}example.com/shot.png)`, { async: false })).toContain(
      `src="${prefix}example.com/shot.png"`,
    )
  }
})
