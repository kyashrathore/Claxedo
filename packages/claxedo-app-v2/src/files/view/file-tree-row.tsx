import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import type { FileNode } from "@/server"
import { FileIcon, Icon } from "@/ui"
import { dictionary } from "../i18n"
import type { ChangeMark } from "../model"

const MARK_LETTER: Readonly<Record<ChangeMark, string>> = { added: "A", deleted: "D", modified: "M" }

const MARK_COLOR: Readonly<Record<ChangeMark, string>> = {
  added: "text-success-fg",
  deleted: "text-danger-fg",
  modified: "text-warning-fg",
}

export function FileTreeRow(props: {
  readonly node: FileNode
  readonly level: number
  readonly expanded?: boolean
  readonly mark?: ChangeMark
  readonly active?: boolean
  readonly onActivate: () => void
}): JSX.Element {
  const t = useTranslator(dictionary)
  const directory = () => props.node.kind === "directory"
  const mark = () => (props.node.ignored ? undefined : props.mark)
  return (
    <button
      type="button"
      role="treeitem"
      aria-level={props.level + 1}
      aria-expanded={directory() ? props.expanded === true : undefined}
      aria-selected={props.active === true}
      data-path={props.node.path}
      class="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md pr-1.5 text-left text-sm hover:bg-overlay-hover pointer-coarse:min-h-11"
      classList={{ "bg-overlay-pressed": props.active === true }}
      style={{ "padding-left": `${6 + props.level * 12}px` }}
      onClick={() => props.onActivate()}
    >
      <Show when={directory()} fallback={<span class="w-3.5 shrink-0" />}>
        <Icon name={props.expanded ? "chevron-down" : "chevron-right"} size="small" class="shrink-0 text-icon-muted" />
      </Show>
      <FileIcon node={{ path: props.node.path, type: props.node.kind }} expanded={props.expanded === true} class="size-4 shrink-0" />
      <span
        class="min-w-0 flex-1 truncate"
        classList={{
          "text-text-faint": props.node.ignored,
          "text-text-base": !props.node.ignored && !mark(),
          [MARK_COLOR[mark() ?? "modified"]]: mark() !== undefined,
        }}
      >
        {props.node.name}
      </span>
      <Show when={mark()}>
        {(current) => (
          <>
            <span aria-hidden="true" class={`w-4 shrink-0 text-center text-xs ${MARK_COLOR[current()]}`}>
              {directory() ? "•" : MARK_LETTER[current()]}
            </span>
            <span class="sr-only">{t(`files.mark.${current()}`)}</span>
          </>
        )}
      </Show>
    </button>
  )
}
