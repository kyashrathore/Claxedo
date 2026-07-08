import type { Prompt } from "@/context/prompt"
import { createEffect, on, type Accessor } from "solid-js"

export function shouldSeedNewSessionDeepLinkPrompt(input: {
  newSession: boolean
  ready: boolean
  dirty: boolean
}) {
  return input.newSession && input.ready && !input.dirty
}

export function newSessionDeepLinkPromptParts(text: string): Prompt {
  return [{ type: "text", content: text, start: 0, end: text.length }]
}

export function newSessionDeepLinkPromptFromSearch(search: string) {
  const prompt = new URLSearchParams(search).get("prompt")?.trim()
  return prompt || undefined
}

export function searchWithoutNewSessionDeepLinkPrompt(search: string) {
  const params = new URLSearchParams(search)
  params.delete("prompt")
  const next = params.toString()
  return next ? `?${next}` : ""
}

export function consumeNewSessionDeepLinkPrompt(input: {
  newSession: boolean
  search: string
  ready: boolean
  dirty: boolean
}) {
  if (!input.newSession || !input.ready) return
  const text = newSessionDeepLinkPromptFromSearch(input.search)
  if (!text) return
  const search = searchWithoutNewSessionDeepLinkPrompt(input.search)
  if (!shouldSeedNewSessionDeepLinkPrompt(input)) return { search }
  return {
    search,
    prompt: newSessionDeepLinkPromptParts(text),
    cursor: text.length,
  }
}

export function createNewSessionDeepLinkPromptSeed(input: {
  newSession: Accessor<boolean>
  search: Accessor<string>
  prompt: {
    ready(): boolean
    dirty(): boolean
    set(prompt: Prompt, cursorPosition?: number): void
  }
  replaceSearch(search: string): void
}) {
  createEffect(
    on(
      () => [input.newSession(), input.search(), input.prompt.ready(), input.prompt.dirty()] as const,
      ([newSession, search, ready, dirty]) => {
        const next = consumeNewSessionDeepLinkPrompt({ newSession, search, ready, dirty })
        if (!next) return
        input.replaceSearch(next.search)
        if (next.prompt) input.prompt.set(next.prompt, next.cursor)
      },
    ),
  )
}
