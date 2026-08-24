import { describe, expect, test } from "bun:test"
import {
  consumeNewSessionDeepLinkPrompt,
  newSessionDeepLinkPromptFromSearch,
  newSessionDeepLinkPromptParts,
  searchWithoutNewSessionDeepLinkPrompt,
  shouldSeedNewSessionDeepLinkPrompt,
} from "./deep-link-prompt"

describe("new-session deep-link prompt", () => {
  test("seeds only clean ready new-session drafts", () => {
    expect(shouldSeedNewSessionDeepLinkPrompt({ newSession: true, ready: true, dirty: false })).toBe(true)
    expect(shouldSeedNewSessionDeepLinkPrompt({ newSession: false, ready: true, dirty: false })).toBe(false)
    expect(shouldSeedNewSessionDeepLinkPrompt({ newSession: true, ready: false, dirty: false })).toBe(false)
    expect(shouldSeedNewSessionDeepLinkPrompt({ newSession: true, ready: true, dirty: true })).toBe(false)
  })

  test("builds a cursor-ready text prompt", () => {
    expect(newSessionDeepLinkPromptParts("ship it")).toEqual([{ type: "text", content: "ship it", start: 0, end: 7 }])
  })

  test("parses and strips prompt query params", () => {
    expect(newSessionDeepLinkPromptFromSearch("?prompt=ship%20it")).toBe("ship it")
    expect(newSessionDeepLinkPromptFromSearch("?prompt=line%20one%0Aline%20two%20%26%20more")).toBe(
      "line one\nline two & more",
    )
    expect(newSessionDeepLinkPromptFromSearch("?prompt=%20%20")).toBeUndefined()
    expect(searchWithoutNewSessionDeepLinkPrompt("?prompt=ship%20it&pane=p1")).toBe("?pane=p1")
    expect(searchWithoutNewSessionDeepLinkPrompt("?prompt=ship%20it")).toBe("")
  })

  test("consumes a clean ready draft prompt and removes the query", () => {
    expect(
      consumeNewSessionDeepLinkPrompt({
        newSession: true,
        search: "?prompt=ship%20it&pane=p1",
        ready: true,
        dirty: false,
      }),
    ).toEqual({
      search: "?pane=p1",
      prompt: newSessionDeepLinkPromptParts("ship it"),
      cursor: 7,
    })
  })

  test("does not clobber dirty drafts but still consumes the query", () => {
    expect(
      consumeNewSessionDeepLinkPrompt({
        newSession: true,
        search: "?prompt=ship",
        ready: true,
        dirty: true,
      }),
    ).toEqual({ search: "" })
  })

  test("waits until the new-session draft is ready", () => {
    expect(
      consumeNewSessionDeepLinkPrompt({
        newSession: true,
        search: "?prompt=ship",
        ready: false,
        dirty: false,
      }),
    ).toBeUndefined()
    expect(
      consumeNewSessionDeepLinkPrompt({
        newSession: false,
        search: "?prompt=ship",
        ready: true,
        dirty: false,
      }),
    ).toBeUndefined()
  })
})
