import { Show, type JSX } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useTranslator } from "@/i18n"
import { ClaxedoIcon as Icon, SemanticIcon } from "@/ui"
import { dictionary } from "../i18n"

export type CommitVariant = "commit" | "commit-push" | "amend"

const MIN_ROWS = 1
const MAX_ROWS = 6

function rowsFor(message: string): number {
  return Math.min(MAX_ROWS, Math.max(MIN_ROWS, message.split("\n").length))
}

function CommitMenu(props: {
  readonly canCommit: boolean
  readonly canAmend: boolean
  readonly onCommit: (variant: CommitVariant) => void
}): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        as={Button}
        variant="secondary"
        size="small"
        data-testid="source-control-commit-menu"
        aria-label={t("review.sourceControl.commitMenu")}
        class="w-6 shrink-0 rounded-l-none px-0"
      >
        <Icon name="chevron-down" size="small" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="z-[200]">
          <DropdownMenu.Item disabled={!props.canCommit} onSelect={() => props.onCommit("commit")}>
            <SemanticIcon concept="commit" size="small" />
            {t("review.sourceControl.commit")}
          </DropdownMenu.Item>
          <DropdownMenu.Item disabled={!props.canCommit} onSelect={() => props.onCommit("commit-push")}>
            <SemanticIcon concept="push" size="small" />
            {t("review.sourceControl.commitAndPush")}
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item disabled={!props.canAmend} onSelect={() => props.onCommit("amend")}>
            <Icon name="pencil-line" size="small" />
            {t("review.sourceControl.amend")}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}

export function CommitBox(props: {
  readonly message: string
  readonly onMessage: (message: string) => void
  readonly hasMessage: boolean
  readonly hasStaged: boolean
  readonly pending: boolean
  readonly error?: string
  readonly onCommit: (variant: CommitVariant) => void
}): JSX.Element {
  const t = useTranslator(dictionary)
  const canCommit = () => props.hasMessage && props.hasStaged
  return (
    <div class="flex shrink-0 flex-col gap-2 border-b border-border-weak-base p-2">
      <textarea
        data-testid="source-control-message"
        rows={rowsFor(props.message)}
        value={props.message}
        placeholder={t("review.sourceControl.message")}
        aria-label={t("review.sourceControl.message")}
        aria-invalid={props.error ? "true" : undefined}
        class="w-full resize-none rounded-md border border-border-weak-base bg-surface-base px-2 py-1.5 text-13-regular text-text-base outline-none placeholder:text-text-weak focus:border-border-strong-base"
        onInput={(event) => props.onMessage(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return
          event.preventDefault()
          if (canCommit()) props.onCommit("commit")
        }}
      />
      <div class="flex items-center gap-px">
        <Button
          data-testid="source-control-commit"
          variant="secondary"
          size="small"
          disabled={!canCommit()}
          class="min-w-0 flex-1 rounded-r-none"
          onClick={() => props.onCommit("commit")}
        >
          <Show when={props.pending} fallback={<SemanticIcon concept="commit" size="small" />}>
            <Spinner class="size-3" />
          </Show>
          <span class="truncate">{t("review.sourceControl.commit")}</span>
        </Button>
        <CommitMenu canCommit={canCommit()} canAmend={props.hasMessage} onCommit={props.onCommit} />
      </div>
      <Show when={props.error}>
        {(error) => (
          <div data-testid="source-control-error" role="alert" class="text-11-regular text-icon-critical-base">
            {error()}
          </div>
        )}
      </Show>
    </div>
  )
}
