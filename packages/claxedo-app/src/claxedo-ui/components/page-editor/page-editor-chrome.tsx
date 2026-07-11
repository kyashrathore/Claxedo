/**
 * Breadcrumb/status bar for the page editor: back-to-index link plus the
 * status badge with its transition dropdown.
 *
 * Pure presentation over signals/handlers owned by PageEditorLoaded —
 * received as props. Extracted verbatim from page-editor.tsx (Plan 005);
 * markup, classes, and behavior unchanged.
 */

import { Show, For } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import type { PageStatus } from "@/shared/data/pages-api"

export type PageEditorChromeProps = {
  onBackToIndex?: () => void
  currentStatus: () => PageStatus | undefined
  pageStatus: () => string
  allowedTransitions: () => PageStatus[]
  statusDropdownOpen: () => boolean
  setStatusDropdownOpen: (open: boolean | ((open: boolean) => boolean)) => void
  onStatusTransition: (targetId: string) => void
  sourceLabel?: () => string
  gitStatus?: () => string
  gitBusy?: () => boolean
  onExport?: () => void
  onCommit?: () => void
}

export function PageEditorChrome(props: PageEditorChromeProps) {
  return (
    <div class="flex items-center gap-2 pt-3 pb-1">
      <Show when={props.onBackToIndex}>
        <button
          type="button"
          class="flex items-center gap-1 text-[11px] text-text-weak hover:text-text-base transition-colors"
          onClick={() => props.onBackToIndex?.()}
        >
          <Icon name="chevron-left" size="small" />
          <span>Pages</span>
        </button>
        <span class="text-text-weaker text-[11px]">/</span>
      </Show>
      <div class="relative">
        <button
          type="button"
          class="flex items-center gap-1.5 px-1.5 py-0.5 rounded text-[11px] font-medium transition-colors hover:opacity-80"
          style={{
            "background-color": `${props.currentStatus()?.color || "#6b7280"}20`,
            color: props.currentStatus()?.color || "#6b7280",
          }}
          onClick={(e) => {
            e.stopPropagation()
            props.setStatusDropdownOpen((v) => !v)
          }}
        >
          <div
            class="w-1.5 h-1.5 rounded-full"
            style={{ "background-color": props.currentStatus()?.color || "#6b7280" }}
          />
          {props.currentStatus()?.name || props.pageStatus()}
          <Show when={props.allowedTransitions().length > 0}>
            <Icon name="chevron-down" size="small" />
          </Show>
        </button>
        <Show when={props.statusDropdownOpen() && props.allowedTransitions().length > 0}>
          <div
            class="absolute left-0 top-full mt-1 z-50 min-w-[140px] rounded-md border border-border-weak-base bg-background-base shadow-lg py-1"
            onClick={(e) => e.stopPropagation()}
          >
            <For each={props.allowedTransitions()}>
              {(target) => (
                <button
                  type="button"
                  class="flex items-center gap-2 w-full px-3 py-1.5 text-left text-[11px] hover:bg-surface-base-hover transition-colors"
                  onClick={() => props.onStatusTransition(target.id)}
                >
                  <div
                    class="w-2 h-2 rounded-full shrink-0"
                    style={{ "background-color": target.color }}
                  />
                  <span class="text-text-base">{target.name}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
      <Show when={props.sourceLabel?.()}>
        <span class="truncate text-[11px] text-text-weak max-w-[260px]" title={props.sourceLabel?.()}>
          {props.sourceLabel?.()}
        </span>
        <span class="text-[11px] text-text-weaker">{props.gitStatus?.()}</span>
      </Show>
      <Show when={props.onExport}>
        <button
          type="button"
          class="text-[11px] text-text-weak hover:text-text-base transition-colors"
          onClick={() => props.onExport?.()}
        >
          Export
        </button>
      </Show>
      <Show when={props.onCommit}>
        <button
          type="button"
          class="text-[11px] text-text-weak hover:text-text-base transition-colors disabled:opacity-50"
          disabled={props.gitBusy?.()}
          onClick={() => props.onCommit?.()}
        >
          {props.gitBusy?.() ? "Committing..." : "Commit"}
        </button>
      </Show>
    </div>
  )
}
