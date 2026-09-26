import { createEffect } from "solid-js"
import type { ControllerContext } from "./controller-context"
import type { ContextItem, PromptPart } from "./model"
import { emptyPrompt, promptImages, randomId } from "./model"
import type { AtItem, SlashItem } from "./suggestions"

function atTrigger(text: string, cursor: number) {
  const before = text.slice(0, cursor)
  const match = /@(\S*)$/.exec(before)
  if (!match) return undefined
  return { query: match[1] ?? "", start: before.length - match[0].length }
}

function slashTrigger(text: string) {
  const match = /^\/(\S*)$/.exec(text)
  return match ? { query: match[1] ?? "" } : undefined
}

export function activeItems(context: ControllerContext): readonly (AtItem | SlashItem)[] {
  return context.state.popover.kind === "at" ? context.input.atItems() : context.input.slashItems()
}

export function keepActiveItem(context: ControllerContext): void {
  createEffect(() => {
    const items = activeItems(context)
    if (context.state.popover.kind === "closed") return
    if (context.state.activeId && items.some((item) => item.id === context.state.activeId)) return
    context.setState("activeId", items[0]?.id)
  })
}

export function updatePopover(context: ControllerContext, value: string, cursor: number): void {
  const normal = context.state.mode === "normal"
  const at = normal ? atTrigger(value, cursor) : undefined
  if (at) return context.setState("popover", { kind: "at", query: at.query, start: at.start })
  const slash = normal ? slashTrigger(value) : undefined
  if (slash) return context.setState("popover", { kind: "slash", query: slash.query })
  context.setState("popover", { kind: "closed" })
}

export function closePopover(context: ControllerContext): void {
  context.setState("popover", { kind: "closed" })
}

function replaceSpan(context: ControllerContext, start: number, end: number, parts: PromptPart[]): void {
  const value = context.text()
  const before = value.slice(0, start)
  const after = value.slice(end)
  const rebuilt: PromptPart[] = [
    ...(before ? [{ type: "text" as const, content: before, start: 0, end: 0 }] : []),
    ...parts,
    { type: "text" as const, content: after.startsWith(" ") ? after : ` ${after}`, start: 0, end: 0 },
    ...promptImages(context.draft().prompt),
  ]
  const inserted = parts.reduce((length, part) => length + ("content" in part ? part.content.length : 0), 0)
  context.input.store.setPrompt(context.input.key(), rebuilt, start + inserted + 1)
  closePopover(context)
  requestAnimationFrame(() => context.focusEditor())
}

export function selectAt(context: ControllerContext, item: AtItem): void {
  if (context.state.popover.kind !== "at") return
  const cursor = context.draft().cursor ?? context.text().length
  const typed = atTrigger(context.text(), cursor)
  const start = typed?.start ?? cursor
  const end = cursor
  if (item.kind === "file") {
    return replaceSpan(context, start, end, [{ type: "file", path: item.path, content: `@${item.path}`, start: 0, end: 0 }])
  }
  const inserted = item.entry.insert()
  if ("text" in inserted) return replaceSpan(context, start, end, [{ type: "text", content: inserted.text, start: 0, end: 0 }])
  const mention: ContextItem = {
    type: "text",
    key: `mention:${item.entry.id}:${randomId()}`,
    label: inserted.attachment.label,
    text: inserted.attachment.text,
  }
  context.input.store.addContext(context.input.key(), mention)
  replaceSpan(context, start, end, [{ type: "text", content: `@${inserted.attachment.label}`, start: 0, end: 0 }])
}

export function selectSlash(context: ControllerContext, item: SlashItem): void {
  closePopover(context)
  if (item.type === "custom") {
    const text = `/${item.trigger} `
    context.input.store.setPrompt(context.input.key(), [{ type: "text", content: text, start: 0, end: text.length }], text.length)
    requestAnimationFrame(() => context.focusEditor(text.length))
    return
  }
  context.input.store.setPrompt(context.input.key(), emptyPrompt(), 0)
  context.input.runCommand(item)
}

export function selectActive(context: ControllerContext): void {
  if (context.state.popover.kind === "closed") return
  const item = activeItems(context).find((candidate) => candidate.id === context.state.activeId)
  if (!item) return
  if ("kind" in item) selectAt(context, item)
  else selectSlash(context, item)
}

function moveActive(context: ControllerContext, step: 1 | -1): void {
  const items = activeItems(context)
  if (items.length === 0 || context.state.popover.kind === "closed") return
  const index = items.findIndex((item) => item.id === context.state.activeId)
  const next = index < 0 ? (step === 1 ? 0 : items.length - 1) : (index + step + items.length) % items.length
  context.setState("activeId", items[next].id)
}

export function popoverKeyDown(context: ControllerContext, event: KeyboardEvent): void {
  if (event.key === "Enter") return selectActive(context)
  if (event.key === "ArrowDown" || event.key === "n") return moveActive(context, 1)
  if (event.key === "ArrowUp" || event.key === "p") return moveActive(context, -1)
}

export function openCommands(context: ControllerContext): void {
  context.setState("popover", { kind: "slash", query: "" })
}

export function openContext(context: ControllerContext): void {
  const cursor = context.draft().cursor ?? context.text().length
  context.setState("popover", { kind: "at", query: "", start: cursor })
}
