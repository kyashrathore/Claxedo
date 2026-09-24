import { Show } from "solid-js"
import type { FileNode } from "@/server"
import type { ChangeMark } from "../model"
import { t } from "../i18n"

const MARK_LETTER: Readonly<Record<ChangeMark, string>> = { added: "A", deleted: "D", modified: "M" }

const MARK_COLOR: Readonly<Record<ChangeMark, string>> = {
  added: "var(--icon-diff-add-base)",
  deleted: "var(--icon-diff-delete-base)",
  modified: "var(--icon-diff-modified-base)",
}

const markLabel = (mark: ChangeMark) => t(`files.mark.${mark}`)

function Chevron(props: { readonly expanded: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" class="shrink-0 text-icon-weak-base">
      <path
        d={props.expanded ? "M3 6l5 5 5-5" : "M6 3l5 5-5 5"}
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  )
}

export function FileTreeRow(props: {
  readonly node: FileNode
  readonly level: number
  readonly expanded?: boolean
  readonly mark?: ChangeMark
  readonly active?: boolean
  readonly onActivate: () => void
}) {
  const directory = () => props.node.kind === "directory"
  const color = () => (props.mark && !props.node.ignored ? MARK_COLOR[props.mark] : undefined)
  return (
    <button
      type="button"
      role="treeitem"
      aria-level={props.level + 1}
      aria-expanded={directory() ? props.expanded === true : undefined}
      aria-selected={props.active === true}
      aria-current={props.active ? "true" : undefined}
      data-file-tree-path={props.node.path}
      class="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-12-medium hover:bg-surface-base-hover pointer-coarse:min-h-11"
      classList={{ "bg-surface-base-active": props.active === true }}
      style={{ "padding-left": `${8 + props.level * 12}px` }}
      onClick={() => props.onActivate()}
    >
      <Show when={directory()} fallback={<span class="w-3 shrink-0" />}>
        <Chevron expanded={props.expanded === true} />
      </Show>
      <span
        class="min-w-0 flex-1 truncate"
        classList={{ "text-text-weaker": props.node.ignored, "text-text-weak": !props.node.ignored && !color() }}
        style={{ color: color() }}
      >
        {props.node.name}
      </span>
      <Show when={props.mark}>
        {(mark) => (
          <span class="w-4 shrink-0 text-center text-12-medium" style={{ color: MARK_COLOR[mark()] }} aria-label={markLabel(mark())}>
            {directory() ? "•" : MARK_LETTER[mark()]}
          </span>
        )}
      </Show>
    </button>
  )
}
