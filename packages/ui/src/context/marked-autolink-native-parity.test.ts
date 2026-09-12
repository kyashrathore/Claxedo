import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { transcriptLinkPrefixes } from "./marked"

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
