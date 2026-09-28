import { Show, type JSX } from "solid-js"
import { parentPath } from "@/files"
import { useTranslator } from "@/i18n"
import type { ChangeStatus } from "@/server"
import { FileIcon } from "@/ui"
import { getFilename } from "@/ui/utils"
import { folderLabel } from "../folder-label"
import { reviewDictionary, type ReviewKey } from "../i18n"
import { ChangeCounts } from "./change-counts"

export type ChangeEntry = {
  readonly path: string
  readonly status: ChangeStatus
  readonly additions: number
  readonly deletions: number
}

const STATUS_LETTER: Readonly<Record<ChangeStatus, string>> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "C",
}

const STATUS_LABEL: Readonly<Record<ChangeStatus, ReviewKey>> = {
  added: "review.status.added",
  modified: "review.status.modified",
  deleted: "review.status.deleted",
  renamed: "review.status.renamed",
  untracked: "review.status.untracked",
  conflicted: "review.status.conflicted",
}

function statusTone(status: ChangeStatus): string {
  if (status === "deleted") return "text-[color-mix(in_srgb,var(--text-diff-delete-base)_76%,var(--text-weaker))]"
  if (status === "conflicted") return "text-icon-critical-base"
  return "text-text-weaker"
}

export function ChangeRow(props: {
  readonly entry: ChangeEntry
  readonly group: string
  readonly active: boolean
  readonly onOpen: () => void
  readonly action?: JSX.Element
}): JSX.Element {
  const t = useTranslator(reviewDictionary)
  const label = () => t(STATUS_LABEL[props.entry.status])
  return (
    <div
      role="listitem"
      data-testid="source-control-row"
      data-path={props.entry.path}
      data-status={props.entry.status}
      data-group={props.group}
      data-active={props.active ? "true" : undefined}
      class="claxedo-source-control-row sidebar-row group flex min-w-0 items-center gap-1 pr-1 pl-1.5 text-text-weak transition-colors duration-100 hover:bg-surface-base-hover"
      classList={{ "bg-surface-base-active": props.active }}
    >
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center gap-1.5 self-stretch text-left outline-none"
        title={props.entry.path}
        onClick={() => props.onOpen()}
      >
        <FileIcon node={{ path: props.entry.path, type: "file" }} class="size-4 shrink-0" />
        <span class="flex h-[1lh] min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 overflow-hidden">
          <span
            class="max-w-full shrink-0 truncate text-text-strong"
            classList={{ "line-through decoration-text-weaker": props.entry.status === "deleted" }}
          >
            {getFilename(props.entry.path)}
          </span>
          <Show when={folderLabel(parentPath(props.entry.path))}>
            {(folder) => (
              <span data-slot="source-control-folder" class="flex grow basis-0 text-12-regular text-text-weaker">
                <Show when={folder().cut}>
                  {(cut) => (
                    <span class="w-[2ch] grow truncate text-left [direction:rtl]">{`\u202a${cut()}\u202c`}</span>
                  )}
                </Show>
                <span class="shrink-0 whitespace-nowrap">{folder().whole}</span>
              </span>
            )}
          </Show>
        </span>
        <ChangeCounts additions={props.entry.additions} deletions={props.entry.deletions} class="text-11-regular" />
        <span
          class={`w-3 shrink-0 text-center text-11-medium ${statusTone(props.entry.status)}`}
          aria-label={label()}
          title={label()}
        >
          {STATUS_LETTER[props.entry.status]}
        </span>
      </button>
      {props.action}
    </div>
  )
}
