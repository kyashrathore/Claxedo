import { Show, type JSX } from "solid-js"
import { basename, parentPath } from "@/files"
import { useTranslator } from "@/i18n"
import type { DiffSummary } from "@/server"
import { DiffChanges, FileIcon } from "@/ui"
import { dictionary } from "../i18n"

export function FileHeader(props: { readonly diff: DiffSummary }): JSX.Element {
  const t = useTranslator(dictionary)
  const directory = () => parentPath(props.diff.file)
  const status = () => props.diff.status
  return (
    <div data-slot="session-review-trigger-content" data-status={status() ?? "modified"}>
      <FileIcon node={{ path: props.diff.file, type: "file" }} />
      <Show when={directory()}>
        <span data-slot="session-review-directory">{`‪${directory()}/‬`}</span>
      </Show>
      <span data-slot="session-review-filename">{`‪${basename(props.diff.file)}‬`}</span>
      <div data-slot="session-review-trigger-actions">
        <Show when={status() === "added" || status() === "deleted"}>
          <span data-slot="session-review-change" data-type={status() === "added" ? "added" : "removed"}>
            {status() === "added" ? t("review.change.added") : t("review.change.deleted")}
          </span>
        </Show>
        <DiffChanges changes={{ additions: props.diff.additions, deletions: props.diff.deletions }} />
      </div>
    </div>
  )
}
