/**
 * Pure state/derivation helpers for the page editor.
 *
 * Functions of inputs → outputs only — no signals, no editor instance,
 * no DOM. Extracted from page-editor.tsx (Plan 005); behavior-preserving.
 */

import type { Page, PageQuery, PageStatus } from "@/features/documents/data/pages-api"
import type { ArenaWaveState } from "@/features/documents/data/arena-api"
import type { PageAiAction, AiPanelPos, AiSelection } from "./page-editor-utils"

export type TocMark = { order: number; pos: number; title: string; level: number }

export type AiRequest = {
  action: PageAiAction
  instruction?: string
  selection: AiSelection | null
  text: string
  context: string
  panel: AiPanelPos
}

/** Statuses the page may transition to from the current status. */
export function allowedStatusTransitions(current: PageStatus | undefined, all: PageStatus[]): PageStatus[] {
  if (!current) return all
  return all.filter((s) => current.transitions.includes(s.id))
}

/** Scope query for status lookups, derived from the page record + active directory. */
export function derivePageQuery(page: Pick<Page, "project_id" | "directory">, directory: string | undefined): PageQuery {
  if (page.project_id) {
    return {
      scope: "project",
      project_id: page.project_id,
      ...(page.directory ? { directory: page.directory } : {}),
    }
  }
  if (page.project_id === null) return { scope: "global" }
  if (directory) return { scope: "project", directory }
  return { scope: "project", directory: "/" }
}

/**
 * Parse stored page content: JSON document if valid, raw string otherwise,
 * "" when empty. Returns `any` to match the original inline inference
 * (JSON.parse) — callers feed it straight into Tiptap's Content parameter.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parsePageContent(content: string | null | undefined): any {
  if (!content) return ""
  try {
    return JSON.parse(content)
  } catch {
    return content
  }
}

/** Clamp the side-dock width. `innerWidth === undefined` is the SSR branch. */
export function clampDockWidth(value: number, innerWidth?: number): number {
  if (innerWidth === undefined) return Math.max(360, Math.min(900, Math.round(value)))
  const max = Math.max(420, innerWidth - 320)
  return Math.max(360, Math.min(max, Math.round(value)))
}

/** Minimal structural shape of a ProseMirror document for TOC extraction. */
export type TocDocNode = {
  descendants(
    visitor: (
      node: { type: { name: string }; textContent: string; attrs?: Record<string, unknown> },
      pos: number,
    ) => boolean | void,
  ): void
}

/** Walk the document and collect heading marks for the TOC rail. */
export function computeTocMarks(doc: TocDocNode): TocMark[] {
  const list: TocMark[] = []
  let order = 0
  doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return true
    const title = node.textContent.trim()
    if (!title) return true
    const level = typeof node.attrs?.level === "number" ? node.attrs.level : 1
    list.push({ order, pos, title, level })
    order += 1
    return true
  })
  return list
}

/**
 * Pick the active TOC entry's order given each heading's viewport top.
 * `tops[i]` is the y coordinate of `list[i]`; the last heading at or above
 * the anchor line wins; falls back to the first heading.
 */
export function activeTocOrder(list: TocMark[], tops: number[], anchorY = 160): number {
  if (!list.length) return -1
  let idx = -1
  for (let i = 0; i < list.length; i++) {
    if (tops[i] <= anchorY) idx = i
  }
  if (idx === -1) return list[0].order
  return list[idx].order
}

/** True when the AI selection spans actual content (not a collapsed cursor). */
export function hasRealAiSelection(selection: AiSelection | null): boolean {
  return selection !== null && selection.from !== selection.to
}

/**
 * Assemble the AI request payload. Full page context only for actions that
 * operate on the whole document; custom action without selection gets empty
 * context — the instruction alone drives the model. `getFullText` is lazy so
 * the document text is only read when the context rule requires it.
 */
export function buildAiRequest(input: {
  action: PageAiAction
  instruction?: string
  selection: AiSelection | null
  selectedText: string
  getFullText: () => string
  panel: AiPanelPos
}): AiRequest {
  const real = hasRealAiSelection(input.selection)
  return {
    action: input.action,
    instruction: input.instruction,
    selection: input.selection,
    text: real ? input.selectedText : "",
    context: input.action === "custom" && !real ? "" : input.getFullText().slice(0, 14000),
    panel: input.panel,
  }
}

/** Arena waves currently open as tabs, in tab order. */
export function visibleArenaWavesOf(tabs: string[], waves: ArenaWaveState[]): ArenaWaveState[] {
  return tabs.map((id) => waves.find((wave) => wave.id === id)).filter((wave): wave is ArenaWaveState => !!wave)
}

/** The wave id that should be active: the picked one when still visible, else the first. */
export function resolveActiveArenaWave(picked: string, visible: ArenaWaveState[]): string {
  if (picked && visible.some((wave) => wave.id === picked)) return picked
  return visible[0]?.id || ""
}

/** Display label for an arena tab — newest wave gets the highest number. */
export function arenaTabLabel(waves: ArenaWaveState[], id: string): string {
  const index = waves.findIndex((wave) => wave.id === id)
  if (index < 0) return "Arena"
  return `Arena ${waves.length - index}`
}

/** Human-readable message from a thrown error; unwraps `{ "error": "..." }` JSON bodies. */
export function errText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  try {
    const value = JSON.parse(raw) as { error?: string }
    if (typeof value?.error === "string" && value.error.trim()) return value.error
  } catch {}
  return raw
}
