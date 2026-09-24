import { Show, type JSX } from "solid-js"
import type { DiffSummary, PlacementId } from "@/server"
import { basename, FILE_PANE_KIND, parentPath } from "@/files"
import { t } from "../i18n"
import { useReview } from "../store"

const STATUS_COLOR: Readonly<Record<string, string>> = {
  added: "var(--icon-diff-add-base)",
  deleted: "var(--icon-diff-delete-base)",
  modified: "var(--icon-diff-modified-base)",
}

const STATUS_LETTER: Readonly<Record<string, string>> = { added: "A", deleted: "D", modified: "M" }

export function ChangedFileRow(props: { readonly placementId: PlacementId; readonly diff: DiffSummary }): JSX.Element {
  const review = useReview()
  const status = () => props.diff.status ?? "modified"
  const open = () => review.isOpen(props.diff.file)
  const openFile = () => review.openPane(FILE_PANE_KIND, { placementId: props.placementId, path: props.diff.file })
  return (
    <div
      data-component="review-file"
      data-path={props.diff.file}
      data-status={status()}
      class="flex min-h-7 items-center gap-1 rounded-md pl-1 pr-1 text-12-medium text-text-weak hover:bg-surface-base-hover pointer-coarse:min-h-11"
    >
      <button
        type="button"
        aria-expanded={open()}
        aria-label={`${open() ? t("review.collapse") : t("review.expand")} ${props.diff.file}`}
        class="flex min-h-7 min-w-0 flex-1 items-center gap-1.5 text-left pointer-coarse:min-h-11"
        onClick={() => review.setOpen(props.diff.file, !open())}
      >
        <span class="w-3.5 shrink-0 text-center" style={{ color: STATUS_COLOR[status()] }} aria-label={t(`review.change.${status()}`)}>
          {STATUS_LETTER[status()]}
        </span>
        <span class="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5">
          <span class="min-w-0 break-all text-text-base">{basename(props.diff.file)}</span>
          <Show when={parentPath(props.diff.file)}>
            {(dir) => <span class="min-w-0 break-all text-11-regular text-text-weaker">{dir()}</span>}
          </Show>
        </span>
        <span class="shrink-0 text-11-regular tabular-nums">
          <span class="text-[var(--text-diff-add-base)]">+{props.diff.additions}</span>{" "}
          <span class="text-[var(--text-diff-delete-base)]">−{props.diff.deletions}</span>
        </span>
      </button>
      <button
        type="button"
        aria-label={`${t("review.openFile")} ${props.diff.file}`}
        class="flex size-7 shrink-0 items-center justify-center rounded text-text-weak hover:bg-surface-base-active hover:text-text-base pointer-coarse:size-11"
        onClick={() => openFile()}
      >
        ↗
      </button>
    </div>
  )
}
