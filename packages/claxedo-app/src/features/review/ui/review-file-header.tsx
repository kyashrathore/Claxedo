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
 *
 * The row is deliberately shallow. Every element here is paid for by EVERY
 * whole-document style pass, once per materialized row, so layout that a
 * parent's flexbox can express is expressed there rather than in a wrapper:
 * the file icon, the two path spans and the actions box are direct children of
 * one flex row instead of living in nested `file-info` / `file-name-container`
 * boxes, and the change summary is one box instead of a summary wrapper around
 * a change group.
 */
export function ReviewFileHeaderContent(props: {
  diff: ReviewFileHeaderDiff
  onViewFile?: (file: string) => void
  /**
   * Whether this row's hover-only control cluster (copy / chevron / open) is
   * mounted. The cluster is `opacity: 0; pointer-events: none` until the row is
   * hovered or focused, so a list that owns hover state mounts it for the one
   * row that can show it; a caller that owns no hover state keeps them all.
   */
  showControls?: boolean
}) {
  const i18n = useI18n()
  const file = () => props.diff.file
  const isAdded = () => props.diff.status === "added"
  const isDeleted = () => props.diff.status === "deleted"
  const mediaKind = () => mediaKindFromPath(file())
  const openFileLabel = () => i18n.t("ui.sessionReview.openFile")
  return (
    <div data-slot="session-review-trigger-content">
      <FileIcon node={{ path: file(), type: "file" }} />
      <Show when={file().includes("/")}>
        <span data-slot="session-review-directory">{`\u202A${getDirectory(file())}\u202C`}</span>
      </Show>
      <span data-slot="session-review-filename">{getFilename(file())}</span>
      <div data-slot="session-review-trigger-actions">
        <div data-slot="session-review-row-summary" class="ui-session-review-row-summary">
          <Switch>
            <Match when={isAdded()}>
              <span data-slot="session-review-change" data-type="added">
                {i18n.t("ui.sessionReview.change.added")}
              </span>
              <DiffChanges changes={props.diff} />
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
        <Show when={props.showControls ?? true}>
          <div data-slot="session-review-row-controls" class="ui-session-review-row-controls">
            <Tooltip value={i18n.t("ui.message.copy")} placement="top" gutter={4}>
              <button
                data-slot="session-review-copy-button" class="ui-session-review-copy-button"
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
                  data-slot="session-review-view-button" class="ui-session-review-view-button"
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
        </Show>
      </div>
    </div>
  )
}
