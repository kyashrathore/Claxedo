import { createSignal } from "solid-js"
import { useFilteredList } from "./filtered-list"

export type LineCommentEditorMention = {
  items: (query: string) => string[] | Promise<string[]>
}

export type MentionItem = { path: string }

type MentionRange = { query: string; start: number; end: number }

export function createMentionSuggestions(input: {
  textarea: () => HTMLTextAreaElement | undefined
  mention: () => LineCommentEditorMention | undefined
  onInput: (value: string) => void
}) {
  const [open, setOpen] = createSignal(false)

  const current = (): MentionRange | undefined => {
    const textarea = input.textarea()
    if (!textarea || !input.mention() || textarea.selectionStart !== textarea.selectionEnd) return undefined
    const end = textarea.selectionStart
    const match = textarea.value.slice(0, end).match(/@(\S*)$/)
    if (!match) return undefined
    return { query: match[1] ?? "", start: end - match[0].length, end }
  }

  const list = useFilteredList<MentionItem>({
    items: async (query) => {
      const mention = input.mention()
      if (!mention || !query.trim()) return []
      return (await mention.items(query)).map((path) => ({ path }))
    },
    key: (item) => item.path,
    filterKeys: ["path"],
    skipFilter: () => true,
    onSelect: (item) => select(item),
  })

  const close = () => {
    setOpen(false)
    list.clear()
  }

  const select = (item: MentionItem | undefined) => {
    const textarea = input.textarea()
    const range = current()
    if (!item || !textarea || !range) return
    const value = `${textarea.value.slice(0, range.start)}@${item.path} ${textarea.value.slice(range.end)}`
    const cursor = range.start + item.path.length + 2
    input.onInput(value)
    close()
    requestAnimationFrame(() => {
      textarea.focus()
      textarea.setSelectionRange(cursor, cursor)
    })
  }

  const sync = () => {
    const range = current()
    if (!range) return close()
    setOpen(true)
    list.onInput(range.query)
  }

  const selectActive = () => {
    const items = list.flat()
    if (items.length === 0) return
    select(items.find((item) => item.path === list.active()) ?? items[0])
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (!open()) return false
    if (event.key === "Escape") {
      event.preventDefault()
      close()
      return true
    }
    if (event.key === "Tab") {
      if (list.flat().length === 0) return false
      event.preventDefault()
      selectActive()
      return true
    }
    const arrows = event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter"
    const emacs = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && (event.key === "n" || event.key === "p")
    if (!(arrows || emacs) || list.flat().length === 0) return false
    list.onKeyDown(event)
    event.preventDefault()
    return true
  }

  return { open, list, sync, close, select, onKeyDown }
}

export type MentionSuggestions = ReturnType<typeof createMentionSuggestions>
