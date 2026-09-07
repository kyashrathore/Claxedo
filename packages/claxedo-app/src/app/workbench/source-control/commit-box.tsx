import { Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Spinner } from "@opencode-ai/ui/spinner"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { SemanticIcon } from "@/ui/semantic-icon"
import { useLanguage } from "@/platform/i18n/provider"

export type CommitVariant = "commit" | "commit-push" | "amend"

const MIN_ROWS = 1
const MAX_ROWS = 6

function rowsFor(message: string) {
  return Math.min(MAX_ROWS, Math.max(MIN_ROWS, message.split("\n").length))
}

export function CommitBox(props: {
  message: string
  onMessage: (message: string) => void
  hasMessage: boolean
  hasStaged: boolean
  pending: boolean
  error?: string
  onCommit: (variant: CommitVariant) => void
}) {
  const language = useLanguage()
  const canCommit = () => props.hasMessage && props.hasStaged
  const canAmend = () => props.hasMessage

  return (
    <div class="flex shrink-0 flex-col gap-2 border-b border-border-weak-base p-2">
      <textarea
        data-testid="source-control-message"
        rows={rowsFor(props.message)}
        value={props.message}
        placeholder={language.t("navigator.sourceControl.message.placeholder")}
        aria-label={language.t("navigator.sourceControl.message.placeholder")}
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
          <span class="truncate">{language.t("navigator.sourceControl.commit")}</span>
        </Button>
        <DropdownMenu>
          <DropdownMenu.Trigger
            as={Button}
            variant="secondary"
            size="small"
            data-testid="source-control-commit-menu"
            aria-label={language.t("navigator.sourceControl.commit.menu")}
            class="w-6 shrink-0 rounded-l-none px-0"
          >
            <Icon name="chevron-down" size="small" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content class="z-[200]">
              <DropdownMenu.Item disabled={!canCommit()} onSelect={() => props.onCommit("commit")}>
                <SemanticIcon concept="commit" size="small" />
                {language.t("navigator.sourceControl.commit")}
              </DropdownMenu.Item>
              <DropdownMenu.Item disabled={!canCommit()} onSelect={() => props.onCommit("commit-push")}>
                <SemanticIcon concept="push" size="small" />
                {language.t("navigator.sourceControl.commit.andPush")}
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item disabled={!canAmend()} onSelect={() => props.onCommit("amend")}>
                <Icon name="pencil-line" size="small" />
                {language.t("navigator.sourceControl.commit.amend")}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>
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
