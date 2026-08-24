import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { ClaxedoIcon as Icon, ClaxedoIconV2 as IconV2 } from "@/ui/controls/claxedo-icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { Match, Show, Switch } from "solid-js"
import { mediaKindFromPath } from "@/ui/session-kit"

export type ReviewFileHeaderDiff = {
  file: string
  status?: string
  additions: number
  deletions: number
}

/** Header content for one file resolved from a diff corpus by path. */
export function ReviewCodeViewFileHeader(props: {
  diffs: readonly ReviewFileHeaderDiff[]
  file: string
  onViewFile?: (file: string) => void
}) {
  return (
    <Show when={props.diffs.find((entry) => entry.file === props.file)}>
      {(found) => <ReviewFileHeaderContent diff={found()} onViewFile={props.onViewFile} />}
    </Show>
  )
}

/**
 * Inner content of a changed-file header row: file icon, split path, change
 * summary, copy and open affordances. Single owner of this markup so the
 * accordion list and the CodeView document render identical headers.
 */
export function ReviewFileHeaderContent(props: {
  diff: ReviewFileHeaderDiff
  onViewFile?: (file: string) => void
}) {
  const i18n = useI18n()
  const file = () => props.diff.file
  const isAdded = () => props.diff.status === "added"
  const isDeleted = () => props.diff.status === "deleted"
  const mediaKind = () => mediaKindFromPath(file())
  const openFileLabel = () => i18n.t("ui.sessionReview.openFile")
  return (
    <div data-slot="session-review-trigger-content">
      <div data-slot="session-review-file-info">
        <FileIcon node={{ path: file(), type: "file" }} />
        <div data-slot="session-review-file-name-container">
          <Show when={file().includes("/")}>
            <span data-slot="session-review-directory">{`\u202A${getDirectory(file())}\u202C`}</span>
          </Show>
          <span data-slot="session-review-filename">{getFilename(file())}</span>
        </div>
      </div>
      <div data-slot="session-review-trigger-actions">
        <div data-slot="session-review-row-summary">
          <Switch>
            <Match when={isAdded()}>
              <div data-slot="session-review-change-group" data-type="added">
                <span data-slot="session-review-change" data-type="added">
                  {i18n.t("ui.sessionReview.change.added")}
                </span>
                <DiffChanges changes={props.diff} />
              </div>
            </Match>
            <Match when={isDeleted()}>
              <span data-slot="session-review-change" data-type="removed">
                {i18n.t("ui.sessionReview.change.removed")}
              </span>
            </Match>
            <Match when={!!mediaKind()}>
              <span data-slot="session-review-change" data-type="modified">
                {i18n.t("ui.sessionReview.change.modified")}
              </span>
            </Match>
            <Match when={true}>
              <DiffChanges changes={props.diff} />
            </Match>
          </Switch>
        </div>
        <div data-slot="session-review-row-controls">
          <Tooltip value={i18n.t("ui.message.copy")} placement="top" gutter={4}>
            <button
              data-slot="session-review-copy-button"
              type="button"
              aria-label={i18n.t("ui.message.copy")}
              onClick={(event) => {
                event.stopPropagation()
                void navigator.clipboard?.writeText(file())
              }}
            >
              <Icon name="copy" size="small" />
            </button>
          </Tooltip>
          <span data-slot="session-review-diff-chevron" aria-hidden="true">
            <IconV2 name="chevron-down" size="small" />
          </span>
          <Show when={props.onViewFile}>
            <Tooltip value={openFileLabel()} placement="top" gutter={4}>
              <button
                data-slot="session-review-view-button"
                type="button"
                aria-label={openFileLabel()}
                onClick={(event) => {
                  event.stopPropagation()
                  props.onViewFile?.(file())
                }}
              >
                <Icon name="open-file" size="small" />
              </button>
            </Tooltip>
          </Show>
        </div>
      </div>
    </div>
  )
}
