import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { ClaxedoIcon as Icon, ClaxedoIconV2 as IconV2 } from "@/ui/controls/claxedo-icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { getDirectory, getFilename } from "@opencode-ai/ui/utils/path"
import { Match, Show, Switch } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import type { AgentFileContent } from "@claxedo/agent-runtime-contract"
import { FileMedia, mediaKindFromPath } from "@/ui/session-kit"
import { MAX_DIFF_CHANGED_LINES } from "./review-session-logic"

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
  showControls?: boolean
}) {
  return (
    <Show when={props.diffs.find((entry) => entry.file === props.file)}>
      {(found) => (
        <ReviewFileHeaderContent diff={found()} onViewFile={props.onViewFile} showControls={props.showControls} />
      )}
    </Show>
  )
}

/**
 * Inner content of a changed-file header row: file icon, split path, change
 * summary, copy and open affordances.
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
   * mounted. The surface reports the one row the pointer is on or that holds
   * focus, so the two tooltips and their buttons are built for that row alone.
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
      <span data-slot="session-review-filename">{`\u202A${getFilename(file())}\u202C`}</span>
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
        <Show when={props.showControls}>
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

/**
 * The body of a review row CodeView does not render itself.
 *
 * Three rows arrive here: a media preview, a diff held behind the size guard,
 * and a file whose content the review's queue has not delivered yet. The engine
 * owns where each sits and how tall it is; this owns what they say.
 */
export function ReviewRowBody(props: {
  file: string
  /** A media preview rather than a text diff. */
  media: boolean
  /** Withheld by the large-diff guard until the reader asks for it. */
  guarded: boolean
  deleted: boolean
  /** The file's bytes, once the review's queue has read them. */
  content: AgentFileContent | undefined
  changedLines: number
  onRenderAnyway: (file: string) => void
  /** The message from this file's last failed content request, if any. */
  error: string | undefined
  onRetry: (file: string) => void
}) {
  const i18n = useI18n()
  /**
   * What a row shows while the review's content queue still owes it bytes — a
   * text diff or a media file alike, since both are requested through that one
   * queue and fail through its one error channel.
   */
  const pending = () => (
    <div class="px-3 py-4 text-12-regular text-text-weak" data-review-content-file={props.file}>
      <Show when={props.error} fallback={<div role="status">Loading diff…</div>}>
        {(error) => <>
          <div role="alert">{error()}</div>
          <button type="button" class="mt-2 underline" onClick={() => props.onRetry(props.file)}>
            Retry loading diff
          </button>
        </>}
      </Show>
    </div>
  )
  return (
    <Show when={!props.media} fallback={
      <Show when={props.deleted || props.content !== undefined} fallback={pending()}>
        {/* No `readFile`: the review's own queue fetched these bytes under its
            bound, and this row renders them. */}
        <FileMedia
          media={{ mode: "auto", path: props.file, deleted: props.deleted, current: props.content }}
          fallback={pending}
        />
      </Show>
    }>
      <Show when={!props.guarded} fallback={
        <div data-slot="session-review-large-diff">
          <div data-slot="session-review-large-diff-title">{i18n.t("ui.sessionReview.largeDiff.title")}</div>
          <div data-slot="session-review-large-diff-meta">
            {i18n.t("ui.sessionReview.largeDiff.meta", {
              limit: MAX_DIFF_CHANGED_LINES.toLocaleString(),
              current: props.changedLines.toLocaleString(),
            })}
          </div>
          <div data-slot="session-review-large-diff-actions">
            <Button size="normal" variant="secondary" onClick={() => props.onRenderAnyway(props.file)}>
              {i18n.t("ui.sessionReview.largeDiff.renderAnyway")}
            </Button>
          </div>
        </div>
      }>
        {pending()}
      </Show>
    </Show>
  )
}
