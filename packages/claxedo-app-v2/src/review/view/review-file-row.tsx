import { Match, Show, Switch, type JSX } from "solid-js"
import { basename, isMediaPath, parentPath } from "@/files"
import { useTranslator } from "@/i18n"
import type { FileContent } from "@/server"
import { FileMedia } from "@/transcript"
import { ClaxedoIcon as Icon, ClaxedoIconV2 as IconV2, Button, DiffChanges, FileIcon, Tooltip } from "@/ui"
import { MAX_DIFF_CHANGED_LINES } from "../diff-content"
import { reviewDictionary } from "../i18n"

export type ReviewFileHeaderDiff = {
  readonly file: string
  readonly status?: string
  readonly additions: number
  readonly deletions: number
}

export function ReviewCodeViewFileHeader(props: {
  readonly diffs: readonly ReviewFileHeaderDiff[]
  readonly file: string
  readonly onViewFile?: (file: string) => void
  readonly showControls?: boolean
}): JSX.Element {
  return (
    <Show when={props.diffs.find((entry) => entry.file === props.file)}>
      {(found) => (
        <ReviewFileHeaderContent diff={found()} onViewFile={props.onViewFile} showControls={props.showControls} />
      )}
    </Show>
  )
}

function RowControls(props: { readonly file: string; readonly onViewFile?: (file: string) => void }): JSX.Element {
  const t = useTranslator(reviewDictionary)
  return (
    <div data-slot="session-review-row-controls" class="ui-session-review-row-controls">
      <Tooltip value={t("review.copy")} placement="top" gutter={4}>
        <button
          data-slot="session-review-copy-button"
          class="ui-session-review-copy-button"
          type="button"
          aria-label={t("review.copy")}
          onClick={(event) => {
            event.stopPropagation()
            void navigator.clipboard?.writeText(props.file)
          }}
        >
          <Icon name="copy" size="small" />
        </button>
      </Tooltip>
      <span data-slot="session-review-diff-chevron" class="ui-session-review-diff-chevron" aria-hidden="true">
        <IconV2 name="chevron-down" size="small" />
      </span>
      <Show when={props.onViewFile}>
        {(view) => (
          <Tooltip value={t("review.openFile")} placement="top" gutter={4}>
            <button
              data-slot="session-review-view-button"
              class="ui-session-review-view-button"
              type="button"
              aria-label={t("review.openFile")}
              onClick={(event) => {
                event.stopPropagation()
                view()(props.file)
              }}
            >
              <Icon name="open-file" size="small" />
            </button>
          </Tooltip>
        )}
      </Show>
    </div>
  )
}

export function ReviewFileHeaderContent(props: {
  readonly diff: ReviewFileHeaderDiff
  readonly onViewFile?: (file: string) => void
  readonly showControls?: boolean
}): JSX.Element {
  const t = useTranslator(reviewDictionary)
  const file = () => props.diff.file
  const directory = () => parentPath(file())
  return (
    <div data-slot="session-review-trigger-content">
      <FileIcon node={{ path: file(), type: "file" }} />
      <Show when={directory()}>
        <span data-slot="session-review-directory">{`‪${directory()}/‬`}</span>
      </Show>
      <span data-slot="session-review-filename">{`‪${basename(file())}‬`}</span>
      <div data-slot="session-review-trigger-actions">
        <div data-slot="session-review-row-summary" class="ui-session-review-row-summary">
          <Switch>
            <Match when={props.diff.status === "added"}>
              <span data-slot="session-review-change" data-type="added">
                {t("review.change.added")}
              </span>
              <DiffChanges changes={props.diff} />
            </Match>
            <Match when={props.diff.status === "deleted"}>
              <span data-slot="session-review-change" data-type="removed">
                {t("review.change.removed")}
              </span>
            </Match>
            <Match when={isMediaPath(file())}>
              <span data-slot="session-review-change" data-type="modified">
                {t("review.change.modified")}
              </span>
            </Match>
            <Match when={true}>
              <DiffChanges changes={props.diff} />
            </Match>
          </Switch>
        </div>
        <Show when={props.showControls}>
          <RowControls file={file()} onViewFile={props.onViewFile} />
        </Show>
      </div>
    </div>
  )
}

function PendingBody(props: {
  readonly file: string
  readonly error: string | undefined
  readonly onRetry: (file: string) => void
}): JSX.Element {
  const t = useTranslator(reviewDictionary)
  return (
    <div class="px-3 py-4 text-12-regular text-text-weak" data-review-content-file={props.file}>
      <Show when={props.error} fallback={<div role="status">{t("review.diff.loading")}</div>}>
        {(error) => (
          <>
            <div role="alert">{error()}</div>
            <button type="button" class="mt-2 underline" onClick={() => props.onRetry(props.file)}>
              {t("review.diff.retry")}
            </button>
          </>
        )}
      </Show>
    </div>
  )
}

function LargeDiff(props: {
  readonly file: string
  readonly changedLines: number
  readonly onRenderAnyway: (file: string) => void
}): JSX.Element {
  const t = useTranslator(reviewDictionary)
  return (
    <div data-slot="session-review-large-diff">
      <div data-slot="session-review-large-diff-title">{t("review.largeDiff.title")}</div>
      <div data-slot="session-review-large-diff-meta">
        {t("review.largeDiff.meta", {
          limit: MAX_DIFF_CHANGED_LINES.toLocaleString(),
          current: props.changedLines.toLocaleString(),
        })}
      </div>
      <div data-slot="session-review-large-diff-actions">
        <Button size="normal" variant="secondary" onClick={() => props.onRenderAnyway(props.file)}>
          {t("review.largeDiff.renderAnyway")}
        </Button>
      </div>
    </div>
  )
}

export function ReviewRowBody(props: {
  readonly file: string
  readonly media: boolean
  readonly guarded: boolean
  readonly deleted: boolean
  readonly content: FileContent | undefined
  readonly changedLines: number
  readonly onRenderAnyway: (file: string) => void
  readonly error: string | undefined
  readonly onRetry: (file: string) => void
}): JSX.Element {
  const pending = () => <PendingBody file={props.file} error={props.error} onRetry={props.onRetry} />
  return (
    <Show
      when={!props.media}
      fallback={
        <Show when={props.deleted || props.content !== undefined} fallback={pending()}>
          <FileMedia
            media={{ mode: "auto", path: props.file, deleted: props.deleted, current: props.content }}
            fallback={pending}
          />
        </Show>
      }
    >
      <Show
        when={!props.guarded}
        fallback={
          <LargeDiff file={props.file} changedLines={props.changedLines} onRenderAnyway={props.onRenderAnyway} />
        }
      >
        {pending()}
      </Show>
    </Show>
  )
}
