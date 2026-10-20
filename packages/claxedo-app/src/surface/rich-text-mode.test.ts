/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { richTextModeTransition, type RichTextMode } from "./rich-text-mode"

const loading: RichTextMode = { kind: "loading" }
const source: RichTextMode = { kind: "source", reason: "markdown", rechecked: false }

describe("richTextModeTransition", () => {
  test("opens rich when the loaded editor keeps the Markdown, in source mode when it would not", () => {
    expect(richTextModeTransition(loading, { type: "loaded", fits: true })).toEqual({ kind: "rich" })
    expect(richTextModeTransition(loading, { type: "loaded", fits: false })).toEqual(source)
  })

  test("falls back to source mode for good when the editor chunk does not load", () => {
    const failed = richTextModeTransition(loading, { type: "loadFailed" })
    expect(failed).toEqual({ kind: "source", reason: "failed", rechecked: false })
    expect(richTextModeTransition(failed, { type: "rechecked", fits: true })).toEqual(failed)
    expect(richTextModeTransition(failed, { type: "valueReplaced", fits: true })).toEqual(failed)
  })

  test("a re-check that still does not fit stays in source mode and says so; one that fits goes rich", () => {
    expect(richTextModeTransition(source, { type: "rechecked", fits: false })).toEqual({ ...source, rechecked: true })
    expect(richTextModeTransition(source, { type: "rechecked", fits: true })).toEqual({ kind: "rich" })
  })

  test("a value the producer replaces is checked again", () => {
    expect(richTextModeTransition({ kind: "rich" }, { type: "valueReplaced", fits: false })).toEqual(source)
    expect(richTextModeTransition(source, { type: "valueReplaced", fits: true })).toEqual({ kind: "rich" })
  })
})
