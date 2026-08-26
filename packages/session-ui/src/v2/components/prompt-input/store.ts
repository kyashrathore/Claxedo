import { storePath } from "solid-js"
import { type Accessor } from "solid-js"
import type { StoreSetter, Store } from "solid-js"
import type {
  PromptInputV2AgentPart,
  PromptInputV2Attachment,
  PromptInputV2Comment,
  PromptInputV2FilePart,
  PromptInputV2Model,
  PromptInputV2PersistedState,
  PromptInputV2Prompt,
} from "./types"

export type PromptInputV2StoreTuple = [
  Store<PromptInputV2PersistedState> | Accessor<Store<PromptInputV2PersistedState>>,
  StoreSetter<PromptInputV2PersistedState>,
]

export type PromptInputV2StoreInput = PromptInputV2StoreTuple | Accessor<PromptInputV2StoreTuple>

export function createPromptInputV2Store(input: PromptInputV2StoreInput) {
  const tuple = () => (typeof input === "function" ? input() : input)
  const store = () => {
    const value = tuple()[0]
    return typeof value === "function" ? value() : value
  }
  const setStore = () => tuple()[1]

  // Every action below derives its next state INSIDE the write callback rather
  // than from `store()`. Solid 2 stages store writes until the scheduler
  // flushes, so a committed read here is the pre-write value: two `addText`
  // calls in one task both inserted at the same cursor, `setVariant` right
  // after `setModel` saw no model and dropped the write, and `addContext`
  // deduped against a list that did not yet contain the item it had just
  // added. The draft reflects earlier staged writes, so the chain is correct.
  return {
    get state() {
      return store()
    },
    setPrompt(prompt: PromptInputV2Prompt, cursor?: number) {
      setStore()(($state) => {
        $state.prompt = prompt
        if (cursor !== undefined) $state.cursor = cursor
      })
    },
    setCursor(cursor: number) {
      setStore()(storePath("cursor", cursor))
    },
    setText(content: string) {
      setStore()(($state) => {
        $state.prompt = [
          { type: "text" as const, content, start: 0, end: content.length },
          ...$state.prompt.filter((part) => part.type !== "text"),
        ]
        $state.cursor = content.length
      })
    },
    addText(content: string) {
      setStore()(($state) => {
        const cursor = $state.cursor ?? promptLength($state.prompt)
        $state.prompt = insertText($state.prompt, cursor, content)
        $state.cursor = cursor + content.length
      })
    },
    reset() {
      setStore()(($state) => {
        $state.prompt = [{ type: "text", content: "", start: 0, end: 0 }]
        $state.cursor = 0
      })
    },
    setModel(model: PromptInputV2Model | undefined) {
      setStore()(storePath("model", model))
    },
    setVariant(variant: string | null) {
      setStore()(($state) => {
        if ($state.model) $state.model.variant = variant
      })
    },
    addContext(item: PromptInputV2Comment) {
      setStore()(($state) => {
        if ($state.context.items.some((entry) => entry.key === item.key)) return
        $state.context.items = [...$state.context.items, item]
      })
    },
    removeContext(key: string) {
      setStore()(storePath("context", "items", (items) => items.filter((item) => item.key !== key)))
    },
    addMention(mention: PromptInputV2FilePart | PromptInputV2AgentPart) {
      setStore()(($state) => {
        const text = $state.prompt.map((part) => ("content" in part ? part.content : "")).join("")
        const end = $state.cursor ?? text.length
        const at = text.slice(0, end).lastIndexOf("@")
        const start = at < 0 ? end : at
        $state.prompt = insertMention($state.prompt, start, end, mention)
        $state.cursor = start + mention.content.length + 1
      })
    },
    addAttachment(attachment: PromptInputV2Attachment) {
      setStore()(storePath("prompt", (prompt) => [...prompt, attachment]))
    },
    removeAttachment(id: string) {
      setStore()(storePath("prompt", (parts) => parts.filter((part) => part.type !== "image" || part.id !== id)))
    },
  }
}

export type PromptInputV2Store = ReturnType<typeof createPromptInputV2Store>

function insertText(prompt: PromptInputV2Prompt, cursor: number, content: string): PromptInputV2Prompt {
  let position = 0
  let inserted = false
  const parts = prompt.flatMap<PromptInputV2Prompt[number]>((part) => {
    if (part.type === "image") return [part]
    const start = position
    position += part.content.length
    if (inserted) return [part]
    if (part.type === "text" && cursor >= start && cursor <= position) {
      inserted = true
      const offset = cursor - start
      return [{ ...part, content: part.content.slice(0, offset) + content + part.content.slice(offset) }]
    }
    if (cursor > start) return [part]
    inserted = true
    return [{ type: "text", content, start: 0, end: 0 }, part]
  })
  if (!inserted) parts.push({ type: "text", content, start: 0, end: 0 })
  return withOffsets(parts)
}

function insertMention(
  prompt: PromptInputV2Prompt,
  start: number,
  end: number,
  mention: PromptInputV2FilePart | PromptInputV2AgentPart,
): PromptInputV2Prompt {
  let position = 0
  const parts = prompt.flatMap<PromptInputV2Prompt[number]>((part) => {
    if (part.type === "image") return [part]
    const partStart = position
    position += part.content.length
    if (part.type !== "text" || start < partStart || end > position) return [part]
    const before = part.content.slice(0, start - partStart)
    const after = part.content.slice(end - partStart)
    return [
      ...(before ? [{ type: "text" as const, content: before, start: 0, end: 0 }] : []),
      mention,
      { type: "text" as const, content: ` ${after}`, start: 0, end: 0 },
    ]
  })
  return withOffsets(parts)
}

function withOffsets(prompt: PromptInputV2Prompt): PromptInputV2Prompt {
  let offset = 0
  return prompt.map((part) => {
    if (part.type === "image") return part
    const next = { ...part, start: offset, end: offset + part.content.length }
    offset = next.end
    return next
  })
}

function promptLength(prompt: PromptInputV2Prompt) {
  return prompt.reduce((length, part) => length + ("content" in part ? part.content.length : 0), 0)
}
